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

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll points-aggregation assertions passed')
