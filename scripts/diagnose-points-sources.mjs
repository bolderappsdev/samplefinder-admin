// READ-ONLY diagnostic: reconcile every user's lifetime `totalPoints` against the point awards the
// reports can actually date, and show where the difference comes from.
//
//   node scripts/diagnose-points-sources.mjs
//   node scripts/diagnose-points-sources.mjs "Kelsey Cooper" "Kassy Pierre"
//   node scripts/diagnose-points-sources.mjs --range 2026-07-01..2026-07-31
//   node scripts/diagnose-points-sources.mjs --range 2026-06-01..2026-07-31 "Al Schuster"
//
// Why this exists: `user_profiles.totalPoints` is a running counter written by several code paths and
// only some of them leave a dated record. The date-range reports rebuild a window by re-summing the
// datable ones, so a user whose points came from an undatable path — birthday bonus, sampling
// anniversary bonus, the BA/Influencer badge award, or a manual edit of User Points in the admin
// panel — shows a large lifetime total next to a small in-range total. This prints that residue per
// user, which is the evidence to check before settling a contest from a range report.
//
// Mirrors src/lib/reportPoints.ts exactly, so its numbers should match the report. Makes no writes.

import { readFileSync } from 'node:fs'
import { Client, Databases, Query } from 'node-appwrite'

const SIGNUP_BONUS = 100 // mirrors SIGNUP_BONUS_POINTS in src/lib/reportPoints.ts
const SPECIAL_BADGE_POINTS = 100 // mirrors the Notification function's badge award

// --- env ---------------------------------------------------------------------------------------
const env = {}
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
for (const key of ['VITE_APPWRITE_ENDPOINT', 'VITE_APPWRITE_PROJECT_ID', 'VITE_APPWRITE_DATABASE_ID', 'APPWRITE_API_KEY']) {
  if (!env[key]) {
    console.error(`Missing ${key} in .env`)
    process.exit(2)
  }
}

// --- args --------------------------------------------------------------------------------------
const args = process.argv.slice(2)
let range = null
const rangeIdx = args.indexOf('--range')
if (rangeIdx >= 0) {
  const [from, to] = (args[rangeIdx + 1] ?? '').split('..')
  if (!from || !to) {
    console.error('--range expects YYYY-MM-DD..YYYY-MM-DD')
    process.exit(2)
  }
  range = { from: new Date(`${from}T00:00:00`), to: new Date(`${to}T23:59:59.999`) }
  args.splice(rangeIdx, 2)
}
const namesWanted = args.map((a) => a.toLowerCase())

// --- fetch -------------------------------------------------------------------------------------
const db = new Databases(
  new Client()
    .setEndpoint(env.VITE_APPWRITE_ENDPOINT)
    .setProject(env.VITE_APPWRITE_PROJECT_ID)
    .setKey(env.APPWRITE_API_KEY)
)
const DB = env.VITE_APPWRITE_DATABASE_ID

/** Cursor-paged full read. Mirrors listAllPaged in src/lib/exportService.ts. */
const listAll = async (collection) => {
  const out = []
  let cursor = null
  for (;;) {
    const queries = [Query.limit(500)]
    if (cursor) queries.push(Query.cursorAfter(cursor))
    const page = await db.listDocuments(DB, collection, queries)
    out.push(...page.documents)
    if (page.documents.length < 500) break
    cursor = page.documents[page.documents.length - 1].$id
  }
  return out
}

/** Birthday/anniversary bonuses are stored by `key`, not by document id, unlike the referral pair. */
const readSettingByKey = async (key) => {
  try {
    const r = await db.listDocuments(DB, 'settings', [Query.equal('key', [key]), Query.limit(1)])
    const n = parseInt(r.documents[0]?.value, 10)
    return Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

const readSetting = async (id) => {
  try {
    const n = parseInt((await db.getDocument(DB, 'settings', id)).value, 10)
    return Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

let users, checkins, reviews, responses, trivia, refereePts, referrerPts, birthdayPts, anniversaryPts
try {
  ;[users, checkins, reviews, responses, trivia, refereePts, referrerPts, birthdayPts, anniversaryPts] = await Promise.all([
    listAll('user_profiles'),
    listAll('checkins'),
    listAll('reviews'),
    listAll('trivia_responses'),
    listAll('trivia'),
    readSetting('ref_setting_referee_pts'),
    readSetting('ref_setting_referrer_pts'),
    readSettingByKey('birthdayPoints'),
    readSettingByKey('anniversaryPoints'),
  ])
} catch (err) {
  const type = err && typeof err === 'object' ? err.type : undefined
  if (type === 'project_key_expired' || type === 'user_unauthorized' || err?.code === 401) {
    console.error(`\nAppwrite rejected the key: ${err.message}`)
    console.error('Generate a fresh API key in the Appwrite console (read access to user_profiles,')
    console.error('checkins, reviews, trivia, trivia_responses and settings) and set APPWRITE_API_KEY in .env.')
    process.exit(1)
  }
  throw err
}

// --- aggregation -------------------------------------------------------------------------------
const rel = (v) => (v == null ? undefined : typeof v === 'string' ? v : v.$id)
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
const triviaById = new Map(trivia.map((t) => [t.$id, t]))
const byId = new Map(users.map((u) => [u.$id, u]))

// referralCode -> owner. First wins, matching the Mobile API's Query.equal(...).limit(1) lookup.
const ownerByCode = new Map()
for (const u of users) {
  const code = (u.referralCode ?? '').trim()
  if (code && !ownerByCode.has(code)) ownerByCode.set(code, u.$id)
}

const EMPTY = { checkIn: 0, review: 0, trivia: 0, signup: 0, referee: 0, referrer: 0, referralsMade: 0, checkInCount: 0, reviewCount: 0, triviaWins: 0 }
const total = (b) => b.checkIn + b.review + b.trivia + b.signup + b.referee + b.referrer
const label = (u) => `${u.firstname ?? ''} ${u.lastname ?? ''}`.trim() || u.username || u.$id

/** Attributable points per user over `accepts($createdAt)`. Pass `() => true` for all time. */
const aggregate = (accepts) => {
  const acc = new Map()
  const ensure = (id) => {
    let b = acc.get(id)
    if (!b) {
      b = { ...EMPTY }
      acc.set(id, b)
    }
    return b
  }
  for (const c of checkins) {
    const id = rel(c.user)
    if (!id || !accepts(c.$createdAt)) continue
    const b = ensure(id)
    b.checkIn += num(c.points)
    b.checkInCount++
  }
  for (const r of reviews) {
    const id = rel(r.user)
    if (!id || !accepts(r.$createdAt)) continue
    const b = ensure(id)
    b.review += num(r.pointsEarned)
    b.reviewCount++
  }
  for (const r of responses) {
    const id = rel(r.user)
    const t = triviaById.get(rel(r.trivia))
    if (!id || !t || !accepts(r.$createdAt)) continue
    if (num(r.answerIndex) !== num(t.correctOptionIndex)) continue
    const b = ensure(id)
    b.trivia += num(t.points)
    b.triviaWins++
  }
  for (const u of users) {
    if (!accepts(u.$createdAt)) continue
    const b = ensure(u.$id)
    b.signup += SIGNUP_BONUS
    const code = (u.usedReferralCode ?? '').trim()
    if (!code) continue
    b.referee += refereePts ?? 0
    const owner = ownerByCode.get(code)
    if (!owner || owner === u.$id) continue
    const o = ensure(owner)
    o.referrer += referrerPts ?? 0
    o.referralsMade++
  }
  return acc
}

const inRange = (iso) => {
  if (!iso) return false
  const t = Date.parse(iso)
  return Number.isFinite(t) && t >= range.from.getTime() && t <= range.to.getTime()
}
const allTime = aggregate(() => true)
const windowed = range ? aggregate(inRange) : null

// --- report ------------------------------------------------------------------------------------
const line = (b) =>
  `check-in ${b.checkIn} (${b.checkInCount}) | review ${b.review} (${b.reviewCount}) | trivia ${b.trivia} (${b.triviaWins}) | signup ${b.signup} | referee ${b.referee} | referrer ${b.referrer} (${b.referralsMade} invited)`

// Bounds are local midnight / local end-of-day, so format them in LOCAL time. Using toISOString()
// here printed "2026-06-30..2026-07-31" for a July 1-31 window, which reads like an off-by-one in
// the filter when it is only the label.
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const rangeLabel = () => (range ? `${ymd(range.from)}..${ymd(range.to)}` : 'all time')

console.log('=== configuration ===')
console.log(`  signup bonus (hardcoded) : ${SIGNUP_BONUS}`)
console.log(`  ref_setting_referee_pts  : ${refereePts ?? 'MISSING/INVALID'}`)
console.log(`  ref_setting_referrer_pts : ${referrerPts ?? 'MISSING/INVALID'}`)
console.log(`  users ${users.length} | checkins ${checkins.length} | reviews ${reviews.length} | trivia_responses ${responses.length} | trivia ${trivia.length}`)
if (checkins.length === 0) {
  console.log('  NOTE: the checkins collection is empty, so in-range check-in points read 0 for everyone.')
}

for (const u of users) {
  if (!namesWanted.length) break
  const hay = `${label(u)} ${u.username ?? ''}`.toLowerCase()
  if (!namesWanted.some((n) => hay.includes(n))) continue
  const a = allTime.get(u.$id) ?? EMPTY
  console.log(`\n### ${label(u)} (${u.username}) — ${u.$id}`)
  console.log(`  lifetime totalPoints : ${u.totalPoints}`)
  console.log(`  signed up            : ${u.$createdAt}`)
  console.log(`  referralCode ${JSON.stringify(u.referralCode)} | usedReferralCode ${JSON.stringify(u.usedReferralCode)}`)
  console.log(`  BA ${u.isAmbassador} | influencer ${u.isInfluencer} | birthdayNotifYear ${u.birthdayNotifYear ?? '-'} | anniversaryNotifYear ${u.anniversaryNotifYear ?? '-'}`)
  if (windowed) {
    const w = windowed.get(u.$id) ?? EMPTY
    console.log(`  window ${rangeLabel()}`)
    console.log(`    ${line(w)}`)
    console.log(`    POINTS EARNED (RANGE): ${total(w)}`)
  }
  console.log(`  all time`)
  console.log(`    ${line(a)}`)
  console.log(`    attributable: ${total(a)}`)
  console.log(`    UNATTRIBUTED: ${num(u.totalPoints) - total(a)}  <-- birthday / anniversary / badge / manual edit`)
}

if (windowed) {
  console.log(`\n=== top 20 by POINTS EARNED (RANGE) ${rangeLabel()} ===`)
  const ranked = [...windowed.entries()]
    .map(([id, b]) => ({ b, u: byId.get(id) }))
    .filter((r) => r.u)
    .sort((x, y) => total(y.b) - total(x.b) || label(x.u).localeCompare(label(y.u)))
    .slice(0, 20)
  for (const r of ranked) {
    const a = allTime.get(r.u.$id) ?? EMPTY
    console.log(
      `  ${String(total(r.b)).padStart(6)}  ${label(r.u).padEnd(24)}` +
      ` lifetime=${String(r.u.totalPoints).padStart(6)}` +
      ` unattributed=${String(num(r.u.totalPoints) - total(a)).padStart(6)}` +
      ` (referrer=${r.b.referrer} from ${r.b.referralsMade} invited)`
    )
  }
}

console.log('\n=== roster-wide reconciliation (all time) ===')
let exact = 0
let above = 0
let below = 0
const gaps = []
for (const u of users) {
  const a = allTime.get(u.$id) ?? EMPTY
  const gap = num(u.totalPoints) - total(a)
  if (gap === 0) exact++
  else {
    if (gap > 0) above++
    else below++
    gaps.push({ u, gap, attributable: total(a) })
  }
}
console.log(`  reconciles exactly                                   : ${exact}`)
console.log(`  lifetime ABOVE attributable (undatable awards)       : ${above}`)
console.log(`  lifetime BELOW attributable (award re-priced later)  : ${below}`)
if (below > 0) {
  console.log('  ^ a negative gap means the report values a past award higher than what was banked.')
  console.log("    Check whether a trivia's points/answer key or a referral Settings value was edited")
  console.log('    after those points were awarded — historical rows are recomputed at current rates.')
}
gaps.sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap))
console.log('\n  largest gaps:')
for (const g of gaps.slice(0, 15)) {
  console.log(`    ${label(g.u).padEnd(24)} lifetime=${String(g.u.totalPoints).padStart(6)} attributable=${String(g.attributable).padStart(6)} gap=${g.gap > 0 ? '+' : ''}${g.gap}`)
}

// --- attribute the residue ---------------------------------------------------------------------
// The undatable awards leave *flags* even though they leave no dated record: birthdayNotifYear and
// anniversaryNotifYear are set when those bonuses are paid, and isAmbassador / isInfluencer imply a
// badge award. Combining them explains most of the residue and isolates what is genuinely a manual
// edit — which is the "clear breakdown" a reader needs to trust the ranking.
const badgePts = SPECIAL_BADGE_POINTS
// The Notification function falls back to these when the Settings docs are absent
// (checkAndSendBirthdayNotifications / checkAndSendAnniversaryNotifications), and right now they
// ARE absent, so the fallbacks are what production actually pays.
const BIRTHDAY_FALLBACK = 100
const ANNIVERSARY_FALLBACK = 200
const birthdayAward = birthdayPts ?? BIRTHDAY_FALLBACK
const anniversaryAward = anniversaryPts ?? ANNIVERSARY_FALLBACK
console.log('\n=== what the unexplained points are ===')
console.log(`  birthday award: ${birthdayAward}${birthdayPts == null ? ' (setting missing -> function fallback)' : ''} | anniversary: ${anniversaryAward}${anniversaryPts == null ? ' (setting missing -> function fallback)' : ''} | badge: ${badgePts}`)
let fullyExplained = 0
const unexplained = []
for (const g of gaps) {
  if (g.gap <= 0) continue
  const expected =
    (g.u.birthdayNotifYear ? birthdayAward : 0) +
    (g.u.anniversaryNotifYear ? anniversaryAward : 0) +
    (g.u.isAmbassador ? badgePts : 0) +
    (g.u.isInfluencer ? badgePts : 0)
  if (expected === g.gap) fullyExplained++
  else unexplained.push({ ...g, expected })
}
console.log(`  gap fully explained by birthday / anniversary / badge flags : ${fullyExplained}`)
console.log(`  gap still unexplained (manual User Points edits, or a badge`)
console.log(`  award paid more than once)                                  : ${unexplained.length}`)
if (unexplained.length) {
  console.log('\n  still unexplained:')
  for (const g of unexplained.slice(0, 15)) {
    const flags = [
      g.u.birthdayNotifYear ? `birthday:${g.u.birthdayNotifYear}` : null,
      g.u.anniversaryNotifYear ? `anniversary:${g.u.anniversaryNotifYear}` : null,
      g.u.isAmbassador ? 'BA' : null,
      g.u.isInfluencer ? 'influencer' : null,
    ].filter(Boolean).join(',') || 'no flags'
    const suffix = g.expected > 0 && g.gap > g.expected
      ? `  <-- ${g.gap - g.expected} beyond what the flags justify`
      : ''
    console.log(`    ${label(g.u).padEnd(24)} gap=+${String(g.gap).padStart(6)} flags explain ${String(g.expected).padStart(4)} [${flags}]${suffix}`)
  }
}
