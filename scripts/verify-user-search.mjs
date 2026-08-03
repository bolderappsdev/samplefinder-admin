// Verification for the admin list-screen search matcher (src/lib/userSearch.ts).
//
// Run with:  npm run verify:user-search
//
// Anchors the client-reported defect: searching a full name found nobody while searching the
// first name alone worked. `oldRule` below is the exact predicate that shipped; it is kept here
// so the assertions fail if anyone reverts to per-field whole-query matching.
//
// Exits non-zero on any failed assertion.

import { matchesAllTokens, searchTokens } from './.uscheck/userSearch.js'

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

/** The predicate this module replaces: each field tested against the WHOLE query. */
const oldRule = (fields, query) => {
  const lower = query.toLowerCase()
  return fields.some((f) => f != null && String(f).toLowerCase().includes(lower))
}

const kelsey = ['Kelsey', 'Cooper', 'Kelseyallyn', 'kelseyallyn@yahoo.com']
const alSchuster = ['Al', 'Schuster', 'RagnaRock4379', 'aschuster4379@gmail.com']
const kassy = ['Kassy', 'Pierre', 'karaapierre', null]
const noName = [null, undefined, '', null]

// --- The reported bug, verbatim ---
eq('"Kelsey Cooper" now matches', matchesAllTokens(kelsey, 'Kelsey Cooper'), true)
eq('"Kelsey Cooper" did NOT match under the old rule (red step)', oldRule(kelsey, 'Kelsey Cooper'), false)
eq('"Kelsey" alone still matches (worked before, must keep working)', matchesAllTokens(kelsey, 'Kelsey'), true)
eq('old rule also matched "Kelsey" — single token is unchanged behaviour', oldRule(kelsey, 'Kelsey'), true)

// --- Single-token queries must behave EXACTLY as before, or this is a regression, not a fix ---
for (const q of ['kelsey', 'Cooper', 'coop', 'allyn', 'yahoo', 'KELSEYALLYN@YAHOO.COM', 'zzz', 'ragna', '4379']) {
  eq(`single token "${q}" matches old rule exactly`, matchesAllTokens(kelsey, q), oldRule(kelsey, q))
  eq(`single token "${q}" matches old rule exactly (al)`, matchesAllTokens(alSchuster, q), oldRule(alSchuster, q))
}

// --- Token order, casing and spacing ---
eq('reversed order "Cooper Kelsey"', matchesAllTokens(kelsey, 'Cooper Kelsey'), true)
eq('lowercase "kelsey cooper"', matchesAllTokens(kelsey, 'kelsey cooper'), true)
eq('mixed case "KeLsEy CoOpEr"', matchesAllTokens(kelsey, 'KeLsEy CoOpEr'), true)
eq('collapsed double space', matchesAllTokens(kelsey, 'Kelsey   Cooper'), true)
eq('tabs and newlines split like spaces', matchesAllTokens(kelsey, 'Kelsey\tCooper'), true)
eq('leading/trailing whitespace ignored', matchesAllTokens(kelsey, '  Kelsey Cooper  '), true)
eq('partial tokens both sides: "kel coo"', matchesAllTokens(kelsey, 'kel coo'), true)
eq('tokens may span name + username: "cooper allyn"', matchesAllTokens(kelsey, 'cooper allyn'), true)
eq('tokens may span name + email: "kelsey yahoo"', matchesAllTokens(kelsey, 'kelsey yahoo'), true)

// --- Every token must match: a query with one bogus word must NOT match (no OR-ing tokens) ---
eq('"Kelsey Smith" does not match', matchesAllTokens(kelsey, 'Kelsey Smith'), false)
eq('"Cooper Schuster" does not match either user', [
  matchesAllTokens(kelsey, 'Cooper Schuster'),
  matchesAllTokens(alSchuster, 'Cooper Schuster'),
], [false, false])
eq('three tokens, one bogus', matchesAllTokens(kelsey, 'kelsey cooper nope'), false)
eq('three tokens, all present', matchesAllTokens(kelsey, 'kelsey cooper yahoo'), true)

// --- Wrong person must not be dragged in by a shared token ---
eq('"Kassy Pierre" matches Kassy', matchesAllTokens(kassy, 'Kassy Pierre'), true)
eq('"Kassy Pierre" does not match Kelsey', matchesAllTokens(kelsey, 'Kassy Pierre'), false)

// --- Empty / whitespace-only query is "no filter", not "match nothing" ---
eq('empty query matches (no filter)', matchesAllTokens(kelsey, ''), true)
eq('whitespace-only query matches (no filter)', matchesAllTokens(kelsey, '   '), true)
eq('empty query matches even a record with no fields', matchesAllTokens(noName, ''), true)

// --- Null/undefined/empty fields are skipped, never stringified into the haystack ---
eq('null field is not searchable as "null"', matchesAllTokens(kassy, 'null'), false)
eq('undefined field is not searchable as "undefined"', matchesAllTokens(noName, 'undefined'), false)
eq('record with no usable fields matches nothing', matchesAllTokens(noName, 'kelsey'), false)
eq('a null email does not block a name match', matchesAllTokens(kassy, 'kassy'), true)

// --- searchTokens contract ---
eq('searchTokens splits and lowercases', searchTokens(' Kelsey  COOPER '), ['kelsey', 'cooper'])
eq('searchTokens on empty input', searchTokens(''), [])
eq('searchTokens on whitespace only', searchTokens(' \t\n '), [])
eq('searchTokens keeps punctuation inside a token', searchTokens('a@b.com x'), ['a@b.com', 'x'])

if (failures > 0) {
  console.error(`\n${failures} search assertion(s) failed`)
  process.exit(1)
}
console.log('\nAll user-search assertions passed')
