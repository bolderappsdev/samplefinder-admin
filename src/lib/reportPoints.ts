// Pure, dependency-free helpers for the "Points Earned (Date Range)" report.
//
// Kept free of Appwrite/Vite imports so the aggregation can be unit-tested in
// isolation (see scripts/verify-points-earned.mjs).
//
// Background: a user's `user_profiles.totalPoints` is a *lifetime* running total
// that mixes in sources with no dated record (referral / signup / badge / birthday
// bonuses), so it cannot be attributed to a time window. To rank a "winner of the
// month" we instead sum the point-earning events that DO have a `$createdAt`:
//   - check-ins      -> checkins.points
//   - reviews        -> reviews.pointsEarned
//   - trivia wins    -> trivia.points (when the answer matches the correct option)

/** Per-user breakdown of points (and activity counts) earned within a date range. */
export interface PointsEarnedBreakdown {
  checkInPoints: number
  reviewPoints: number
  triviaPoints: number
  checkInCount: number
  reviewCount: number
  triviaWins: number
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
    checkInCount: 0,
    reviewCount: 0,
    triviaWins: 0,
  }
}

/** Total points earned in range = check-in + review + trivia points. */
export function breakdownTotalPoints(b: PointsEarnedBreakdown): number {
  return b.checkInPoints + b.reviewPoints + b.triviaPoints
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
 *
 * Users with no qualifying activity are simply absent from the returned map.
 */
export function aggregatePointsEarnedInRange(input: {
  checkins: { user?: Relation; points?: number | string }[]
  reviews: { user?: Relation; pointsEarned?: number | string }[]
  triviaResponses: { user?: Relation; trivia?: Relation; answerIndex?: number | string }[]
  triviaById: Map<string, TriviaPointInfo>
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

  return byUser
}
