// Pure, dependency-free helpers for the "Points Earned (Date Range)" report.
//
// Kept free of Appwrite/Vite imports so the aggregation can be unit-tested in
// isolation (see scripts/verify-points-earned.mjs).
//
// Background: a user's `user_profiles.totalPoints` is a *lifetime* running total. To
// attribute points to a time window (e.g. "winner of the month") we sum the point-earning
// events that can be dated:
//   - check-ins      -> checkins.points              (dated by checkins.$createdAt)
//   - reviews        -> reviews.pointsEarned          (dated by reviews.$createdAt)
//   - trivia wins    -> trivia.points                 (when the answer matches the correct option)
//   - signup bonus   -> SIGNUP_BONUS_POINTS           (dated by the user's $createdAt)
//   - referee bonus  -> referee points from Settings  (dated by the INVITEE's $createdAt; only when
//                       the user signed up with a referral code, i.e. usedReferralCode is set)
//   - referrer bonus -> referrer points from Settings (dated by the INVITEE's $createdAt, credited
//                       to whoever owns the referral code the invitee used)
// Signup and referral bonuses have no dated transaction record of their own, so they are attributed
// to the invitee's account-creation date — the moment all three are granted in the signup flow.
//
// Still NOT attributable to a window (no dated record and no usable proxy):
//   - birthday bonus            (Notification functions: checkAndSendBirthdayNotifications)
//   - sampling-anniversary bonus(Notification functions: checkAndSendAnniversaryNotifications)
//   - special BA/Influencer badge (samplefinder-app/src/lib/specialBadgeAwards.ts, 100 pts)
//   - any manual edit of User Points in the admin panel
// Those are why a user's lifetime totalPoints can exceed everything this module can attribute.
// `unattributedPoints()` below quantifies that residue so a report can show it instead of leaving
// the reader to wonder why lifetime and in-range totals disagree.

/**
 * Flat welcome bonus granted at account creation. Mirrors the signup path in the admin
 * "Mobile API" function (createUser: `totalPoints` defaults to 100) and the mobile app's own
 * signup. There is no Settings entry for it and no dated transaction record, so the report
 * attributes it to the user's `$createdAt`.
 */
export const SIGNUP_BONUS_POINTS = 100

/**
 * `$createdAt` window test, applied in memory.
 *
 * Keeps exactly the semantics the report's server-side queries used before the aggregation moved to
 * a single unfiltered fetch: `start` inclusive as given, `end` extended to 23:59:59.999 of that
 * local day, and an absent bound meaning "unbounded on that side". No bounds at all => all-time.
 *
 * Compares epoch milliseconds, never ISO strings: Appwrite returns `$createdAt` with a `+00:00`
 * offset while `Date.toISOString()` emits `Z`, so a lexicographic compare of the two is wrong even
 * though both are UTC. A record with a missing or unparseable timestamp cannot be placed in a window,
 * so it is excluded rather than silently counted.
 */
export function createdAtRangeFilter(
  dateRange?: { start: Date | null; end: Date | null }
): (createdAt?: string) => boolean {
  const minMs = dateRange?.start ? dateRange.start.getTime() : null
  let maxMs: number | null = null
  if (dateRange?.end) {
    const endDate = new Date(dateRange.end)
    endDate.setHours(23, 59, 59, 999)
    maxMs = endDate.getTime()
  }
  if (minMs == null && maxMs == null) return () => true
  return (createdAt) => {
    if (!createdAt) return false
    const t = Date.parse(createdAt)
    if (!Number.isFinite(t)) return false
    return (minMs == null || t >= minMs) && (maxMs == null || t <= maxMs)
  }
}

/** Per-user breakdown of points (and activity counts) earned within a date range. */
export interface PointsEarnedBreakdown {
  checkInPoints: number
  reviewPoints: number
  triviaPoints: number
  /** Welcome bonus (SIGNUP_BONUS_POINTS) when the user's account was created in range. */
  signupPoints: number
  /** Referee referral bonus when the user signed up with a referral code in range. */
  referralPoints: number
  /** Referrer referral bonus — one award per invitee who signed up in range using this user's code. */
  referrerPoints: number
  checkInCount: number
  reviewCount: number
  triviaWins: number
  /** Invitees who signed up in range using this user's referral code (drives referrerPoints). */
  referralsMade: number
}

/** The two fields needed from a trivia doc to score a response. */
export interface TriviaPointInfo {
  correctOptionIndex: number
  points: number
}

type Relation = string | { $id?: string } | null | undefined

/** Extract a related document id whether Appwrite returned an id string or a nested object. */
export function relationToId(value: Relation): string | undefined {
  if (value == null) return undefined
  return typeof value === 'string' ? value : value.$id
}

export function emptyPointsBreakdown(): PointsEarnedBreakdown {
  return {
    checkInPoints: 0,
    reviewPoints: 0,
    triviaPoints: 0,
    signupPoints: 0,
    referralPoints: 0,
    referrerPoints: 0,
    checkInCount: 0,
    reviewCount: 0,
    triviaWins: 0,
    referralsMade: 0,
  }
}

/**
 * Total points earned in range = check-in + review + trivia + signup + referee + referrer points.
 *
 * Every point-bearing field of the breakdown must appear here: a source that contributes to the
 * total without its own column (or a column that never reaches the total) is the exact class of
 * bug the report-reconciliation assertions in scripts/verify-points-earned.mjs guard against.
 */
export function breakdownTotalPoints(b: PointsEarnedBreakdown): number {
  return (
    b.checkInPoints +
    b.reviewPoints +
    b.triviaPoints +
    b.signupPoints +
    b.referralPoints +
    b.referrerPoints
  )
}

/**
 * Points on a user's lifetime `totalPoints` that no dated source accounts for, given the
 * all-time (unwindowed) breakdown for that user.
 *
 * Positive: awards this module cannot date — birthday / anniversary / special-badge bonuses, or a
 * manual admin edit of User Points. Expected to be non-zero for some users; it is the honest
 * answer to "why is lifetime 410 when the range report says 310?".
 *
 * Negative: the report is crediting MORE than the user ever banked, which means recomputed config
 * has drifted from what was actually awarded — e.g. the referral Settings value or a trivia's
 * `points`/`correctOptionIndex` was edited after the fact, so past awards are being re-priced at
 * today's rate. Surfacing the sign makes that drift visible instead of silent.
 */
export function unattributedPoints(
  lifetimeTotalPoints: number,
  allTime: PointsEarnedBreakdown
): number {
  return toNum(lifetimeTotalPoints) - breakdownTotalPoints(allTime)
}

/** Check-in + review points only (the "Check-in/Review Pts" column). */
export function breakdownCheckInReviewPoints(b: PointsEarnedBreakdown): number {
  return b.checkInPoints + b.reviewPoints
}

const toNum = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * Aggregate per-user points + counts from the dated records that fall within a date range.
 *
 * The caller is responsible for passing only in-range records (filtered by `$createdAt`
 * at query time). This function performs no date filtering itself — it is a pure reducer.
 *
 * - check-ins:  + checkins.points,           checkInCount += 1
 * - reviews:    + reviews.pointsEarned,       reviewCount  += 1
 * - trivia:     + trivia.points and triviaWins += 1, only when the response's answerIndex
 *               matches the linked trivia's correctOptionIndex (unknown/deleted trivia skipped)
 * - signups:    + signupBonus to signupPoints; + refereePts to referralPoints when the user's
 *               usedReferralCode is set. The caller must pass only users whose $createdAt is in
 *               range; this function does no date filtering.
 * - referrals:  for each in-range signup that used a code, + referrerPts to the referralPoints'
 *               counterpart on the code's OWNER (referrerIdByCode), and referralsMade += 1. The
 *               referrer is usually an older account, so this is the one contribution credited to
 *               a user who may have had no in-range activity of their own — omitting it made
 *               heavy referrers (large lifetime totals, no check-ins or reviews) score ~0 in
 *               every window.
 *
 * Users with no qualifying activity (no in-range record, signup, or referral) are absent.
 */
export function aggregatePointsEarnedInRange(input: {
  checkins: { user?: Relation; points?: number | string }[]
  reviews: { user?: Relation; pointsEarned?: number | string }[]
  triviaResponses: { user?: Relation; trivia?: Relation; answerIndex?: number | string }[]
  triviaById: Map<string, TriviaPointInfo>
  /**
   * Users whose account was created within the date range (caller filters by `$createdAt`).
   * Each contributes `signupBonus`; those with a non-empty `usedReferralCode` also get `refereePts`
   * for themselves and `referrerPts` for the owner of that code.
   */
  signups?: { user?: Relation; usedReferralCode?: string | null }[]
  signupBonus?: number
  refereePts?: number
  /** referralCode -> owning user id, built from the WHOLE roster (referrers predate the window). */
  referrerIdByCode?: Map<string, string>
  referrerPts?: number
}): Map<string, PointsEarnedBreakdown> {
  const byUser = new Map<string, PointsEarnedBreakdown>()
  const ensure = (userId: string): PointsEarnedBreakdown => {
    let b = byUser.get(userId)
    if (!b) {
      b = emptyPointsBreakdown()
      byUser.set(userId, b)
    }
    return b
  }

  for (const c of input.checkins) {
    const userId = relationToId(c.user)
    if (!userId) continue
    const b = ensure(userId)
    b.checkInPoints += toNum(c.points)
    b.checkInCount += 1
  }

  for (const r of input.reviews) {
    const userId = relationToId(r.user)
    if (!userId) continue
    const b = ensure(userId)
    b.reviewPoints += toNum(r.pointsEarned)
    b.reviewCount += 1
  }

  for (const resp of input.triviaResponses) {
    const userId = relationToId(resp.user)
    const triviaId = relationToId(resp.trivia)
    if (!userId || !triviaId) continue
    const trivia = input.triviaById.get(triviaId)
    if (!trivia) continue
    if (toNum(resp.answerIndex) !== toNum(trivia.correctOptionIndex)) continue
    const b = ensure(userId)
    b.triviaPoints += toNum(trivia.points)
    b.triviaWins += 1
  }

  const signupBonus = toNum(input.signupBonus)
  const refereePts = toNum(input.refereePts)
  const referrerPts = toNum(input.referrerPts)
  for (const s of input.signups ?? []) {
    const userId = relationToId(s.user)
    if (!userId) continue
    const b = ensure(userId)
    b.signupPoints += signupBonus
    const code = typeof s.usedReferralCode === 'string' ? s.usedReferralCode.trim() : ''
    if (!code) continue
    b.referralPoints += refereePts

    // Credit the other side of the same referral. Self-referral is rejected by the Mobile API
    // (processReferral bails when referrer === invitee), so mirror that here rather than paying
    // a user for inviting themselves.
    const referrerId = input.referrerIdByCode?.get(code)
    if (!referrerId || referrerId === userId) continue
    const r = ensure(referrerId)
    r.referrerPoints += referrerPts
    r.referralsMade += 1
  }

  return byUser
}
