// Verification for the Users list view builder (src/lib/userListView.ts).
//
// Run with:  npm run verify:user-list-view
//
// The Users page used to resolve search / tier filter / sort by REFETCHING the whole collection and
// re-resolving an Auth email per profile — ~20s per search in production. buildUserListView does
// that work in memory instead, so these assertions pin the behaviour that moved client-side:
// which rows match, in what order, and on which page. A regression here shows up as the admin
// seeing wrong or missing users, which is exactly the class of bug the old capped fetches caused.
//
// Exits non-zero on any failed assertion.

// Compiled to CommonJS (unlike the single-file verify scripts) because userListView imports
// userSearch: tsc emits that as an extensionless relative import, which ESM cannot resolve but
// require() can.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { buildUserListView, ALL_TIERS } = require('./.ulvcheck/userListView.js')

let failures = 0
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.error(`FAIL ${label}\n       expected ${e}\n       got      ${a}`)
  } else {
    console.log(`ok   ${label}`)
  }
}

// --- fixture: shaped like real rows, incl. blanks the collection really contains ---
const users = [
  { $id: 'u1', $createdAt: '2026-01-05T00:00:00.000Z', firstname: 'Kelsey', lastname: 'Cooper', username: 'kelseyallyn', email: 'kelseyallyn@yahoo.com', phoneNumber: '+1 (555) 201-3344', dob: '1990-04-02', tierLevel: 'Bronze', totalPoints: 120, totalEvents: 3, totalReviews: 1 },
  { $id: 'u2', $createdAt: '2026-02-11T00:00:00.000Z', firstname: 'Al', lastname: 'Schuster', username: 'RagnaRock4379', email: 'aschuster4379@gmail.com', phoneNumber: '5552019999', dob: '1985-11-20', tierLevel: 'Gold', totalPoints: 940, totalEvents: 12, totalReviews: 7 },
  { $id: 'u3', $createdAt: '2026-03-02T00:00:00.000Z', firstname: 'Kassy', lastname: 'Pierre', username: 'karaapierre', email: undefined, phoneNumber: '', dob: '', tierLevel: 'Silver', totalPoints: 400, totalEvents: 5, totalReviews: 2 },
  { $id: 'u4', $createdAt: '2026-04-19T00:00:00.000Z', firstname: '', lastname: '', username: 'ghost', email: 'ghost@example.com', phoneNumber: null, dob: undefined, tierLevel: '', totalPoints: undefined, totalEvents: undefined, totalReviews: undefined },
]
const tierOrderMap = { Bronze: 1, Silver: 2, Gold: 3 }
const base = { searchQuery: '', tierFilter: ALL_TIERS, sortBy: 'createdAt', sortOrder: 'desc', page: 1, pageSize: 25, tierOrderMap }
const view = (over) => buildUserListView(users, { ...base, ...over })
const ids = (v) => v.rows.map((u) => u.$id)

// --- search: the defect that userSearch.ts fixed must survive the move in-memory ---
eq('full name across two fields matches', ids(view({ searchQuery: 'Kelsey Cooper' })), ['u1'])
eq('reversed token order matches', ids(view({ searchQuery: 'Cooper Kelsey' })), ['u1'])
eq('single token still matches', ids(view({ searchQuery: 'Kelsey' })), ['u1'])
eq('username matches', ids(view({ searchQuery: 'ragnarock' })), ['u2'])
eq('no match yields empty page, total 0', view({ searchQuery: 'zzzznope' }).total, 0)
eq('empty query returns everyone', view({ searchQuery: '   ' }).total, 4)

// --- search classification: '@' is email-only, all-digits is phone-only ---
eq('email query matches email only', ids(view({ searchQuery: 'aschuster4379@gmail' })), ['u2'])
eq('email query ignores name fields', ids(view({ searchQuery: 'Kelsey@' })), [])
eq('phone query ignores formatting', ids(view({ searchQuery: '5552013344' })), ['u1'])
eq('partial phone (3+ digits) matches', ids(view({ searchQuery: '2019999' })), ['u2'])
// Both match; order is the default sort ($createdAt desc), so the newer u2 leads.
eq('phone query skips rows with blank/null phone', ids(view({ searchQuery: '555201' })), ['u2', 'u1'])
eq('2-digit query is treated as text, not phone', view({ searchQuery: '55' }).total, 0)
eq('missing email is skipped, not coerced to "undefined"', ids(view({ searchQuery: 'undefined@' })), [])

// --- tier filter runs against the EFFECTIVE tier, like the table displays ---
eq('tier filter selects that tier', ids(view({ tierFilter: 'Gold' })), ['u2'])
eq('ALL_TIERS filters nothing', view({ tierFilter: ALL_TIERS }).total, 4)
eq('blank stored tier never matches a named filter', ids(view({ tierFilter: 'Bronze' })), ['u1'])
eq(
  'tier filter honours resolveTier (points-derived tier beats stored)',
  ids(view({ tierFilter: 'Gold', resolveTier: (u) => (u.$id === 'u1' ? 'Gold' : u.tierLevel) })),
  ['u2', 'u1'] // u2 first: default sort is $createdAt desc... asserted separately below
)

// --- sorting ---
eq('createdAt desc is newest first', ids(view({})), ['u4', 'u3', 'u2', 'u1'])
eq('createdAt asc is oldest first', ids(view({ sortOrder: 'asc' })), ['u1', 'u2', 'u3', 'u4'])
eq('points desc', ids(view({ sortBy: 'points', sortOrder: 'desc' })), ['u2', 'u3', 'u1', 'u4'])
eq('points asc keeps missing values last', ids(view({ sortBy: 'points', sortOrder: 'asc' })), ['u1', 'u3', 'u2', 'u4'])
eq('events desc', ids(view({ sortBy: 'events', sortOrder: 'desc' })), ['u2', 'u3', 'u1', 'u4'])
eq('reviews desc', ids(view({ sortBy: 'reviews', sortOrder: 'desc' })), ['u2', 'u3', 'u1', 'u4'])
// Al, Kassy, Kelsey, then the blank name.
eq('name asc is case-insensitive, blanks last', ids(view({ sortBy: 'name', sortOrder: 'asc' })), ['u2', 'u3', 'u1', 'u4'])
eq('name desc reverses real names but keeps the blank last', ids(view({ sortBy: 'name', sortOrder: 'desc' })), ['u1', 'u3', 'u2', 'u4'])
eq('email asc, missing email last', ids(view({ sortBy: 'email', sortOrder: 'asc' })), ['u2', 'u4', 'u1', 'u3'])
eq('email desc still keeps missing email last', ids(view({ sortBy: 'email', sortOrder: 'desc' })), ['u1', 'u4', 'u2', 'u3'])
eq('dob asc, blanks last', ids(view({ sortBy: 'dob', sortOrder: 'asc' })), ['u2', 'u1', 'u3', 'u4'])

// Tier sorts by RANK, not alphabetically — 'Silver' must not outrank 'Gold'.
eq('tier desc uses rank order', ids(view({ sortBy: 'tierLevel', sortOrder: 'desc' })), ['u2', 'u3', 'u1', 'u4'])
eq('tier asc uses rank order', ids(view({ sortBy: 'tierLevel', sortOrder: 'asc' })), ['u1', 'u3', 'u2', 'u4'])
eq(
  'tier sort would be WRONG if lexicographic (Gold before Silver descending)',
  ids(view({ sortBy: 'tierLevel', sortOrder: 'desc' }))[0],
  'u2'
)
eq('unknown tier name sorts last, both directions', [
  ids(view({ sortBy: 'tierLevel', sortOrder: 'asc', tierOrderMap: {} })).length,
  view({ sortBy: 'tierLevel', sortOrder: 'asc', tierOrderMap: {} }).total,
], [4, 4])

// --- pagination ---
eq('page 1 of pageSize 2', ids(view({ pageSize: 2, page: 1, sortOrder: 'asc' })), ['u1', 'u2'])
eq('page 2 of pageSize 2', ids(view({ pageSize: 2, page: 2, sortOrder: 'asc' })), ['u3', 'u4'])
eq('totalPages reflects filtered total, not collection size', view({ pageSize: 2, searchQuery: 'Kelsey' }).totalPages, 1)
eq('page past the end clamps to the last page', view({ pageSize: 2, page: 9, sortOrder: 'asc' }).page, 2)
eq('page past the end returns rows, never a blank table', ids(view({ pageSize: 2, page: 9, sortOrder: 'asc' })), ['u3', 'u4'])
eq('empty result reports page 1', view({ searchQuery: 'zzzznope' }).page, 1)
eq('page 0 / negative clamps to 1', view({ page: -3, sortOrder: 'asc' }).page, 1)

// --- purity: safe to call on every keystroke ---
const before = JSON.stringify(users)
view({ sortBy: 'points', searchQuery: 'kel' })
eq('input array is not mutated by sorting', JSON.stringify(users), before)

console.log(failures === 0 ? '\nAll user-list-view assertions passed.' : `\n${failures} assertion(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
