// Verification for the Report Builder's data-source dispatch, i.e. which single fetcher
// materializes a custom report for the "All Data" entity.
//
// Regression under test (client report, 2026-07-31): a user report — First/Last Name, Username,
// Email, User Points, Check-in/Review Pts, Check-Ins, Reviews, Trivias Won — came back with the
// same user repeated once per review and every users-only metric blank, because the dispatch chose
// the review fetcher whenever ANY selected column merely *mentioned* reviews (the identity columns
// list both 'users' and 'reviews').
//
// Run with:
//   npm run verify:report-builder
// or manually:
//   npx tsc src/lib/reportBuilderSource.ts src/lib/reportBuilderConfig.ts --outDir scripts/.rbcheck \
//     --target es2020 --module es2020 --moduleResolution bundler --skipLibCheck --jsx react-jsx
//   node scripts/verify-report-builder-source.mjs
//
// Exits non-zero on any failed assertion.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  pickPrimarySource,
  columnsNotCoveredBy,
  countCoveredBy,
} from './.rbcheck/lib/reportBuilderSource.js'
import { REPORT_COLUMNS, getColumnsByKeys } from './.rbcheck/lib/reportBuilderConfig.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

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

/** The dispatch rule this bug was caused by, kept so a revert to it fails these assertions. */
const naiveSourceRule = (columns) => {
  if (columns.some((c) => c.dataSource.includes('reviews'))) return 'reviews'
  if (columns.some((c) => c.dataSource.includes('events'))) return 'events'
  if (columns.some((c) => c.dataSource.includes('trivia'))) return 'trivia'
  if (columns.some((c) => c.dataSource.includes('users'))) return 'users'
  if (columns.some((c) => c.dataSource.includes('clients'))) return 'clients'
  return null
}

/**
 * A report is only trustworthy if the chosen fetcher can fill every selected column — an
 * uncovered column renders as an empty cell with no explanation (ReportPreview falls back to '').
 */
const picksAndCoversAll = (label, keys, expectedSource) => {
  const columns = getColumnsByKeys(keys)
  eq(`${label}: all ${keys.length} columns resolve`, columns.length, keys.length)
  const source = pickPrimarySource(columns)
  eq(`${label}: source`, source, expectedSource)
  eq(`${label}: no blank columns`, source ? columnsNotCoveredBy(source, columns) : keys, [])
}

// --- The two reports from the client's screenshots -------------------------------------------
// Screenshot 1: 9 columns, 07/01/2026-07/31/2026 -> showed 4 rows of one user, 5 columns blank.
const screenshot1Keys = [
  'userPoints',
  'firstName',
  'lastName',
  'username',
  'email',
  'checkInReviewPoints',
  'checkIns',
  'reviews',
  'triviasWon',
]
picksAndCoversAll('screenshot 1 (9 user columns)', screenshot1Keys, 'users')

// Screenshot 2: 5 columns, 06/01/2026-07/31/2026 -> showed 5 rows for 2 distinct users.
const screenshot2Keys = ['firstName', 'lastName', 'username', 'email', 'userPoints']
picksAndCoversAll('screenshot 2 (5 user columns)', screenshot2Keys, 'users')

// The bug itself: the old rule sent both of those to the per-review fetcher.
const screenshot1Columns = getColumnsByKeys(screenshot1Keys)
eq('regression: old rule mis-routed screenshot 1', naiveSourceRule(screenshot1Columns), 'reviews')
eq(
  'regression: review fetcher leaves the metrics blank',
  columnsNotCoveredBy('reviews', screenshot1Columns),
  ['userPoints', 'checkInReviewPoints', 'checkIns', 'reviews', 'triviasWon']
)
eq('coverage: users covers all 9', countCoveredBy('users', screenshot1Columns), 9)
eq('coverage: reviews covers only the 4 identity columns', countCoveredBy('reviews', screenshot1Columns), 4)

// --- Reports that must keep routing where they did ------------------------------------------
// Identity-only: a tie (users 4, reviews 4) resolved to one row per user, not one row per review.
picksAndCoversAll('identity only', ['firstName', 'lastName', 'username', 'email'], 'users')
// Review-level columns pull the report to per-review granularity even alongside user identity.
picksAndCoversAll('review detail + identity', ['reviewStars', 'reviewFeedback', 'firstName'], 'reviews')
// Event-recap shape: the review fetcher joins user + event + client/category, so it covers all 9.
picksAndCoversAll(
  'event recap (attendee level)',
  ['eventName', 'eventDate', 'checkInCode', 'clientName', 'productType', 'firstName', 'lastName', 'checkIn', 'hasReview'],
  'reviews'
)
picksAndCoversAll('event columns', ['eventName', 'checkInPoints', 'reviewPoints', 'startTime'], 'events')
picksAndCoversAll('location columns', ['location', 'city', 'state', 'zip'], 'events')
picksAndCoversAll('trivia columns', ['question', 'totalResponses', 'totalCorrect'], 'trivia')
picksAndCoversAll('client columns', ['clientName', 'logoFile', 'favorites'], 'clients')
eq('empty selection -> no source', pickPrimarySource([]), null)

// --- Table-wide invariants -------------------------------------------------------------------
// Every selectable column must be reachable on its own, or it can never be reported at all.
const unreachable = REPORT_COLUMNS.filter((col) => pickPrimarySource([col]) === null).map((c) => c.key)
eq('every column is reachable alone', unreachable, [])

/**
 * Static guard for the *other* half of the bug: a fetcher that lacks a `case` for a column it
 * advertises in `dataSource` silently emits a blank cell. Scans the switch-style fetchers in
 * exportService.ts. 'trivia' is excluded because its fetcher delegates to generateTriviaReport and
 * filters by key rather than switching.
 */
const exportServiceSrc = readFileSync(join(repoRoot, 'src/lib/exportService.ts'), 'utf8')
const fetcherMethods = {
  events: 'fetchEventDataForCustomReport',
  users: 'fetchUserDataForCustomReport',
  clients: 'fetchClientDataForCustomReport',
  reviews: 'fetchReviewDataForCustomReport',
}
for (const [source, method] of Object.entries(fetcherMethods)) {
  const start = exportServiceSrc.indexOf(`async ${method}(`)
  if (start < 0) {
    failures++
    console.error(`FAIL fetcher ${method} not found in exportService.ts`)
    continue
  }
  const rest = exportServiceSrc.slice(start + 1)
  const nextMethod = rest.search(/\n  (?:async )?[a-zA-Z][a-zA-Z0-9_]*\(/)
  const body = nextMethod < 0 ? rest : rest.slice(0, nextMethod)
  const handled = new Set([...body.matchAll(/case '([a-zA-Z0-9_]+)'/g)].map((m) => m[1]))
  const advertised = REPORT_COLUMNS.filter((c) => c.dataSource.includes(source)).map((c) => c.key)
  eq(`${method} handles every column it advertises`, advertised.filter((k) => !handled.has(k)), [])
}

/**
 * Static guard #2: the preview's descending-sort key set and the export's must agree. They are two
 * literals in two files, so drift is silent — and it shows up as an exported CSV ordered opposite to
 * the preview the user just approved (worst first instead of the winner first).
 */
const previewSrc = readFileSync(join(repoRoot, 'src/pages/Reports/PreviewReports.tsx'), 'utf8')
const keysFromSetLiteral = (src, declaration) => {
  const start = src.indexOf(declaration)
  if (start < 0) return null
  const open = src.indexOf('[', start)
  const close = src.indexOf(']', open)
  if (open < 0 || close < 0) return null
  return new Set([...src.slice(open, close).matchAll(/'([a-zA-Z0-9_]+)'/g)].map((m) => m[1]))
}
const previewDesc = keysFromSetLiteral(previewSrc, 'const descendingNumericKeys = new Set(')
const exportDesc = keysFromSetLiteral(exportServiceSrc, 'const SORT_DESCENDING_NUMERIC_KEYS = new Set(')
if (!previewDesc || !exportDesc) {
  failures++
  console.error('FAIL could not locate both descending-sort key sets (declaration renamed?)')
} else {
  eq('descending-sort keys: in preview but not in export',
    [...previewDesc].filter((k) => !exportDesc.has(k)), [])
  eq('descending-sort keys: in export but not in preview',
    [...exportDesc].filter((k) => !previewDesc.has(k)), [])
  // Every numeric points/count column the Points Earned (Date Range) report emits must sort
  // descending — the winner-first ordering is the whole point of that report.
  const rangeNumericKeys = [
    'userPoints', 'checkInPoints', 'reviewPoints', 'triviaPoints', 'signupPoints',
    'referralPoints', 'referrerPoints', 'checkIns', 'reviews', 'triviasWon',
    'referralsMade', 'lifetimePoints', 'unattributedPoints',
  ]
  eq('every Points Earned (Date Range) numeric column sorts descending',
    rangeNumericKeys.filter((k) => !previewDesc.has(k) || !exportDesc.has(k)), [])
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
