// One-off verification for the pure points aggregation used by the
// "Points Earned (Date Range)" report.
//
// Run with:
//   npx tsc src/lib/reportPoints.ts --outDir scripts/.ptcheck --target es2020 --module es2020
//   node scripts/verify-points-earned.mjs
//
// Exits non-zero on any failed assertion.

import {
  aggregatePointsEarnedInRange,
  breakdownTotalPoints,
  breakdownCheckInReviewPoints,
  createdAtRangeFilter,
  emptyPointsBreakdown,
  SIGNUP_BONUS_POINTS,
  unattributedPoints,
} from './.ptcheck/reportPoints.js'

let failures = 0
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.error(`FAIL ${label}: expected ${e}, got ${a}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

// Report reconciliation invariant: the "Points Earned (Date Range)" total column must equal
// the sum of its per-action point columns (check-in + review + trivia). A trivia win that
// added points to the total but had no matching column is exactly the bug this guards against.
const reconciles = (label, b) =>
  eq(`${label}: total == checkIn+review+trivia+signup+referee+referrer points`,
    breakdownTotalPoints(b),
    b.checkInPoints + b.reviewPoints + b.triviaPoints + b.signupPoints + b.referralPoints + b.referrerPoints)

// Guards the same invariant from the other side: every point-bearing field must be *needed* by the
// total. Zeroing one has to move breakdownTotalPoints, otherwise that source is silently dropped —
// which is how the referrer's half of a referral went unreported for every window.
const POINT_FIELDS = [
  'checkInPoints',
  'reviewPoints',
  'triviaPoints',
  'signupPoints',
  'referralPoints',
  'referrerPoints',
]
const everyPointFieldReachesTotal = (label, b) => {
  for (const field of POINT_FIELDS) {
    if (b[field] === 0) continue
    const without = { ...b, [field]: 0 }
    eq(`${label}: zeroing ${field} changes the total (field is not dropped)`,
      breakdownTotalPoints(b) - breakdownTotalPoints(without),
      b[field])
  }
}

const triviaById = new Map([
  ['triviaA', { correctOptionIndex: 2, points: 30 }],
  ['triviaB', { correctOptionIndex: 0, points: 50 }],
])

// --- Case 1: mixed activity for one user (relation as id string) ---
const r1 = aggregatePointsEarnedInRange({
  checkins: [
    { user: 'u1', points: 10 },
    { user: 'u1', points: 5 },
  ],
  reviews: [{ user: 'u1', pointsEarned: 20 }],
  triviaResponses: [
    { user: 'u1', trivia: 'triviaA', answerIndex: 2 }, // correct -> +30
    { user: 'u1', trivia: 'triviaB', answerIndex: 3 }, // wrong   -> +0
  ],
  triviaById,
})
const u1 = r1.get('u1')
eq('u1 checkInPoints', u1.checkInPoints, 15)
eq('u1 reviewPoints', u1.reviewPoints, 20)
eq('u1 triviaPoints', u1.triviaPoints, 30)
eq('u1 checkInCount', u1.checkInCount, 2)
eq('u1 reviewCount', u1.reviewCount, 1)
eq('u1 triviaWins', u1.triviaWins, 1)
eq('u1 total points', breakdownTotalPoints(u1), 65)
eq('u1 checkin/review points', breakdownCheckInReviewPoints(u1), 35)
reconciles('u1', u1)

// --- Case 2: relations as nested objects ({$id}) + string-typed numbers from Appwrite ---
const r2 = aggregatePointsEarnedInRange({
  checkins: [{ user: { $id: 'u2' }, points: '8' }],
  reviews: [],
  triviaResponses: [
    { user: { $id: 'u2' }, trivia: { $id: 'triviaB' }, answerIndex: '0' }, // correct -> +50
  ],
  triviaById,
})
const u2 = r2.get('u2')
eq('u2 total (string coercion + nested relations)', breakdownTotalPoints(u2), 58)
eq('u2 triviaWins', u2.triviaWins, 1)

// --- Case 3: a user with only a wrong trivia answer is absent from the map ---
const r3 = aggregatePointsEarnedInRange({
  checkins: [],
  reviews: [],
  triviaResponses: [{ user: 'u3', trivia: 'triviaA', answerIndex: 1 }], // wrong
  triviaById,
})
eq('u3 absent (only wrong answer)', r3.has('u3'), false)

// --- Case 4: unknown/deleted trivia is skipped, missing user id is skipped ---
const r4 = aggregatePointsEarnedInRange({
  checkins: [{ user: undefined, points: 99 }], // no user -> skipped
  reviews: [],
  triviaResponses: [{ user: 'u4', trivia: 'ghost', answerIndex: 0 }], // unknown trivia -> skipped
  triviaById,
})
eq('u4 absent (unknown trivia)', r4.has('u4'), false)
eq('no phantom users from null relations', r4.size, 0)

// --- Case 5: empty input -> empty map ---
const r5 = aggregatePointsEarnedInRange({
  checkins: [],
  reviews: [],
  triviaResponses: [],
  triviaById,
})
eq('empty input -> empty map', r5.size, 0)

// --- Case 6: regression for the reported discrepancy (SAM "Points Earned" report) ---
// "heather444" row: 1 check-in + 1 review (=> 60 check-in/review pts) and 1 trivia win (=> 10).
// The total was 70 but the only points column shown summed to 60; the missing 10 was the
// trivia points, which now has its own column. Assert the per-action points reconcile.
const heather = aggregatePointsEarnedInRange({
  checkins: [{ user: 'heather', points: 10 }],
  reviews: [{ user: 'heather', pointsEarned: 50 }],
  triviaResponses: [{ user: 'heather', trivia: 'triviaA', answerIndex: 2 }], // correct -> +30
  triviaById,
}).get('heather')
eq('heather check-in/review pts', breakdownCheckInReviewPoints(heather), 60)
eq('heather trivia pts (was hidden, now its own column)', heather.triviaPoints, 30)
eq('heather missing amount == trivia pts', breakdownTotalPoints(heather) - breakdownCheckInReviewPoints(heather), heather.triviaPoints)
reconciles('heather', heather)

// "RagnaRock4379" row: only trivia wins (2), zero check-in/review activity. Total was 20 with
// the check-in/review column showing 0 — irreconcilable until trivia points are surfaced.
const ragna = aggregatePointsEarnedInRange({
  checkins: [],
  reviews: [],
  triviaResponses: [
    { user: 'ragna', trivia: 'triviaB', answerIndex: 0 }, // correct -> +50
    { user: 'ragna', trivia: 'triviaA', answerIndex: 2 }, // correct -> +30
  ],
  triviaById,
}).get('ragna')
eq('ragna check-in points', ragna.checkInPoints, 0)
eq('ragna review points', ragna.reviewPoints, 0)
eq('ragna trivia wins', ragna.triviaWins, 2)
eq('ragna trivia points carry the whole total', ragna.triviaPoints, breakdownTotalPoints(ragna))
reconciles('ragna', ragna)

// --- Case 7: signup + referee-referral points attributed to in-range signups ---
// A user who signed up in range with a referral code earns the welcome bonus AND the referee
// bonus; both join the total and must reconcile with the new per-action columns. Signups with no
// code (empty or undefined) get the welcome bonus only.
const refereePts = 100
const signupRes = aggregatePointsEarnedInRange({
  checkins: [{ user: 'newbie', points: 10 }], // newbie also did 1 check-in in range
  reviews: [],
  triviaResponses: [],
  triviaById,
  signups: [
    { user: 'newbie', usedReferralCode: 'FRIEND123' }, // signup + referral
    { user: 'organic', usedReferralCode: '' },         // signup only (empty code)
    { user: 'organic2' },                              // signup only (code undefined)
  ],
  signupBonus: SIGNUP_BONUS_POINTS,
  refereePts,
})
const newbie = signupRes.get('newbie')
eq('newbie signup points', newbie.signupPoints, SIGNUP_BONUS_POINTS)
eq('newbie referral points (used a code)', newbie.referralPoints, refereePts)
eq('newbie total = checkin + signup + referral', breakdownTotalPoints(newbie), 10 + SIGNUP_BONUS_POINTS + refereePts)
reconciles('newbie', newbie)

const organic = signupRes.get('organic')
eq('organic signup points', organic.signupPoints, SIGNUP_BONUS_POINTS)
eq('organic referral points (empty code -> 0)', organic.referralPoints, 0)
reconciles('organic', organic)

const organic2 = signupRes.get('organic2')
eq('organic2 signup points', organic2.signupPoints, SIGNUP_BONUS_POINTS)
eq('organic2 referral points (undefined code -> 0)', organic2.referralPoints, 0)

// --- Case 8: omitting signups keeps signup/referral at 0 (back-compat with existing callers) ---
const noSignups = aggregatePointsEarnedInRange({
  checkins: [{ user: 'x', points: 5 }],
  reviews: [],
  triviaResponses: [],
  triviaById,
}).get('x')
eq('no signups -> signupPoints 0', noSignups.signupPoints, 0)
eq('no signups -> referralPoints 0', noSignups.referralPoints, 0)
eq('no signups -> referrerPoints 0', noSignups.referrerPoints, 0)
eq('no signups -> total unchanged', breakdownTotalPoints(noSignups), 5)
reconciles('x', noSignups)

// --- Case 9: the REFERRER's half of a referral (client-reported) ---
// Kelsey Cooper: 1130 lifetime points, signed up 07/02, zero check-in/review points, and absent
// from every date-range ranking. Her points came from inviting people — an award the Mobile API
// pays to the code's OWNER (processReferral: totalPoints += referrerPts) but that no report counted.
// The referrer is normally an OLDER account with no in-range activity of its own, so the bonus has
// to be able to create a row for a user who appears nowhere else in the window.
const REFEREE_PTS = 200
const REFERRER_PTS = 300
const referrerIdByCode = new Map([
  ['KELSEY10', 'kelsey'],
  ['SOLO', 'selfref'],
])
const refRes = aggregatePointsEarnedInRange({
  checkins: [],
  reviews: [],
  triviaResponses: [],
  triviaById,
  signups: [
    { user: 'invitee1', usedReferralCode: 'KELSEY10' },
    { user: 'invitee2', usedReferralCode: 'KELSEY10' },
    { user: 'invitee3', usedReferralCode: 'UNKNOWNCODE' }, // code owner not on the roster
    { user: 'selfref', usedReferralCode: 'SOLO' },         // own code -> referrer half rejected
  ],
  signupBonus: SIGNUP_BONUS_POINTS,
  refereePts: REFEREE_PTS,
  referrerIdByCode,
  referrerPts: REFERRER_PTS,
})

const kelsey = refRes.get('kelsey')
eq('kelsey has a row despite zero activity of her own', kelsey !== undefined, true)
eq('kelsey referrerPoints = 2 invitees x referrerPts', kelsey.referrerPoints, 2 * REFERRER_PTS)
eq('kelsey referralsMade', kelsey.referralsMade, 2)
eq('kelsey earned nothing else', kelsey.checkInPoints + kelsey.reviewPoints + kelsey.triviaPoints + kelsey.signupPoints + kelsey.referralPoints, 0)
eq('kelsey total is the referrer bonus', breakdownTotalPoints(kelsey), 2 * REFERRER_PTS)
reconciles('kelsey', kelsey)
everyPointFieldReachesTotal('kelsey', kelsey)

// The invitee still gets exactly what they got before — signup + referee bonus, no referrer bonus.
const invitee1 = refRes.get('invitee1')
eq('invitee1 signup + referee only', breakdownTotalPoints(invitee1), SIGNUP_BONUS_POINTS + REFEREE_PTS)
eq('invitee1 referrerPoints 0', invitee1.referrerPoints, 0)
eq('invitee1 referralsMade 0', invitee1.referralsMade, 0)
reconciles('invitee1', invitee1)

// An unresolvable code must not invent a row, and must not silently pay the invitee twice.
eq('unknown code creates no referrer row', refRes.has('UNKNOWNCODE'), false)
eq('invitee3 still gets signup + referee', breakdownTotalPoints(refRes.get('invitee3')), SIGNUP_BONUS_POINTS + REFEREE_PTS)

// Self-referral: the Mobile API rejects it, so the report must not pay the referrer half either.
const selfref = refRes.get('selfref')
eq('self-referral pays no referrer bonus', selfref.referrerPoints, 0)
eq('self-referral referralsMade 0', selfref.referralsMade, 0)
eq('self-referral total = signup + referee only', breakdownTotalPoints(selfref), SIGNUP_BONUS_POINTS + REFEREE_PTS)

// referrerIdByCode present but referrerPts omitted -> counts the referral, pays 0. Keeps a missing
// Settings doc from inventing points.
const noPts = aggregatePointsEarnedInRange({
  checkins: [],
  reviews: [],
  triviaResponses: [],
  triviaById,
  signups: [{ user: 'invitee1', usedReferralCode: 'KELSEY10' }],
  signupBonus: SIGNUP_BONUS_POINTS,
  referrerIdByCode,
}).get('kelsey')
eq('missing referrerPts -> 0 points but referral still counted', [noPts.referrerPoints, noPts.referralsMade], [0, 1])

// --- Case 10: unattributedPoints reconciles lifetime against everything datable ---
// This is the column that answers the client's "how is it 310 here and 410 there?". Evan's shape:
// signed up in range with a code and won one trivia (310 attributable) but carries 410 lifetime.
const evan = aggregatePointsEarnedInRange({
  checkins: [],
  reviews: [],
  triviaResponses: [{ user: 'evan', trivia: 'triviaA', answerIndex: 2 }], // correct -> +30
  triviaById,
  signups: [{ user: 'evan', usedReferralCode: 'KELSEY10' }],
  signupBonus: SIGNUP_BONUS_POINTS,
  refereePts: 180,
  referrerIdByCode: new Map(),
  referrerPts: REFERRER_PTS,
}).get('evan')
eq('evan attributable total', breakdownTotalPoints(evan), 310)
eq('evan unattributed = lifetime - attributable', unattributedPoints(410, evan), 100)
eq('unattributed is 0 when lifetime matches', unattributedPoints(310, evan), 0)
eq('unattributed goes NEGATIVE when config was re-priced above what was banked', unattributedPoints(210, evan), -100)
eq('unattributed of an inactive user is their whole lifetime total', unattributedPoints(600, emptyPointsBreakdown()), 600)
eq('unattributed coerces a missing lifetime value to 0', unattributedPoints(undefined, evan), -310)

// --- Case 11: createdAtRangeFilter — the in-memory window, replacing the server-side queries ---
// Every caller normalizes via getEffectiveDateRange first (start floored to 00:00:00.000, end set to
// 23:59:59.999), which is what these ranges reproduce. If this predicate is wrong, every date-range
// report is wrong, so pin the boundaries explicitly.
const july = createdAtRangeFilter({
  start: new Date(2026, 6, 1, 0, 0, 0, 0),    // Jul 1 2026 00:00:00.000 local
  end: new Date(2026, 6, 31, 23, 59, 59, 999) // Jul 31 2026 23:59:59.999 local
})
const localIso = (y, m, d, h = 0, min = 0, s = 0, ms = 0) =>
  new Date(y, m, d, h, min, s, ms).toISOString()

eq('July window: Jul 2 is in', july(localIso(2026, 6, 2, 13, 45)), true)
eq('July window: first instant of Jul 1 is in (inclusive start)', july(localIso(2026, 6, 1, 0, 0, 0, 0)), true)
eq('July window: last instant of Jul 31 is in (inclusive end)', july(localIso(2026, 6, 31, 23, 59, 59, 999)), true)
eq('July window: 23:30 on the final day is in (the classic lost-last-day bug)', july(localIso(2026, 6, 31, 23, 30)), true)
eq('July window: Jun 30 23:59:59.999 is out', july(localIso(2026, 5, 30, 23, 59, 59, 999)), false)
eq('July window: Aug 1 00:00 is out', july(localIso(2026, 7, 1, 0, 0, 0, 0)), false)

// Appwrite returns "+00:00"-offset timestamps; toISOString() emits "Z". Both must behave the same,
// which is why the predicate compares epoch ms instead of strings.
const jul2Z = new Date(Date.UTC(2026, 6, 2, 12, 0, 0)).toISOString()
eq('Z and +00:00 spellings of one instant agree', july(jul2Z), july(jul2Z.replace('Z', '+00:00')))
eq('a "+00:00" timestamp inside the window is in', july(jul2Z.replace('Z', '+00:00')), true)

// Open-ended and absent bounds.
const fromMay = createdAtRangeFilter({ start: new Date(2026, 4, 1, 0, 0, 0, 0), end: null })
eq('start-only: May 1 in', fromMay(localIso(2026, 4, 1)), true)
eq('start-only: Apr 30 out', fromMay(localIso(2026, 3, 30, 23, 59)), false)
eq('start-only: far future in (no upper bound)', fromMay(localIso(2030, 0, 1)), true)

const untilJune = createdAtRangeFilter({ start: null, end: new Date(2026, 5, 30) })
eq('end-only: Jun 30 late in the day is in', untilJune(localIso(2026, 5, 30, 22, 0)), true)
eq('end-only: Jul 1 out', untilJune(localIso(2026, 6, 1)), false)
eq('end-only: ancient record in (no lower bound)', untilJune(localIso(2020, 0, 1)), true)

// All-time: no bounds means no filtering at all. It must include records a window cannot place —
// otherwise the all-time pass would under-count and inflate every Unattributed Points figure.
const allTime = createdAtRangeFilter(undefined)
eq('all-time: dated record in', allTime(localIso(2026, 6, 2)), true)
eq('all-time: undefined timestamp still counted', allTime(undefined), true)
eq('all-time: unparseable timestamp still counted', allTime('not-a-date'), true)
eq('all-time from an empty range object', createdAtRangeFilter({ start: null, end: null })(localIso(2026, 6, 2)), true)

// A bounded window, by contrast, cannot place an undateable record.
eq('bounded window excludes a missing timestamp', july(undefined), false)
eq('bounded window excludes an empty timestamp', july(''), false)
eq('bounded window excludes an unparseable timestamp', july('not-a-date'), false)

// --- Case 12: the client-reported scenario, end to end at row level ---
// Reproduces the shapes from the screen recording of 07/01/2026-07/31/2026 and asserts the ranking
// the report produces. Builds rows the same way generatePointsEarnedReport does: in-range window for
// the total, all-time window for Unattributed.
//
// Reported symptoms being pinned:
//   - Kelsey Cooper: 1130 lifetime, joined 07/02, zero check-in/review points, never in the ranking.
//   - Evan/Jessica/Renee: 310 in the range report vs 410 in the "All" report, gap unexplained.
//   - Kassy Pierre: 600 lifetime, joined in May, invisible in every window.
const CLIENT_SIGNUP = 100
const CLIENT_REFEREE = 200
const CLIENT_REFERRER = 100

const roster = [
  // id,       lifetime, joined,       usedCode,    ownCode
  ['kelsey',   1130, '2026-07-02', null,        'KELSEY10'],
  ['evan',      410, '2026-07-05', 'KELSEY10',  'EVAN01'],
  ['jessica',   410, '2026-07-06', 'KELSEY10',  'JESS01'],
  ['renee',     410, '2026-07-07', 'KELSEY10',  'RENEE01'],
  ['chandni',   310, '2026-07-08', 'KELSEY10',  'CHAN01'],
  ['kassy',     600, '2026-05-14', null,        'KASSY01'],
  ['al',       1990, '2025-11-01', null,        'AL01'],
]
const lifetimeById = new Map(roster.map(([id, lifetime]) => [id, lifetime]))
const referrerIdByCodeClient = new Map(roster.map(([id, , , , own]) => [own, id]))

const inJuly = createdAtRangeFilter({
  start: new Date(2026, 6, 1, 0, 0, 0, 0),
  end: new Date(2026, 6, 31, 23, 59, 59, 999),
})
const signupsFor = (filter) =>
  roster
    .filter(([, , joined]) => filter(new Date(`${joined}T12:00:00Z`).toISOString()))
    .map(([id, , , usedCode]) => ({ user: id, usedReferralCode: usedCode }))

// A 10-point trivia, matching the "310" rows in the recording: 100 signup + 200 referee + 10 trivia.
const clientTrivia = new Map([...triviaById, ['triviaSmall', { correctOptionIndex: 1, points: 10 }]])

// Al's only July activity: a 40-point check-in and one trivia win. Everyone else's July points come
// from signing up, from referrals, and from the odd trivia answer.
const juneJulyRecords = {
  checkins: [{ user: 'al', points: 40, when: '2026-07-10' }],
  reviews: [],
  triviaResponses: [
    { user: 'al', trivia: 'triviaA', answerIndex: 2, when: '2026-07-11' }, // +30
    { user: 'evan', trivia: 'triviaSmall', answerIndex: 1, when: '2026-07-12' }, // +10
    { user: 'jessica', trivia: 'triviaSmall', answerIndex: 1, when: '2026-07-12' }, // +10
    { user: 'renee', trivia: 'triviaSmall', answerIndex: 1, when: '2026-07-12' }, // +10
    { user: 'chandni', trivia: 'triviaSmall', answerIndex: 1, when: '2026-07-12' }, // +10
  ],
}
const windowed = (arr, filter) =>
  arr.filter((r) => filter(new Date(`${r.when}T12:00:00Z`).toISOString()))

const runWindow = (filter, { creditReferrer }) =>
  aggregatePointsEarnedInRange({
    checkins: windowed(juneJulyRecords.checkins, filter),
    reviews: windowed(juneJulyRecords.reviews, filter),
    triviaResponses: windowed(juneJulyRecords.triviaResponses, filter),
    triviaById: clientTrivia,
    signups: signupsFor(filter),
    signupBonus: CLIENT_SIGNUP,
    refereePts: CLIENT_REFEREE,
    referrerIdByCode: creditReferrer ? referrerIdByCodeClient : undefined,
    referrerPts: creditReferrer ? CLIENT_REFERRER : 0,
  })

const buildRows = ({ creditReferrer }) => {
  const inRange = runWindow(inJuly, { creditReferrer })
  const allTime = runWindow(() => true, { creditReferrer })
  return roster
    .map(([id]) => {
      const b = inRange.get(id) ?? emptyPointsBreakdown()
      const a = allTime.get(id) ?? emptyPointsBreakdown()
      return {
        id,
        userPoints: breakdownTotalPoints(b),
        referrerPoints: b.referrerPoints,
        referralsMade: b.referralsMade,
        lifetimePoints: lifetimeById.get(id),
        unattributedPoints: unattributedPoints(lifetimeById.get(id), a),
      }
    })
    .sort((x, y) => y.userPoints - x.userPoints || x.id.localeCompare(y.id))
}

// Red step: the shipped behaviour (referrer half never credited).
const before = buildRows({ creditReferrer: false })
eq('BEFORE: Kelsey scores only her own signup, tied with the crowd', before.find((r) => r.id === 'kelsey').userPoints, CLIENT_SIGNUP)
eq('BEFORE: Kelsey is NOT the top earner despite 1130 lifetime points', before[0].id !== 'kelsey', true)
eq('BEFORE: Kelsey gets no credit for 4 invitees', before.find((r) => r.id === 'kelsey').referralsMade, 0)

// After the fix: the inviter's half is counted, so the biggest July earner is the biggest July earner.
const after = buildRows({ creditReferrer: true })
const kelseyRow = after.find((r) => r.id === 'kelsey')
eq('AFTER: Kelsey credited for 4 July invitees', kelseyRow.referralsMade, 4)
eq('AFTER: Kelsey referrer points = 4 x 100', kelseyRow.referrerPoints, 4 * CLIENT_REFERRER)
eq('AFTER: Kelsey July total = own signup + 4 referrals', kelseyRow.userPoints, CLIENT_SIGNUP + 4 * CLIENT_REFERRER)
eq('AFTER: Kelsey ranks first for July', after[0].id, 'kelsey')

eq('AFTER: Kelsey lifetime 1130 still is not fully datable — 630 has no source', kelseyRow.unattributedPoints, 1130 - (CLIENT_SIGNUP + 4 * CLIENT_REFERRER))

// The 310-vs-410 gap the client asked about now has a column that names it.
const evanRow = after.find((r) => r.id === 'evan')
eq('Evan July total is 310 (100 signup + 200 referee + 10 trivia), as in the recording', evanRow.userPoints, 310)
eq('Evan lifetime is 410', evanRow.lifetimePoints, 410)
eq('Evan Unattributed = 100, exactly the reported jump', evanRow.unattributedPoints, 100)
eq('Evan: range + unattributed accounts for the whole lifetime total', evanRow.userPoints + evanRow.unattributedPoints, evanRow.lifetimePoints)

// Kassy signed up in May with no activity: correctly 0 for July, and her 600 is fully labelled.
const kassyRow = after.find((r) => r.id === 'kassy')
eq('Kassy earns 0 in July (she was not active then)', kassyRow.userPoints, 0)
eq('Kassy lifetime 600 is surfaced next to it', kassyRow.lifetimePoints, 600)
eq('Kassy Unattributed = 500 (600 lifetime less her May signup bonus)', kassyRow.unattributedPoints, 600 - CLIENT_SIGNUP)

// Al is a long-standing account: the July window credits only his real July activity, no signup
// bonus, because his account predates the window. The all-time window does include it — which is
// exactly why Unattributed must be computed from all-time rather than from the range.
const alRow = after.find((r) => r.id === 'al')
eq('Al July total = check-in 40 + trivia 30, no signup bonus in the window', alRow.userPoints, 70)
eq('Al Unattributed = lifetime less (July activity + his 2025 signup bonus)', alRow.unattributedPoints, 1990 - (70 + CLIENT_SIGNUP))

// Nobody may be credited more than once for the same referral.
eq('total referrer points across the roster = one award per in-range invitee',
  after.reduce((s, r) => s + r.referrerPoints, 0),
  4 * CLIENT_REFERRER)

// --- Case 9: a signup with no user id is skipped (no phantom user invented) ---
const edge = aggregatePointsEarnedInRange({
  checkins: [],
  reviews: [],
  triviaResponses: [],
  triviaById,
  signups: [{ user: undefined, usedReferralCode: 'X' }],
  signupBonus: SIGNUP_BONUS_POINTS,
  refereePts: 50,
})
eq('null-user signup skipped (no phantom user)', edge.size, 0)

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll points-aggregation assertions passed')
