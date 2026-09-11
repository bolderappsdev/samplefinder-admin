// Verification for the pop-up viewer list logic (src/lib/popupViewers.ts).
//
// Run with:  npm run verify:popup-viewers
//
// This backs the "Who saw this pop-up" table on the pop-up detail page. The rows come from
// the Statistics function capped at 1000, so every narrowing the admin does runs in memory
// here — a wrong predicate means the admin is told the wrong people saw a campaign, which is
// exactly the question the client asked us to answer. The assertions pin the decisions that
// are easy to regress: missing timestamps sorting last in BOTH directions, a date range that
// covers a whole single day, and search spanning name + username.
//
// Exits non-zero on any failed assertion.

// Compiled to CommonJS (unlike the single-file verify scripts) because popupViewers imports
// userSearch: tsc emits that as an extensionless relative import, which ESM cannot resolve but
// require() can.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  filterViewers,
  sortViewers,
  filterAndSortViewers,
  hasActiveViewerFilters,
  initialViewerFilters,
} = require('./.pvcheck/popupViewers.js')

// Every date assertion names the timezone explicitly, so these results do not depend on
// the timezone of the machine running them. Eastern is the app timezone in production.
const TZ = 'America/New_York'

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

const viewer = (over) => ({
  userId: 'u0',
  name: 'Nobody',
  username: 'nobody',
  shownAt: '2026-09-11T12:00:00.000+00:00',
  clickedAt: null,
  is21Plus: true,
  ...over,
})

// Deliberately NOT in timestamp order, so a passing sort assertion cannot be an accident.
const kelsey = viewer({
  userId: 'u1', name: 'Kelsey Cooper', username: 'kelseyallyn',
  shownAt: '2026-09-11T14:00:00.000+00:00', clickedAt: '2026-09-11T14:05:00.000+00:00',
})
const al = viewer({
  userId: 'u2', name: 'Al Schuster', username: 'RagnaRock4379',
  shownAt: '2026-09-09T09:00:00.000+00:00', clickedAt: null,
})
const kassy = viewer({
  userId: 'u3', name: 'Kassy Pierre', username: 'karaapierre',
  shownAt: '2026-09-10T23:30:00.000+00:00', clickedAt: '2026-09-10T23:31:00.000+00:00',
})
const minor = viewer({
  userId: 'u4', name: 'Teen Tester', username: 'teen',
  shownAt: '2026-09-10T08:00:00.000+00:00', clickedAt: null, is21Plus: false,
})
// A deleted profile: the function falls back to the raw id for the name.
const orphan = viewer({
  userId: 'u5', name: 'u5', username: '', shownAt: null, clickedAt: null,
})

const ALL = [kelsey, al, kassy, minor, orphan]
const ids = (rows) => rows.map((r) => r.userId)
const filtered = (rows, f) => filterViewers(rows, f, TZ)
const f = (over) => ({ ...initialViewerFilters, ...over })

console.log('\n--- no filters ---')
eq('everything passes an empty filter set', ids(filtered(ALL, f())), ['u1', 'u2', 'u3', 'u4', 'u5'])
eq('empty filter set is not "active"', hasActiveViewerFilters(f()), false)

console.log('\n--- search spans name and username (the fix carried over from userSearch) ---')
eq('full name across both name words', ids(filtered(ALL, f({ search: 'Kelsey Cooper' }))), ['u1'])
eq('reversed token order still matches', ids(filtered(ALL, f({ search: 'Cooper Kelsey' }))), ['u1'])
eq('username matches', ids(filtered(ALL, f({ search: 'ragna' }))), ['u2'])
eq('name + username together match one row', ids(filtered(ALL, f({ search: 'Al RagnaRock' }))), ['u2'])
eq('case-insensitive', ids(filtered(ALL, f({ search: 'KASSY' }))), ['u3'])
eq('partial token', ids(filtered(ALL, f({ search: 'pier' }))), ['u3'])
eq('no match yields nothing', ids(filtered(ALL, f({ search: 'zzz' }))), [])
eq('whitespace-only search is not a filter', ids(filtered(ALL, f({ search: '   ' }))), ['u1', 'u2', 'u3', 'u4', 'u5'])
eq('a row with an empty username still matches on its name', ids(filtered(ALL, f({ search: 'u5' }))), ['u5'])
eq('search counts as an active filter', hasActiveViewerFilters(f({ search: 'a' })), true)
eq('whitespace-only search does NOT count as active', hasActiveViewerFilters(f({ search: '  ' })), false)

console.log('\n--- engagement ---')
eq('clicked only', ids(filtered(ALL, f({ engagement: 'clicked' }))), ['u1', 'u3'])
eq('did not click', ids(filtered(ALL, f({ engagement: 'notClicked' }))), ['u2', 'u4', 'u5'])
eq('clicked + notClicked partition the whole list',
  filtered(ALL, f({ engagement: 'clicked' })).length +
  filtered(ALL, f({ engagement: 'notClicked' })).length, ALL.length)

console.log('\n--- age gate recorded at display time ---')
eq('21+ only', ids(filtered(ALL, f({ age: '21plus' }))), ['u1', 'u2', 'u3', 'u5'])
eq('under 21 only', ids(filtered(ALL, f({ age: 'under21' }))), ['u4'])

console.log('\n--- date range applies to Shown, and covers the whole picked day ---')
// The picker hands back local midnight; the day it names is then bounded in the APP timezone.
const day = (iso) => new Date(iso)
const sep10 = { start: day('2026-09-10T00:00:00'), end: null }
const shownOnSep10 = ids(filtered(ALL, f({ dateRange: sep10 })))
// Kassy was shown 23:30 UTC on the 10th, which is 19:30 Eastern that same day: reading the
// range in UTC (or in the browser's zone) is what would wrongly drop her.
eq('single-day pick keeps every row shown that Eastern day', shownOnSep10, ['u3', 'u4'])
eq('single-day pick excludes the day before', shownOnSep10.includes('u2'), false)
eq('single-day pick excludes the day after', shownOnSep10.includes('u1'), false)
eq('a row with no shownAt drops out of a date-narrowed view', shownOnSep10.includes('u5'), false)
eq('but it survives when no range is set', ids(filtered(ALL, f())).includes('u5'), true)
// 23:59 as an inclusive end would drop anything in that final minute; the bound is exclusive.
eq('a sighting in the last minute of the picked day is kept',
  ids(filtered([viewer({ userId: 'late', shownAt: '2026-09-11T03:59:30.000+00:00' })],
    f({ dateRange: { start: day('2026-09-10T00:00:00'), end: null } }))), ['late'])
eq('the very next Eastern midnight is excluded',
  ids(filtered([viewer({ userId: 'next', shownAt: '2026-09-11T04:00:00.000+00:00' })],
    f({ dateRange: { start: day('2026-09-10T00:00:00'), end: null } }))), [])
eq('multi-day range', ids(filtered(ALL, f({
  dateRange: { start: day('2026-09-09T00:00:00'), end: day('2026-09-10T00:00:00') },
}))).sort(), ['u2', 'u3', 'u4'])
eq('a date range counts as an active filter',
  hasActiveViewerFilters(f({ dateRange: sep10 })), true)

console.log('\n--- combining filters ---')
eq('search + engagement', ids(filtered(ALL, f({ search: 'a', engagement: 'clicked' }))), ['u1', 'u3'])
eq('engagement + age excludes the under-21 non-clicker',
  ids(filtered(ALL, f({ engagement: 'notClicked', age: '21plus' }))), ['u2', 'u5'])

console.log('\n--- sorting: missing timestamps last in BOTH directions ---')
eq('shown desc', ids(sortViewers(ALL, 'shownAt', 'desc')), ['u1', 'u3', 'u4', 'u2', 'u5'])
eq('shown asc', ids(sortViewers(ALL, 'shownAt', 'asc')), ['u2', 'u4', 'u3', 'u1', 'u5'])
eq('no-shownAt row is last when descending', ids(sortViewers(ALL, 'shownAt', 'desc')).at(-1), 'u5')
eq('no-shownAt row is STILL last when ascending', ids(sortViewers(ALL, 'shownAt', 'asc')).at(-1), 'u5')
eq('clicked desc puts clickers first', ids(sortViewers(ALL, 'clickedAt', 'desc')).slice(0, 2), ['u1', 'u3'])
eq('clicked asc does NOT flood the top with non-clickers',
  ids(sortViewers(ALL, 'clickedAt', 'asc')).slice(0, 2), ['u3', 'u1'])
eq('non-clickers stay grouped at the bottom, ascending',
  ids(sortViewers(ALL, 'clickedAt', 'asc')).slice(2).sort(), ['u2', 'u4', 'u5'])
eq('name asc', ids(sortViewers(ALL, 'name', 'asc')), ['u2', 'u3', 'u1', 'u4', 'u5'])
eq('name desc', ids(sortViewers(ALL, 'name', 'desc')), ['u5', 'u4', 'u1', 'u3', 'u2'])

console.log('\n--- sorting is stable and non-mutating ---')
const tieA = viewer({ userId: 'b', name: 'Same Time', shownAt: '2026-09-11T10:00:00.000+00:00' })
const tieB = viewer({ userId: 'a', name: 'Same Time', shownAt: '2026-09-11T10:00:00.000+00:00' })
eq('equal timestamps break ties by userId', ids(sortViewers([tieA, tieB], 'shownAt', 'desc')), ['a', 'b'])
eq('same tie order in the other direction (so paging cannot reshuffle)',
  ids(sortViewers([tieA, tieB], 'shownAt', 'asc')), ['a', 'b'])
const before = ids(ALL)
sortViewers(ALL, 'name', 'asc')
eq('the input array is not mutated', ids(ALL), before)

console.log('\n--- filterAndSortViewers composes both ---')
eq('clicked, most recent first',
  ids(filterAndSortViewers(ALL, f({ engagement: 'clicked', sortBy: 'shownAt', sortOrder: 'desc' }), TZ)),
  ['u1', 'u3'])
eq('empty result when nothing matches',
  ids(filterAndSortViewers(ALL, f({ search: 'zzz' }), TZ)), [])
eq('an empty input list is handled', ids(filterAndSortViewers([], f(), TZ)), [])

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll pop-up viewer list assertions passed')
