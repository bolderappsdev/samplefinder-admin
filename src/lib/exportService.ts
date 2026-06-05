import { eventsService, clientsService, appUsersService, categoriesService, locationsService, reviewsService, triviaService, triviaResponsesService, checkinsService, isCorrectTriviaResponse } from './services'
import type { EventDocument, ClientDocument, AppUser, TriviaDocument, TriviaResponseDocument, ReviewDocument, CheckinDocument } from './services'
import { Query } from './appwrite'
import {
  aggregatePointsEarnedInRange,
  breakdownTotalPoints,
  breakdownCheckInReviewPoints,
  emptyPointsBreakdown,
  type PointsEarnedBreakdown,
  type TriviaPointInfo,
} from './reportPoints'
import { getAppTimezoneShortLabel } from './dateUtils'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import { getColumnsByKeys, type EntityType } from './reportBuilderConfig'

/**
 * Normalize date range for filtering: single date => that full day; range => start through end of end day.
 * Future dates are allowed. Returns undefined when no start date.
 */
export function getEffectiveDateRange(
  dateRange: { start: Date | null; end: Date | null } | undefined
): { start: Date; end: Date } | undefined {
  if (!dateRange?.start) return undefined
  const start = new Date(dateRange.start)
  start.setHours(0, 0, 0, 0)
  const end = dateRange.end ? new Date(dateRange.end) : new Date(dateRange.start)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

/**
 * Returns the current month as a date range (first day 00:00:00 through last day 23:59:59).
 * Used as the default range for Reports when nothing is selected.
 */
export function getCurrentMonthRange(): { start: Date; end: Date } {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  const start = new Date(year, month, 1)
  start.setHours(0, 0, 0, 0)
  const end = new Date(year, month + 1, 0)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

// Report type definitions matching the requirements from the image
export type ReportType = 
  | 'dashboard-all'
  | 'dashboard-date-range'
  | 'event-list'
  | 'clients-brands'
  | 'app-users'
  | 'points-earned-all'
  | 'points-earned-date-range'
  | 'event-recap'
  | 'trivia-report'
  | 'custom'

export interface ReportColumn {
  header: string
  key: string
  getValue?: (row: Record<string, string | number>) => string | number
}

// Dashboard (All) columns
const dashboardColumns: ReportColumn[] = [
  { header: 'Date', key: 'date' },
  { header: 'Event Name', key: 'venueName' },
  { header: 'Brand', key: 'brand' },
  { header: 'Start Time', key: 'startTime' },
  { header: 'End Time', key: 'endTime' },
  { header: 'Time Zone', key: 'timeZone' },
  { header: 'Product Type', key: 'products' },
  { header: 'Discount?', key: 'discount' },
]

// Event List columns - order matches report spec
const eventListColumns: ReportColumn[] = [
  { header: 'Event Name', key: 'name' },
  { header: 'Brand Name', key: 'brandName' },
  { header: 'Event Date', key: 'eventDate' },
  { header: 'Start Time', key: 'startTime' },
  { header: 'End Time', key: 'endTime' },
  { header: 'Time Zone', key: 'timeZone' },
  { header: 'Location', key: 'location' },
  { header: 'Address', key: 'address' },
  { header: 'City', key: 'city' },
  { header: 'State', key: 'state' },
  { header: 'Zip', key: 'zip' },
  { header: 'Product Type', key: 'productType' },
  { header: 'Products', key: 'products' },
  { header: 'Event Info', key: 'eventInfo' },
  { header: 'Discount Text', key: 'discountText' },
  { header: 'Discount Image File?', key: 'discountImageFile' },
  { header: 'Check-In Code', key: 'checkInCode' },
  { header: 'Check-in Points', key: 'checkInPoints' },
  { header: 'Review Points', key: 'reviewPoints' },
]

// Clients & Brands columns
const clientsBrandsColumns: ReportColumn[] = [
  { header: 'Client Name', key: 'name' },
  { header: 'Client Logo File?', key: 'logoFile' },
  { header: 'Signup Date', key: 'signupDate' },
  { header: 'Product Type', key: 'productType' },
  { header: '# of Favorites', key: 'favorites' },
]

// App Users columns
const appUsersColumns: ReportColumn[] = [
  { header: 'First Name', key: 'firstName' },
  { header: 'Last Name', key: 'lastName' },
  { header: 'Username', key: 'username' },
  { header: 'Email', key: 'email' },
  { header: 'Phone Number', key: 'phoneNumber' },
  { header: 'DOB', key: 'dob' },
  { header: 'Sign-Up Date', key: 'signUpDate' },
  { header: 'Last Login Date', key: 'lastLoginDate' },
  { header: 'Referral Code', key: 'referralCode' },
  { header: '# of Referrals', key: 'referralsCount' },
  { header: 'User Points', key: 'userPoints' },
  { header: 'Check-in/Review Pts', key: 'checkInReviewPoints' },
  { header: 'BA Badge (Yes/No)', key: 'baBadge' },
  { header: 'Influencer Badge (Yes/No)', key: 'influencerBadge' },
  { header: 'Tier Level', key: 'tierLevel' },
  { header: 'Check-Ins', key: 'checkIns' },
  { header: 'Reviews', key: 'reviews' },
  { header: 'Trivias Won', key: 'triviasWon' },
]

// Points Earned (All) columns
const pointsEarnedColumns: ReportColumn[] = [
  { header: 'First Name', key: 'firstName' },
  { header: 'Last Name', key: 'lastName' },
  { header: 'Username', key: 'username' },
  { header: 'Tier Level', key: 'tierLevel' },
  { header: 'User Points', key: 'userPoints' },
  { header: 'Check-in/Review Pts', key: 'checkInReviewPoints' },
  { header: 'Check-Ins', key: 'checkIns' },
  { header: 'Reviews', key: 'reviews' },
  { header: 'Trivias Won', key: 'triviasWon' },
]

// Points Earned (Date Range) columns. Same keys as the "All" report (so sorting/preview behave
// identically), but headers state that values are scoped to the selected window.
const pointsEarnedDateRangeColumns: ReportColumn[] = [
  { header: 'First Name', key: 'firstName' },
  { header: 'Last Name', key: 'lastName' },
  { header: 'Username', key: 'username' },
  { header: 'Tier Level', key: 'tierLevel' },
  { header: 'Points Earned (Range)', key: 'userPoints' },
  { header: 'Check-in/Review Pts (Range)', key: 'checkInReviewPoints' },
  { header: 'Check-Ins (Range)', key: 'checkIns' },
  { header: 'Reviews (Range)', key: 'reviews' },
  { header: 'Trivias Won (Range)', key: 'triviasWon' },
]

// Event Recap columns
const eventRecapColumns: ReportColumn[] = [
  { header: 'Event Name', key: 'eventName' },
  { header: 'Check-In Code', key: 'checkInCode' },
  { header: 'Brand Name', key: 'brandName' },
  { header: 'Event Date', key: 'eventDate' },
  { header: 'Product Type', key: 'productType' },
  { header: 'First Name', key: 'firstName' },
  { header: 'Last Name', key: 'lastName' },
  { header: 'Username', key: 'username' },
  { header: 'Check-In', key: 'checkIn' },
  { header: 'Review', key: 'hasReview' },
  { header: 'Review: # of Stars', key: 'reviewStars' },
  { header: 'Review: What did they like', key: 'reviewLiked' },
  { header: 'Review: Did they buy', key: 'reviewPurchased' },
  { header: 'Review: Feedback Detail Text', key: 'reviewFeedback' },
]

// Trivia Report columns
const triviaReportColumns: ReportColumn[] = [
  { header: 'Trivia Date', key: 'triviaDate' },
  { header: 'Trivia Question', key: 'question' },
  { header: 'Trivia Answer 1', key: 'answer1' },
  { header: 'Trivia Answer 2', key: 'answer2' },
  { header: 'Trivia Answer 3', key: 'answer3' },
  { header: 'Trivia Answer 4', key: 'answer4' },
  { header: 'Total Responses', key: 'totalResponses' },
  { header: 'Total Correct Responses', key: 'totalCorrect' },
  { header: 'Trivia Answer 1 # Responses', key: 'answer1Count' },
  { header: 'Trivia Answer 2 # Responses', key: 'answer2Count' },
  { header: 'Trivia Answer 3 # Responses', key: 'answer3Count' },
  { header: 'Trivia Answer 4 # Responses', key: 'answer4Count' },
  { header: 'Trivia Answer 1 % Responses', key: 'answer1Percent' },
  { header: 'Trivia Answer 2 % Responses', key: 'answer2Percent' },
  { header: 'Trivia Answer 3 % Responses', key: 'answer3Percent' },
  { header: 'Trivia Answer 4 % Responses', key: 'answer4Percent' },
  { header: 'Total Points Awarded', key: 'totalPointsAwarded' },
]

// Helper function to format date for display (MM/DD/YYYY). Optional appTimezone (IANA) formats in that zone.
const formatDate = (dateStr?: string, appTimezone?: string): string => {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return ''
  if (appTimezone) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: appTimezone,
      month: '2-digit',
      day: '2-digit',
      year: 'numeric',
    }).format(date)
  }
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const year = date.getFullYear()
  return `${month}/${day}/${year}`
}

/**
 * Format a date-only string (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss...) as MM/DD/YYYY using local calendar date.
 * Avoids UTC-midnight parsing so DOB and other date-only values display and sort correctly in all timezones.
 */
const formatDateOnly = (dateStr?: string): string => {
  if (!dateStr) return ''
  const match = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (match) {
    const [, y, m, d] = match
    const year = parseInt(y!, 10)
    const month = parseInt(m!, 10) - 1
    const day = parseInt(d!, 10)
    const date = new Date(year, month, day)
    if (isNaN(date.getTime())) return ''
    const monthStr = String(date.getMonth() + 1).padStart(2, '0')
    const dayStr = String(date.getDate()).padStart(2, '0')
    const yearStr = String(date.getFullYear())
    return `${monthStr}/${dayStr}/${yearStr}`
  }
  return formatDate(dateStr, undefined)
}

// Helper function to format date for reports (MM/DD/YYYY). Optional appTimezone (IANA) formats in that zone.
const formatDateForUpload = (dateStr?: string, appTimezone?: string): string => {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return ''
  if (appTimezone) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: appTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    const parts = formatter.formatToParts(date)
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
    return `${get('month')}/${get('day')}/${get('year')}`
  }
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const year = date.getFullYear()
  return `${month}/${day}/${year}`
}

// Helper function to format time for display (12-hour with AM/PM). Optional appTimezone (IANA) formats in that zone.
const formatTime = (timeStr?: string, appTimezone?: string): string => {
  if (!timeStr) return ''
  const date = new Date(timeStr)
  if (isNaN(date.getTime())) return ''
  if (appTimezone) {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: appTimezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(date)
  }
  const hours = date.getHours()
  const minutes = date.getMinutes()
  const ampm = hours >= 12 ? 'PM' : 'AM'
  const hour12 = hours % 12 || 12
  return `${hour12}:${String(minutes).padStart(2, '0')} ${ampm}`
}

// Helper function to format time for CSV upload (24-hour HH:MM format). Optional appTimezone (IANA) formats in that zone.
const formatTimeForUpload = (timeStr?: string, appTimezone?: string): string => {
  if (!timeStr) return ''
  const date = new Date(timeStr)
  if (isNaN(date.getTime())) return ''
  if (appTimezone) {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: appTimezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    return formatter.format(date)
  }
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

// Helper function to convert products array to string
const formatProducts = (products?: string[]): string => {
  if (!products || !Array.isArray(products)) return ''
  return products.join(', ')
}

/**
 * Resolve event display timezone:
 * prefer the timezone saved with the event, fallback to app timezone.
 */
const getEventDisplayTimezone = (
  event: EventDocument,
  appTimezone?: string
): string | undefined => {
  const eventTimezone = typeof event.timezone === 'string' ? event.timezone.trim() : ''
  return eventTimezone || appTimezone
}

/**
 * Normalize event products from API (array, comma-separated string, or alternate key).
 * DB may store as string or array; ensures Products column has data in report rows.
 */
function normalizeEventProducts(event: EventDocument & Record<string, unknown>): string[] {
  const raw = event.products ?? event['products']
  if (raw == null) return []
  if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === 'string').map((p) => p.trim()).filter(Boolean)
  if (typeof raw === 'string') return (raw as string).split(',').map((p) => p.trim()).filter((p) => p.length > 0)
  return [String(raw)]
}

// Replace characters jsPDF's default helvetica (WinAnsi) cannot render —
// notably emoji and supplementary-plane chars — so they don't appear as
// garbage bytes in exported PDFs (SAM-523). Each non-renderable codepoint
// (or surrogate pair) collapses to a single "?".
// eslint-disable-next-line no-misleading-character-class
const sanitizeForPdf = (text: string): string =>
  text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[^\x00-\xFF]/g, '?')

// Wrap long text at word boundaries so PDF table cells don't crop (max chars per line)
const wrapTextForPdf = (text: string, maxCharsPerLine = 35): string => {
  const safe = sanitizeForPdf(text)
  if (!safe || safe.length <= maxCharsPerLine) return safe
  const words = safe.split(/\s+/)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length <= maxCharsPerLine) {
      current = next
    } else {
      if (current) lines.push(current)
      current = word.length > maxCharsPerLine ? word.slice(0, maxCharsPerLine) : word
    }
  }
  if (current) lines.push(current)
  return lines.join('\n')
}

// Column keys that hold display dates (MM/DD/YYYY or YYYY-MM-DD) for sort order in exports
const SORT_DATE_COLUMN_KEYS = new Set(['dob', 'signUpDate', 'lastLoginDate', 'date', 'eventDate', 'signupDate'])
// Numeric columns that sort descending in export so order matches Preview Reports UI
const SORT_DESCENDING_NUMERIC_KEYS = new Set(['userPoints', 'checkInReviewPoints', 'checkIns', 'reviews', 'triviasWon', 'favorites', 'checkInPoints', 'reviewPoints', 'referralsCount'])

// Default sort key per report when the caller doesn't pass one. Points reports rank by points
// descending (winner first) instead of falling back to the first column (alphabetical by name),
// which matters for the "winner of the month" use case. Mirrored by Preview's defaultSortKeyByReport.
const DEFAULT_EXPORT_SORT_KEY: Partial<Record<ReportType, string>> = {
  'points-earned-all': 'userPoints',
  'points-earned-date-range': 'userPoints',
}

const parseSortableDate = (value: string | number): number => {
  if (value === '' || value === undefined || value === null) return NaN
  const str = String(value).trim()
  if (!str) return NaN
  const mmddyy = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (mmddyy) {
    const [, month, day, year] = mmddyy
    const d = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10))
    return isNaN(d.getTime()) ? NaN : d.getTime()
  }
  const d = new Date(str)
  return isNaN(d.getTime()) ? NaN : d.getTime()
}

/**
 * Sort rows for export so PDF/CSV match the Preview Reports sort (same key, direction, and tie-break).
 */
function sortReportRows(
  rows: Record<string, string | number>[],
  sortKey: string
): Record<string, string | number>[] {
  if (rows.length === 0) return rows
  const isDateColumn = SORT_DATE_COLUMN_KEYS.has(sortKey)
  const descendingNumeric = SORT_DESCENDING_NUMERIC_KEYS.has(sortKey)
  const withIndex = rows.map((row, i) => ({ row, i }))
  withIndex.sort(({ row: a, i: aIdx }, { row: b, i: bIdx }) => {
    const aValue = a[sortKey] ?? ''
    const bValue = b[sortKey] ?? ''
    let cmp = 0
    if (isDateColumn) {
      const aTime = parseSortableDate(aValue as string)
      const bTime = parseSortableDate(bValue as string)
      const aEmpty = isNaN(aTime)
      const bEmpty = isNaN(bTime)
      if (aEmpty && bEmpty) cmp = 0
      else if (aEmpty) cmp = 1
      else if (bEmpty) cmp = -1
      else cmp = aTime - bTime
    } else {
      const aNum = Number(aValue)
      const bNum = Number(bValue)
      if (!isNaN(aNum) && !isNaN(bNum)) {
        cmp = descendingNumeric ? bNum - aNum : aNum - bNum
      } else {
        cmp = String(aValue).localeCompare(String(bValue))
      }
    }
    if (cmp !== 0) return cmp
    const aUser = String(a.username ?? a.firstName ?? a[sortKey] ?? '')
    const bUser = String(b.username ?? b.firstName ?? b[sortKey] ?? '')
    const nameCmp = aUser.localeCompare(bUser)
    return nameCmp !== 0 ? nameCmp : aIdx - bIdx
  })
  return withIndex.map(({ row }) => row)
}

// Appwrite listDocuments returns max 25 by default. Fetch all users in pages for report consistency.
const REPORT_USERS_PAGE_SIZE = 100
const REPORT_LIST_PAGE_SIZE = 100
const REPORT_REVIEWS_PAGE_SIZE = 500
const EVENT_IDS_BATCH_SIZE = 25

/**
 * Check-in/Review Pts = sum of (event check-in points + review points) per user.
 * For each review: add event.checkInPoints + review.pointsEarned to that user's total.
 * When dateRange is provided, only reviews with $createdAt within the range are included.
 */
async function fetchCheckInReviewPointsByUser(
  dateRange?: { start: Date | null; end: Date | null }
): Promise<Map<string, number>> {
  const userTotals = new Map<string, number>()
  const reviewRows: { user?: string; event?: string; pointsEarned?: number }[] = []
  let offset = 0
  let docs: { user?: string; event?: string; pointsEarned?: number }[] = []

  do {
    const queries: string[] = [
      Query.limit(REPORT_REVIEWS_PAGE_SIZE),
      Query.offset(offset),
    ]
    if (dateRange?.start) {
      queries.push(Query.greaterThanEqual('$createdAt', dateRange.start.toISOString()))
    }
    if (dateRange?.end) {
      const endDate = new Date(dateRange.end)
      endDate.setHours(23, 59, 59, 999)
      queries.push(Query.lessThanEqual('$createdAt', endDate.toISOString()))
    }
    const result = await reviewsService.list(queries) as { documents: { user?: string; event?: string; pointsEarned?: number }[] }
    docs = result.documents ?? []
    reviewRows.push(...docs)
    offset += REPORT_REVIEWS_PAGE_SIZE
  } while (docs.length === REPORT_REVIEWS_PAGE_SIZE)

  const toId = (v: string | { $id?: string } | undefined): string | undefined =>
    v == null ? undefined : typeof v === 'string' ? v : (v as { $id?: string }).$id
  const eventIds = [...new Set(reviewRows.map((r) => toId(r.event)).filter(Boolean))] as string[]
  const eventPointsMap = new Map<string, number>()

  for (let i = 0; i < eventIds.length; i += EVENT_IDS_BATCH_SIZE) {
    const chunk = eventIds.slice(i, i + EVENT_IDS_BATCH_SIZE)
    const eventsResult = await eventsService.list([Query.equal('$id', chunk)]) as { documents: EventDocument[] }
    const events = eventsResult.documents ?? []
    for (const event of events) {
      const pts = (event.checkInPoints as number) ?? 0
      eventPointsMap.set(event.$id, pts)
    }
  }

  for (const r of reviewRows) {
    const userId = toId(r.user)
    if (!userId) continue
    const eventId = toId(r.event)
    const eventPts = (eventId ? eventPointsMap.get(eventId) : undefined) ?? 0
    const reviewPts = (typeof r.pointsEarned === 'number' ? r.pointsEarned : 0) ?? 0
    const add = eventPts + reviewPts
    userTotals.set(userId, (userTotals.get(userId) ?? 0) + add)
  }

  return userTotals
}

async function fetchAllAppUsers(
  dateRange?: { start: Date | null; end: Date | null }
): Promise<AppUser[]> {
  const all: AppUser[] = []
  let offset = 0
  let chunk: AppUser[]
  do {
    const queries: string[] = [
      Query.orderDesc('$createdAt'),
      Query.limit(REPORT_USERS_PAGE_SIZE),
      Query.offset(offset),
    ]
    if (dateRange?.start) {
      queries.push(Query.greaterThanEqual('$createdAt', dateRange.start.toISOString()))
    }
    if (dateRange?.end) {
      const endDate = new Date(dateRange.end)
      endDate.setHours(23, 59, 59, 999)
      queries.push(Query.lessThanEqual('$createdAt', endDate.toISOString()))
    }
    chunk = await appUsersService.list(queries)
    all.push(...chunk)
    offset += REPORT_USERS_PAGE_SIZE
  } while (chunk.length === REPORT_USERS_PAGE_SIZE)
  return all
}

function buildReferralsCountByCode(users: AppUser[]): Map<string, number> {
  const countByCode = new Map<string, number>()
  for (const user of users) {
    const usedCodeRaw = (user as Record<string, unknown>).usedReferralCode
    const usedCode = typeof usedCodeRaw === 'string' ? usedCodeRaw.trim() : ''
    if (!usedCode) continue
    countByCode.set(usedCode, (countByCode.get(usedCode) ?? 0) + 1)
  }
  return countByCode
}

/** Build a map of user ID -> count of trivia wins (correct answers). Fetches all trivia and responses in batches. */
async function fetchTriviasWonCountByUser(): Promise<Map<string, number>> {
  const correctIndexByTriviaId = new Map<string, number>()
  let offset = 0
  let chunk: TriviaDocument[]
  do {
    const listResult = await triviaService.list([
      Query.limit(REPORT_LIST_PAGE_SIZE),
      Query.offset(offset),
    ]) as { documents: TriviaDocument[] }
    chunk = listResult.documents
    for (const t of chunk) {
      if (t.$id != null && t.correctOptionIndex != null) {
        correctIndexByTriviaId.set(t.$id, Number(t.correctOptionIndex))
      }
    }
    offset += REPORT_LIST_PAGE_SIZE
  } while (chunk.length === REPORT_LIST_PAGE_SIZE)

  const countByUserId = new Map<string, number>()
  offset = 0
  let responseChunk: TriviaResponseDocument[]
  do {
    const listResult = await triviaResponsesService.list([
      Query.limit(REPORT_LIST_PAGE_SIZE),
      Query.offset(offset),
    ]) as { documents: TriviaResponseDocument[] }
    responseChunk = listResult.documents ?? []
    for (const r of responseChunk) {
      const tid = typeof r.trivia === 'string' ? r.trivia : (r.trivia as unknown as { $id?: string })?.$id
      const uid = typeof r.user === 'string' ? r.user : (r.user as unknown as { $id?: string })?.$id
      if (!uid || !tid) continue
      const correctIndex = correctIndexByTriviaId.get(tid)
      if (correctIndex === undefined) continue
      if (isCorrectTriviaResponse(r, correctIndex)) {
        countByUserId.set(uid, (countByUserId.get(uid) ?? 0) + 1)
      }
    }
    offset += REPORT_LIST_PAGE_SIZE
  } while (responseChunk.length === REPORT_LIST_PAGE_SIZE)

  return countByUserId
}

// Page sizes for the in-range points aggregation (Points Earned date-range report).
const REPORT_CHECKINS_PAGE_SIZE = 500
const REPORT_TRIVIA_RESPONSES_PAGE_SIZE = 500

/** Build the $createdAt window queries shared by all in-range record fetches. */
function createdAtRangeQueries(dateRange?: { start: Date | null; end: Date | null }): string[] {
  const queries: string[] = []
  if (dateRange?.start) {
    queries.push(Query.greaterThanEqual('$createdAt', dateRange.start.toISOString()))
  }
  if (dateRange?.end) {
    const endDate = new Date(dateRange.end)
    endDate.setHours(23, 59, 59, 999)
    queries.push(Query.lessThanEqual('$createdAt', endDate.toISOString()))
  }
  return queries
}

/**
 * Page through a collection's list endpoint, appending the given filter queries.
 * Uses cursor pagination (not offset) so it has no 5,000-row ceiling — the date-range
 * aggregation scans whole collections for a window and can exceed that. Mirrors the
 * mobile app's check-in pagination.
 */
async function listAllPaged<T extends { $id: string }>(
  service: { list: (queries?: string[]) => Promise<{ documents: T[] }> },
  filterQueries: string[],
  pageSize: number
): Promise<T[]> {
  const all: T[] = []
  let cursor: string | null = null
  for (;;) {
    const queries = [Query.limit(pageSize), ...filterQueries]
    if (cursor) queries.push(Query.cursorAfter(cursor))
    const result = await service.list(queries)
    const docs = result.documents ?? []
    all.push(...docs)
    if (docs.length < pageSize) break
    cursor = docs[docs.length - 1]!.$id
  }
  return all
}

/**
 * Map trivia id -> { correctOptionIndex, points } for scoring trivia responses.
 * Note: this uses each trivia's CURRENT answer key / points value, not a point-in-time
 * snapshot — consistent with the all-time fetchTriviasWonCountByUser. If an answer key is
 * edited after a reporting period, past responses are re-scored against the new key.
 */
async function fetchTriviaPointInfoById(): Promise<Map<string, TriviaPointInfo>> {
  const byId = new Map<string, TriviaPointInfo>()
  const triviaDocs = await listAllPaged<TriviaDocument>(triviaService, [], REPORT_LIST_PAGE_SIZE)
  for (const t of triviaDocs) {
    if (t.$id != null) {
      byId.set(t.$id, {
        correctOptionIndex: Number(t.correctOptionIndex),
        points: Number(t.points) || 0,
      })
    }
  }
  return byId
}

/**
 * Points earned per user within a date range, summed from dated records:
 * check-ins (checkins.points) + reviews (reviews.pointsEarned) + trivia wins (trivia.points).
 * Used by the "Points Earned (Date Range)" report so the ranking reflects the selected window
 * rather than the lifetime user_profiles.totalPoints. Referral / signup / badge / birthday
 * bonuses are intentionally excluded — they have no dated record to attribute to a window.
 */
async function fetchPointsEarnedInRangeByUser(
  dateRange?: { start: Date | null; end: Date | null }
): Promise<Map<string, PointsEarnedBreakdown>> {
  const filterQueries = createdAtRangeQueries(dateRange)
  const [checkins, reviews, triviaResponses, triviaById] = await Promise.all([
    listAllPaged<CheckinDocument>(checkinsService, filterQueries, REPORT_CHECKINS_PAGE_SIZE),
    listAllPaged<ReviewDocument>(reviewsService, filterQueries, REPORT_REVIEWS_PAGE_SIZE),
    listAllPaged<TriviaResponseDocument>(triviaResponsesService, filterQueries, REPORT_TRIVIA_RESPONSES_PAGE_SIZE),
    fetchTriviaPointInfoById(),
  ])
  return aggregatePointsEarnedInRange({ checkins, reviews, triviaResponses, triviaById })
}

/** Sort Points-report rows by userPoints desc; stable tie-break by username then original index. */
function sortPointsRowsByUserPointsDesc(rows: Record<string, string | number>[]): void {
  const withIndex = rows.map((row, i) => ({ row, i }))
  withIndex.sort(({ row: a, i: aIdx }, { row: b, i: bIdx }) => {
    const aPoints = parseInt(a.userPoints as string) || 0
    const bPoints = parseInt(b.userPoints as string) || 0
    if (bPoints !== aPoints) return bPoints - aPoints
    const nameCmp = String(a.username ?? '').localeCompare(String(b.username ?? ''))
    return nameCmp !== 0 ? nameCmp : aIdx - bIdx
  })
  rows.length = 0
  rows.push(...withIndex.map(({ row }) => row))
}

// Export Service
export const exportService = {
  /**
   * Generate report data based on report type.
   * @param appTimezone - Optional IANA timezone (e.g. America/New_York) for formatting dates/times in exports.
   */
  async generateReportData(
    reportType: ReportType,
    dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string
  ): Promise<{ columns: ReportColumn[]; rows: Record<string, string | number>[] }> {
    switch (reportType) {
      case 'dashboard-all':
      case 'dashboard-date-range':
        return await this.generateDashboardReport(dateRange, appTimezone)
      
      case 'event-list':
        return await this.generateEventListReport(dateRange, appTimezone)
      
      case 'clients-brands':
        return await this.generateClientsBrandsReport(dateRange, appTimezone)
      
      case 'app-users':
        return await this.generateAppUsersReport(dateRange, appTimezone)
      
      case 'points-earned-all':
        return await this.generatePointsEarnedReport(dateRange, false, appTimezone)
      case 'points-earned-date-range':
        return await this.generatePointsEarnedReport(dateRange, true, appTimezone)
      
      case 'event-recap':
        return await this.generateEventRecapReport(dateRange, appTimezone)
      
      case 'trivia-report':
        return await this.generateTriviaReport(dateRange, appTimezone)
      
      case 'custom':
        // Custom reports should use generateCustomReport directly
        return { columns: [], rows: [] }

      default:
        throw new Error(`Unknown report type: ${reportType}`)
    }
  },

  /**
   * Generate Dashboard report
   */
  async generateDashboardReport(
    dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string
  ): Promise<{ columns: ReportColumn[]; rows: Record<string, string | number>[] }> {
    const baseQueries: string[] = [
      Query.equal('isArchived', false), // Only active events
      Query.orderDesc('date'),
    ]

    // Apply date range filter if provided
    if (dateRange?.start) {
      baseQueries.push(Query.greaterThanEqual('date', dateRange.start.toISOString()))
    }
    if (dateRange?.end) {
      const endDate = new Date(dateRange.end)
      endDate.setHours(23, 59, 59, 999)
      baseQueries.push(Query.lessThanEqual('date', endDate.toISOString()))
    }

    // Paginate to fetch all events in range (Appwrite default limit is 25)
    const allDocuments: EventDocument[] = []
    let offset = 0
    let chunk: EventDocument[]
    do {
      const queries = [...baseQueries, Query.limit(REPORT_LIST_PAGE_SIZE), Query.offset(offset)]
      const eventsResult = await eventsService.list(queries)
      chunk = (eventsResult.documents ?? []) as EventDocument[]
      allDocuments.push(...chunk)
      offset += REPORT_LIST_PAGE_SIZE
    } while (chunk.length === REPORT_LIST_PAGE_SIZE)

    // Map events to report rows (Products column populated via normalizeEventProducts)
    const rows = await Promise.all(
      allDocuments.map(async (event: EventDocument & Record<string, unknown>) => {
        const eventTimezone = getEventDisplayTimezone(event, appTimezone)
        let brandName = ''
        if (event.client) {
          try {
            const client = await clientsService.getById(event.client)
            brandName = client.name || ''
          } catch (err) {
            console.error('Error fetching client for event:', err)
          }
        }

        const productsArray = normalizeEventProducts(event)
        const hasDiscount = (event.discount != null && String(event.discount).trim() !== '') ||
          (event.discountImageURL != null && String(event.discountImageURL).trim() !== '')
        return {
          date: formatDate(event.startTime || event.date, eventTimezone),
          venueName: event.name || '',
          brand: brandName,
          startTime: formatTime(event.startTime, eventTimezone),
          endTime: formatTime(event.endTime, eventTimezone),
          products: formatProducts(productsArray),
          discount: hasDiscount ? 'YES' : 'NO',
          timeZone: eventTimezone ? getAppTimezoneShortLabel(eventTimezone) : '',
        }
      })
    )

    return {
      columns: dashboardColumns,
      rows,
    }
  },

  /**
   * Generate Event List report.
   * When dateRange is provided, filters events by event date (single day or range; future dates allowed).
   */
  async generateEventListReport(
    dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string
  ): Promise<{ columns: ReportColumn[]; rows: Record<string, string | number>[] }> {
    const queries: string[] = [
      Query.orderDesc('date'),
    ]
    if (dateRange?.start) {
      queries.push(Query.greaterThanEqual('date', dateRange.start.toISOString()))
    }
    if (dateRange?.end) {
      const endDate = new Date(dateRange.end)
      endDate.setHours(23, 59, 59, 999)
      queries.push(Query.lessThanEqual('date', endDate.toISOString()))
    }

    // Fetch all events in pages so report includes full list, not Appwrite's default first page.
    const allEvents: EventDocument[] = []
    let offset = 0
    let chunk: EventDocument[]
    do {
      const pageResult = await eventsService.list([
        ...queries,
        Query.limit(REPORT_LIST_PAGE_SIZE),
        Query.offset(offset),
      ])
      chunk = (pageResult.documents ?? []) as EventDocument[]
      allEvents.push(...chunk)
      offset += REPORT_LIST_PAGE_SIZE
    } while (chunk.length === REPORT_LIST_PAGE_SIZE)

    // Build a lookup of saved Locations by normalized address fields.
    // Many events do not persist locationId, so we recover location name via address/city/state/zip match.
    const locationsByAddressKey = new Map<string, string>()
    try {
      const allLocations: Array<{ name?: string; address?: string; city?: string; state?: string; zipCode?: string }> = []
      let offset = 0
      let locationChunk: Array<{ name?: string; address?: string; city?: string; state?: string; zipCode?: string }> = []
      do {
        const result = await locationsService.list([
          Query.limit(REPORT_LIST_PAGE_SIZE),
          Query.offset(offset),
        ])
        locationChunk = (result.documents ?? []) as Array<{ name?: string; address?: string; city?: string; state?: string; zipCode?: string }>
        allLocations.push(...locationChunk)
        offset += REPORT_LIST_PAGE_SIZE
      } while (locationChunk.length === REPORT_LIST_PAGE_SIZE)

      const toPart = (value?: string): string => (value ?? '').trim().toLowerCase()
      const toKey = (address?: string, city?: string, state?: string, zip?: string): string =>
        `${toPart(address)}|${toPart(city)}|${toPart(state)}|${toPart(zip)}`

      for (const location of allLocations) {
        const key = toKey(location.address, location.city, location.state, location.zipCode)
        if (!locationsByAddressKey.has(key) && location.name?.trim()) {
          locationsByAddressKey.set(key, location.name.trim())
        }
      }
    } catch (err) {
      console.error('Error fetching locations for event list report:', err)
    }
    
    // Map events to report rows
    const rows = await Promise.all(
      allEvents.map(async (event: EventDocument) => {
        const eventTimezone = getEventDisplayTimezone(event, appTimezone)
        let brandName = ''
        if (event.client) {
          try {
            const client = await clientsService.getById(event.client)
            brandName = client.name || ''
          } catch (err) {
            console.error('Error fetching client for event:', err)
          }
        }

        // Resolve category ID to category title (Product Type column)
        let productType = ''
        if (event.categories) {
          try {
            const category = await categoriesService.getById(event.categories)
            productType = category?.title || ''
          } catch (err) {
            console.error('Error fetching category for event:', err)
          }
        }

        // Resolve linked Location document values first, then fallback to event fields.
        // Report mapping: Address=street address, Location=location name.
        let locationName = ''
        let resolvedAddress = event.address || ''
        let resolvedCity = event.city || ''
        let resolvedState = event.state || ''
        let resolvedZip = event.zipCode || ''
        const toPart = (value?: string): string => (value ?? '').trim().toLowerCase()
        const eventAddressKey = `${toPart(resolvedAddress)}|${toPart(resolvedCity)}|${toPart(resolvedState)}|${toPart(resolvedZip)}`
        const locationId = (event as EventDocument & { locationId?: string }).locationId
        if (locationId) {
          try {
            const location = await locationsService.getById(locationId)
            locationName = location?.name || ''
            if (!resolvedAddress) resolvedAddress = location?.address || ''
            if (!resolvedCity) resolvedCity = location?.city || ''
            if (!resolvedState) resolvedState = location?.state || ''
            if (!resolvedZip) resolvedZip = location?.zipCode || ''
          } catch (err) {
            console.error('Error fetching location for event:', err)
          }
        }
        if (!locationName) {
          locationName = locationsByAddressKey.get(eventAddressKey) || ''
        }

        // Normalize products: DB may store array or comma-separated string
        const productsArray = Array.isArray(event.products)
          ? event.products
          : event.products
            ? typeof event.products === 'string'
              ? (event.products as string).split(',').map((p: string) => p.trim()).filter((p: string) => p.length > 0)
              : [event.products as unknown as string]
            : []

        const hasDiscountImage = event.discountImageURL != null && String(event.discountImageURL).trim() !== ''

        return {
          name: event.name || '',
          brandName,
          eventDate: formatDateForUpload(event.startTime || event.date, eventTimezone),
          startTime: formatTimeForUpload(event.startTime, eventTimezone),
          endTime: formatTimeForUpload(event.endTime, eventTimezone),
          address: resolvedAddress,
          city: resolvedCity,
          state: resolvedState,
          zip: resolvedZip,
          productType,
          products: formatProducts(productsArray),
          eventInfo: event.eventInfo || '',
          discountText: event.discount?.toString() || '',
          discountImageFile: hasDiscountImage ? 'Yes' : 'No',
          checkInCode: event.checkInCode || '',
          checkInPoints: event.checkInPoints?.toString() || '0',
          reviewPoints: event.reviewPoints?.toString() || '0',
          location: locationName,
          timeZone: eventTimezone ? getAppTimezoneShortLabel(eventTimezone) : '',
        }
      })
    )

    return {
      columns: eventListColumns,
      rows,
    }
  },

  /**
   * Generate Clients & Brands report.
   * When dateRange is provided, filters clients by signup date ($createdAt).
   * # of Favorites = count of users who have any of the client's events in their favorites.
   */
  async generateClientsBrandsReport(
    dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string
  ): Promise<{ columns: ReportColumn[]; rows: Record<string, string | number>[] }> {
    const queries: string[] = [Query.orderDesc('$createdAt')]
    if (dateRange?.start) {
      queries.push(Query.greaterThanEqual('$createdAt', dateRange.start.toISOString()))
    }
    if (dateRange?.end) {
      const endDate = new Date(dateRange.end)
      endDate.setHours(23, 59, 59, 999)
      queries.push(Query.lessThanEqual('$createdAt', endDate.toISOString()))
    }

    const clientsResult = await clientsService.list(queries)
    const documents = (clientsResult?.documents ?? []) as ClientDocument[]
    const clientIds = documents.map((c) => (c as { $id?: string }).$id).filter((id): id is string => !!id)

    const statsMap = clientIds.length > 0
      ? await clientsService.getClientsStats(clientIds)
      : new Map<string, { totalEvents: number; totalFavorites: number; totalCheckIns: number; totalPoints: number }>()

    const rows = documents.map((client: ClientDocument) => {
      const clientId = (client as { $id?: string }).$id
      const stats = clientId ? statsMap.get(clientId) : undefined
      const totalFavorites = stats?.totalFavorites ?? 0
      return {
        name: client.name || '',
        logoFile: client.logoURL ? 'Yes' : 'No',
        signupDate: formatDate(client.$createdAt, appTimezone),
        productType: formatProducts(client.productType),
        favorites: String(totalFavorites),
      }
    })

    return {
      columns: clientsBrandsColumns,
      rows,
    }
  },

  /**
   * Generate App Users report.
   * "App Users (All)" shows all users regardless of date range; date range is ignored for this report.
   */
  async generateAppUsersReport(
    _dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string
  ): Promise<{ columns: ReportColumn[]; rows: Record<string, string | number>[] }> {
    const [usersResult, checkInReviewPointsByUser, triviasWonByUser] = await Promise.all([
      fetchAllAppUsers(),
      fetchCheckInReviewPointsByUser(), // all-time check-in pts + review pts per user
      fetchTriviasWonCountByUser(),
    ])
    const referralsCountByCode = buildReferralsCountByCode(usersResult)

    const rows = usersResult.map((user: AppUser) => {
      const userRecord = user as Record<string, unknown>
      const userId = (user as { $id?: string }).$id

      // Map user_profiles fields to report columns
      // totalPoints = total points earned by user
      // totalReviews = number of reviews submitted
      // totalEvents = number of check-ins (events attended)
      // isAmbassador = BA Badge status
      // isInfluencer = Influencer Badge status
      const totalPoints = (userRecord.totalPoints as number) ?? (userRecord.userPoints as number) ?? 0
      const totalReviews = (userRecord.totalReviews as number) ?? (userRecord.reviews as number) ?? 0
      const totalEvents = (userRecord.totalEvents as number) ?? (userRecord.checkIns as number) ?? 0
      const isAmbassador = (userRecord.isAmbassador as boolean) ?? (userRecord.baBadge as boolean) ?? false
      const isInfluencer = (userRecord.isInfluencer as boolean) ?? (userRecord.influencerBadge as boolean) ?? false
      // Check-in/Review Pts = sum of (event check-in points + review points) per user
      const checkInReviewPoints =
        (userId ? checkInReviewPointsByUser.get(userId) : undefined) ??
        (userRecord.checkInReviewPoints as number) ??
        0
      // Trivias Won = actual count from trivia_responses (correct answers), fallback to stored value
      const triviasWon = (userId ? triviasWonByUser.get(userId) : undefined) ?? (userRecord.triviasWon as number) ?? 0
      const referralCode = (userRecord.referralCode as string) || ''
      const referralsCount = referralCode ? (referralsCountByCode.get(referralCode) ?? 0) : 0

      // Determine tier level based on totalPoints if not explicitly set
      let tierLevel = (userRecord.tierLevel as string) || ''
      if (!tierLevel && totalPoints > 0) {
        if (totalPoints >= 1000) tierLevel = 'ProSampler'
        else if (totalPoints >= 500) tierLevel = 'Sampler'
        else tierLevel = 'NewbieSampler'
      } else if (!tierLevel) {
        tierLevel = 'NewbieSampler'
      }

      return {
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        username: (userRecord.username as string) || '',
        email: user.email || '',
        phoneNumber: (userRecord.phoneNumber as string) || '',
        dob: formatDateOnly(userRecord.dob as string | undefined),
        signUpDate: formatDate(user.$createdAt, appTimezone),
        lastLoginDate: formatDate(user.lastLoginDate, appTimezone),
        referralCode,
        referralsCount: referralsCount.toString(),
        userPoints: totalPoints.toString(),
        checkInReviewPoints: checkInReviewPoints.toString(),
        baBadge: isAmbassador ? 'Yes' : 'No',
        influencerBadge: isInfluencer ? 'Yes' : 'No',
        tierLevel: tierLevel,
        checkIns: totalEvents.toString(),
        reviews: totalReviews.toString(),
        triviasWon: triviasWon.toString(),
      }
    })

    return {
      columns: appUsersColumns,
      rows,
    }
  },

  /**
   * Generate Event Recap report
   * Shows detailed event participation data including check-ins and reviews
   * Optimized version with batch fetching
   */
  async generateEventRecapReport(
    dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string
  ): Promise<{ columns: ReportColumn[]; rows: Record<string, string | number>[] }> {
    const queries: string[] = [Query.orderDesc('date')]
    
    // Apply date range filter if provided
    if (dateRange?.start) {
      queries.push(Query.greaterThanEqual('date', dateRange.start.toISOString()))
    }
    if (dateRange?.end) {
      const endDate = new Date(dateRange.end)
      endDate.setHours(23, 59, 59, 999)
      queries.push(Query.lessThanEqual('date', endDate.toISOString()))
    }

    // Fetch all events in range
    const allEvents: EventDocument[] = []
    let offset = 0
    let chunk: EventDocument[]
    do {
      const pageResult = await eventsService.list([
        ...queries,
        Query.limit(REPORT_LIST_PAGE_SIZE),
        Query.offset(offset),
      ])
      chunk = (pageResult.documents ?? []) as EventDocument[]
      allEvents.push(...chunk)
      offset += REPORT_LIST_PAGE_SIZE
    } while (chunk.length === REPORT_LIST_PAGE_SIZE)

    if (allEvents.length === 0) {
      return { columns: eventRecapColumns, rows: [] }
    }

    // Batch fetch all related data
    const eventIds = allEvents.map(e => e.$id)
    const clientIds = [...new Set(allEvents.filter(e => e.client).map(e => e.client!))]
    const categoryIds = [...new Set(allEvents.filter(e => e.categories).map(e => e.categories!))]
    
    // Fetch all clients and categories in batches
    const clientsMap = new Map<string, string>()
    const categoriesMap = new Map<string, string>()
    
    // Batch fetch clients (max 25 at a time due to Appwrite limits)
    for (let i = 0; i < clientIds.length; i += 25) {
      const batch = clientIds.slice(i, i + 25)
      try {
        const result = await clientsService.list([Query.equal('$id', batch)])
        for (const client of result.documents ?? []) {
          clientsMap.set(client.$id, client.name || '')
        }
      } catch (err) {
        console.error('Error batch fetching clients:', err)
      }
    }

    // Batch fetch categories
    for (let i = 0; i < categoryIds.length; i += 25) {
      const batch = categoryIds.slice(i, i + 25)
      try {
        const result = await categoriesService.list([Query.equal('$id', batch)])
        for (const category of result.documents ?? []) {
          categoriesMap.set(category.$id, category.title || '')
        }
      } catch (err) {
        console.error('Error batch fetching categories:', err)
      }
    }

    // Fetch ALL reviews for ALL events in a single pass
    const allReviews: ReviewDocument[] = []
    const reviewsByEventId = new Map<string, ReviewDocument[]>()
    
    // Initialize map with empty arrays
    eventIds.forEach(id => reviewsByEventId.set(id, []))
    
    // Fetch reviews for all events at once (in batches if needed)
    for (let i = 0; i < eventIds.length; i += 10) {
      const eventBatch = eventIds.slice(i, i + 10)
      let reviewOffset = 0
      let reviewChunk: ReviewDocument[]
      
      do {
        const result = await reviewsService.list([
          Query.equal('event', eventBatch),
          Query.limit(500),
          Query.offset(reviewOffset),
        ])
        reviewChunk = result.documents ?? []
        allReviews.push(...reviewChunk)
        reviewOffset += 500
      } while (reviewChunk.length === 500)
    }
    
    // Group reviews by event
    for (const review of allReviews) {
      const eventId = review.event as string
      if (eventId && reviewsByEventId.has(eventId)) {
        reviewsByEventId.get(eventId)!.push(review)
      }
    }

    // Collect all unique user IDs from reviews
    const userIds = [...new Set(allReviews.filter(r => r.user).map(r => r.user as string))]
    
    // Batch fetch all users
    const usersMap = new Map<string, { firstName: string; lastName: string; username: string }>()
    for (let i = 0; i < userIds.length; i += 25) {
      const batch = userIds.slice(i, i + 25)
      try {
        const result = await appUsersService.list([Query.equal('$id', batch)])
        for (const user of result) {
          const userRecord = user as Record<string, unknown>
          usersMap.set((user as { $id?: string }).$id!, {
            firstName: user.firstname || '',
            lastName: user.lastname || '',
            username: userRecord.username as string || ''
          })
        }
      } catch (err) {
        console.error('Error batch fetching users:', err)
      }
    }

    // Build rows using cached data
    const rows: Record<string, string | number>[] = []
    
    for (const event of allEvents) {
      const eventTimezone = getEventDisplayTimezone(event, appTimezone)
      const brandName = event.client ? (clientsMap.get(event.client) || '') : ''
      const productType = event.categories ? (categoriesMap.get(event.categories) || '') : ''
      const eventReviews = reviewsByEventId.get(event.$id) || []

      if (eventReviews.length === 0) {
        // No reviews for this event
        rows.push({
          eventName: event.name || '',
          checkInCode: event.checkInCode || '',
          brandName,
          eventDate: formatDateForUpload(event.startTime || event.date, eventTimezone),
          productType,
          firstName: '',
          lastName: '',
          username: '',
          checkIn: 'No',
          hasReview: 'No',
          reviewStars: '',
          reviewLiked: '',
          reviewPurchased: '',
          reviewFeedback: '',
        })
      } else {
        // Create a row for each review
        for (const review of eventReviews) {
          const userData = review.user ? usersMap.get(review.user as string) : undefined
          
          // Format "liked" field
          const liked = review.liked
          const likedItems: string[] = Array.isArray(liked)
            ? (liked as string[]).map((s) => String(s).trim()).filter(Boolean)
            : liked != null
              ? String(liked).split(',').map((s) => s.trim()).filter(Boolean)
              : []
          const likedDisplay = likedItems.length > 0
            ? likedItems.map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join(', ')
            : ''

          rows.push({
            eventName: event.name || '',
            checkInCode: event.checkInCode || '',
            brandName,
            eventDate: formatDateForUpload(event.startTime || event.date, eventTimezone),
            productType,
            firstName: userData?.firstName || '',
            lastName: userData?.lastName || '',
            username: userData?.username || '',
            checkIn: 'Yes',
            hasReview: 'Yes',
            reviewStars: review.rating?.toString() || '0',
            reviewLiked: likedDisplay,
            reviewPurchased: review.hasPurchased ? 'Yes' : 'No',
            reviewFeedback: review.review || '',
          })
        }
      }
    }

    return {
      columns: eventRecapColumns,
      rows,
    }
  },

  /**
   * Generate Trivia Report
   * Shows trivia questions performance analytics
   * Optimized version with batch fetching
   */
  async generateTriviaReport(
    dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string
  ): Promise<{ columns: ReportColumn[]; rows: Record<string, string | number>[] }> {
    const queries: string[] = [Query.orderDesc('startDate')]
    
    // Apply date range filter if provided
    if (dateRange?.start) {
      queries.push(Query.greaterThanEqual('startDate', dateRange.start.toISOString()))
    }
    if (dateRange?.end) {
      const endDate = new Date(dateRange.end)
      endDate.setHours(23, 59, 59, 999)
      queries.push(Query.lessThanEqual('startDate', endDate.toISOString()))
    }

    // Fetch all trivia questions in range
    const allTrivia: TriviaDocument[] = []
    let offset = 0
    let chunk: TriviaDocument[]
    do {
      const result = await triviaService.list([
        ...queries,
        Query.limit(REPORT_LIST_PAGE_SIZE),
        Query.offset(offset),
      ])
      chunk = (result.documents ?? []) as TriviaDocument[]
      allTrivia.push(...chunk)
      offset += REPORT_LIST_PAGE_SIZE
    } while (chunk.length === REPORT_LIST_PAGE_SIZE)

    if (allTrivia.length === 0) {
      return { columns: triviaReportColumns, rows: [] }
    }

    const triviaIds = allTrivia.map(t => t.$id)
    
    // Fetch ALL responses for ALL trivia in batches
    const allResponses: TriviaResponseDocument[] = []
    const responsesByTriviaId = new Map<string, TriviaResponseDocument[]>()
    
    // Initialize map with empty arrays
    triviaIds.forEach(id => responsesByTriviaId.set(id, []))
    
    // Batch fetch responses (fetch multiple trivia IDs at once)
    for (let i = 0; i < triviaIds.length; i += 10) {
      const triviaBatch = triviaIds.slice(i, i + 10)
      let responseOffset = 0
      let responseChunk: TriviaResponseDocument[]
      
      do {
        const result = await triviaResponsesService.list([
          Query.equal('trivia', triviaBatch),
          Query.limit(500),
          Query.offset(responseOffset),
        ])
        responseChunk = (result.documents ?? []) as TriviaResponseDocument[]
        allResponses.push(...responseChunk)
        responseOffset += 500
      } while (responseChunk.length === 500)
    }
    
    // Group responses by trivia ID
    for (const response of allResponses) {
      const triviaId = typeof response.trivia === 'string' 
        ? response.trivia 
        : (response.trivia as unknown as { $id?: string })?.$id
      
      if (triviaId && responsesByTriviaId.has(triviaId)) {
        responsesByTriviaId.get(triviaId)!.push(response)
      }
    }

    // Build rows using cached data
    const rows: Record<string, string | number>[] = []

    for (const trivia of allTrivia) {
      // Get all answers with defaults for missing ones
      const answers = trivia.answers || []
      const answer1 = answers[0] || ''
      const answer2 = answers[1] || ''
      const answer3 = answers[2] || ''
      const answer4 = answers[3] || ''

      // Get responses for this trivia from cache
      const triviaResponses = responsesByTriviaId.get(trivia.$id) || []

      // Calculate statistics
      const totalResponses = triviaResponses.length
      const correctIndex = trivia.correctOptionIndex
      let totalCorrect = 0
      const answerCounts = [0, 0, 0, 0]

      for (const response of triviaResponses) {
        const selectedIndex = Number(response.answerIndex)
        if (selectedIndex >= 0 && selectedIndex < 4) {
          answerCounts[selectedIndex]++
          if (selectedIndex === correctIndex) {
            totalCorrect++
          }
        }
      }

      // Calculate percentages
      const calculatePercent = (count: number): string => {
        if (totalResponses === 0) return '0%'
        return `${Math.round((count / totalResponses) * 100)}%`
      }

      // Calculate total points awarded (correct answers × points per trivia)
      const pointsPerTrivia = trivia.points || 0
      const totalPointsAwarded = totalCorrect * pointsPerTrivia

      rows.push({
        triviaDate: formatDateForUpload(trivia.startDate, appTimezone),
        question: trivia.question || '',
        answer1,
        answer2,
        answer3,
        answer4,
        totalResponses: totalResponses.toString(),
        totalCorrect: totalCorrect.toString(),
        answer1Count: answerCounts[0].toString(),
        answer2Count: answerCounts[1].toString(),
        answer3Count: answerCounts[2].toString(),
        answer4Count: answerCounts[3].toString(),
        answer1Percent: calculatePercent(answerCounts[0]),
        answer2Percent: calculatePercent(answerCounts[1]),
        answer3Percent: calculatePercent(answerCounts[2]),
        answer4Percent: calculatePercent(answerCounts[3]),
        totalPointsAwarded: totalPointsAwarded.toString(),
      })
    }

    return {
      columns: triviaReportColumns,
      rows,
    }
  },

  /**
   * Generate Custom Report with selected columns
   * Dynamically fetches and combines data based on selected columns
   */
  async generateCustomReport(
    entityType: EntityType,
    selectedColumnKeys: string[],
    dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string
  ): Promise<{ columns: ReportColumn[]; rows: Record<string, string | number>[] }> {
    const selectedColumns = getColumnsByKeys(selectedColumnKeys)
    const columns: ReportColumn[] = selectedColumns.map(col => ({
      header: col.header,
      key: col.key,
    }))

    // Determine which data sources we need
    const needsEvents = selectedColumns.some(col => col.dataSource.includes('events'))
    const needsUsers = selectedColumns.some(col => col.dataSource.includes('users'))
    const needsClients = selectedColumns.some(col => col.dataSource.includes('clients'))
    const needsReviews = selectedColumns.some(col => col.dataSource.includes('reviews'))
    const needsTrivia = selectedColumns.some(col => col.dataSource.includes('trivia'))
    const needsLocations = selectedColumns.some(col => col.dataSource.includes('locations'))

    const rows: Record<string, string | number>[] = []

    // For named entities, route to the matching fetcher.
    // For 'all', pick a single primary fetcher whose joins can populate every
    // selected column. Concatenating rows from multiple fetchers (the previous
    // behavior) produced rows with mismatched columns — see SAM-523.
    if (entityType === 'all') {
      // Reviews fetcher already joins user + event (+ client/category for
      // brand/product), so prefer it whenever review-side columns are needed.
      if (needsReviews) {
        const reviewRows = await this.fetchReviewDataForCustomReport(
          selectedColumnKeys,
          dateRange,
          appTimezone
        )
        rows.push(...reviewRows)
      } else if (needsEvents) {
        const eventRows = await this.fetchEventDataForCustomReport(
          selectedColumnKeys,
          dateRange,
          appTimezone,
          { needsClients, needsReviews, needsLocations }
        )
        rows.push(...eventRows)
      } else if (needsTrivia) {
        const triviaRows = await this.fetchTriviaDataForCustomReport(
          selectedColumnKeys,
          dateRange,
          appTimezone
        )
        rows.push(...triviaRows)
      } else if (needsUsers) {
        const userRows = await this.fetchUserDataForCustomReport(
          selectedColumnKeys,
          dateRange,
          appTimezone
        )
        rows.push(...userRows)
      } else if (needsClients) {
        const clientRows = await this.fetchClientDataForCustomReport(
          selectedColumnKeys,
          dateRange,
          appTimezone
        )
        rows.push(...clientRows)
      }
    } else if (entityType === 'events') {
      const eventRows = await this.fetchEventDataForCustomReport(
        selectedColumnKeys,
        dateRange,
        appTimezone,
        { needsClients, needsReviews, needsLocations }
      )
      rows.push(...eventRows)
    } else if (entityType === 'users') {
      const userRows = await this.fetchUserDataForCustomReport(
        selectedColumnKeys,
        dateRange,
        appTimezone
      )
      rows.push(...userRows)
    } else if (entityType === 'clients') {
      const clientRows = await this.fetchClientDataForCustomReport(
        selectedColumnKeys,
        dateRange,
        appTimezone
      )
      rows.push(...clientRows)
    } else if (entityType === 'reviews') {
      const reviewRows = await this.fetchReviewDataForCustomReport(
        selectedColumnKeys,
        dateRange,
        appTimezone
      )
      rows.push(...reviewRows)
    } else if (entityType === 'trivia') {
      const triviaRows = await this.fetchTriviaDataForCustomReport(
        selectedColumnKeys,
        dateRange,
        appTimezone
      )
      rows.push(...triviaRows)
    }

    return { columns, rows }
  },

  // Helper method for fetching event data for custom reports
  async fetchEventDataForCustomReport(
    columnKeys: string[],
    dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string,
    options?: { needsClients?: boolean; needsReviews?: boolean; needsLocations?: boolean }
  ): Promise<Record<string, string | number>[]> {
    const queries: string[] = [Query.orderDesc('date')]
    if (dateRange?.start) {
      queries.push(Query.greaterThanEqual('date', dateRange.start.toISOString()))
    }
    if (dateRange?.end) {
      const endDate = new Date(dateRange.end)
      endDate.setHours(23, 59, 59, 999)
      queries.push(Query.lessThanEqual('date', endDate.toISOString()))
    }

    // Fetch events
    const allEvents: EventDocument[] = []
    let offset = 0
    let chunk: EventDocument[]
    do {
      const result = await eventsService.list([
        ...queries,
        Query.limit(REPORT_LIST_PAGE_SIZE),
        Query.offset(offset),
      ])
      chunk = (result.documents ?? []) as EventDocument[]
      allEvents.push(...chunk)
      offset += REPORT_LIST_PAGE_SIZE
    } while (chunk.length === REPORT_LIST_PAGE_SIZE)

    if (allEvents.length === 0) return []

    // Prepare caches
    const clientsMap = new Map<string, ClientDocument>()
    const categoriesMap = new Map<string, string>()

    // Batch fetch related data if needed
    if (options?.needsClients && columnKeys.includes('clientName')) {
      const clientIds = [...new Set(allEvents.filter(e => e.client).map(e => e.client!))]
      for (let i = 0; i < clientIds.length; i += 25) {
        const batch = clientIds.slice(i, i + 25)
        try {
          const result = await clientsService.list([Query.equal('$id', batch)])
          for (const client of result.documents ?? []) {
            clientsMap.set(client.$id, client)
          }
        } catch (err) {
          console.error('Error fetching clients:', err)
        }
      }
    }

    if (columnKeys.includes('productType')) {
      const categoryIds = [...new Set(allEvents.filter(e => e.categories).map(e => e.categories!))]
      for (let i = 0; i < categoryIds.length; i += 25) {
        const batch = categoryIds.slice(i, i + 25)
        try {
          const result = await categoriesService.list([Query.equal('$id', batch)])
          for (const category of result.documents ?? []) {
            categoriesMap.set(category.$id, category.title || '')
          }
        } catch (err) {
          console.error('Error fetching categories:', err)
        }
      }
    }

    // Build rows
    const rows: Record<string, string | number>[] = []
    for (const event of allEvents) {
      const eventTimezone = getEventDisplayTimezone(event, appTimezone)
      const row: Record<string, string | number> = {}

      columnKeys.forEach(key => {
        switch (key) {
          case 'eventName':
            row[key] = event.name || ''
            break
          case 'eventDate':
            row[key] = formatDateForUpload(event.startTime || event.date, eventTimezone)
            break
          case 'startTime':
            row[key] = formatTimeForUpload(event.startTime, eventTimezone)
            break
          case 'endTime':
            row[key] = formatTimeForUpload(event.endTime, eventTimezone)
            break
          case 'checkInCode':
            row[key] = event.checkInCode || ''
            break
          case 'checkInPoints':
            row[key] = event.checkInPoints || 0
            break
          case 'reviewPoints':
            row[key] = event.reviewPoints || 0
            break
          case 'clientName': {
            const client = event.client ? clientsMap.get(event.client) : undefined
            row[key] = client?.name || ''
            break
          }
          case 'productType':
            row[key] = event.categories ? (categoriesMap.get(event.categories) || '') : ''
            break
          case 'products':
            row[key] = formatProducts(normalizeEventProducts(event))
            break
          case 'address':
            row[key] = event.address || ''
            break
          case 'city':
            row[key] = event.city || ''
            break
          case 'state':
            row[key] = event.state || ''
            break
          case 'zip':
            row[key] = event.zipCode || ''
            break
          case 'location':
            row[key] = event.locationName || ''
            break
          case 'eventInfo':
            row[key] = event.eventInfo || ''
            break
          case 'discount':
            row[key] = (event.discount || event.discountImageURL) ? 'Yes' : 'No'
            break
          case 'discountText':
            row[key] = event.discount || ''
            break
          case 'discountImageFile':
            row[key] = event.discountImageURL ? 'Yes' : 'No'
            break
          case 'timeZone':
            row[key] = eventTimezone ? getAppTimezoneShortLabel(eventTimezone) : ''
            break
        }
      })

      rows.push(row)
    }

    return rows
  },

  // Helper method for fetching user data for custom reports
  async fetchUserDataForCustomReport(
    columnKeys: string[],
    dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string
  ): Promise<Record<string, string | number>[]> {
    const users = await fetchAllAppUsers(dateRange)
    const referralsCountByCode = buildReferralsCountByCode(users)
    const checkInReviewPointsByUser = await fetchCheckInReviewPointsByUser()
    const triviasWonByUser = await fetchTriviasWonCountByUser()

    return users.map(user => {
      const userRecord = user as Record<string, unknown>
      const userId = (user as { $id?: string }).$id
      const row: Record<string, string | number> = {}

      columnKeys.forEach(key => {
        switch (key) {
          case 'firstName':
            row[key] = user.firstname || ''
            break
          case 'lastName':
            row[key] = user.lastname || ''
            break
          case 'username':
            row[key] = (userRecord.username as string) || ''
            break
          case 'email':
            row[key] = user.email || ''
            break
          case 'phoneNumber':
            row[key] = (userRecord.phoneNumber as string) || ''
            break
          case 'dob':
            row[key] = formatDateOnly(userRecord.dob as string | undefined)
            break
          case 'signUpDate':
            row[key] = formatDate(user.$createdAt, appTimezone)
            break
          case 'lastLoginDate':
            row[key] = formatDate(user.lastLoginDate, appTimezone)
            break
          case 'referralCode':
            row[key] = (userRecord.referralCode as string) || ''
            break
          case 'referralsCount':
            const code = (userRecord.referralCode as string) || ''
            row[key] = code ? (referralsCountByCode.get(code) ?? 0) : 0
            break
          case 'userPoints':
            row[key] = (userRecord.totalPoints as number) ?? 0
            break
          case 'checkInReviewPoints':
            row[key] = userId ? (checkInReviewPointsByUser.get(userId) ?? 0) : 0
            break
          case 'baBadge':
            row[key] = (userRecord.isAmbassador as boolean) ? 'Yes' : 'No'
            break
          case 'influencerBadge':
            row[key] = (userRecord.isInfluencer as boolean) ? 'Yes' : 'No'
            break
          case 'tierLevel':
            row[key] = (userRecord.tierLevel as string) || 'NewbieSampler'
            break
          case 'checkIns':
            row[key] = (userRecord.totalEvents as number) ?? 0
            break
          case 'reviews':
            row[key] = (userRecord.totalReviews as number) ?? 0
            break
          case 'triviasWon':
            row[key] = userId ? (triviasWonByUser.get(userId) ?? 0) : 0
            break
        }
      })

      return row
    })
  },

  // Helper method for fetching client data for custom reports
  async fetchClientDataForCustomReport(
    columnKeys: string[],
    dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string
  ): Promise<Record<string, string | number>[]> {
    const queries: string[] = [Query.orderDesc('$createdAt')]
    if (dateRange?.start) {
      queries.push(Query.greaterThanEqual('$createdAt', dateRange.start.toISOString()))
    }
    if (dateRange?.end) {
      const endDate = new Date(dateRange.end)
      endDate.setHours(23, 59, 59, 999)
      queries.push(Query.lessThanEqual('$createdAt', endDate.toISOString()))
    }

    const result = await clientsService.list(queries)
    const clients = (result?.documents ?? []) as ClientDocument[]
    
    const clientIds = clients.map(c => c.$id)
    const statsMap = clientIds.length > 0
      ? await clientsService.getClientsStats(clientIds)
      : new Map()

    return clients.map(client => {
      const row: Record<string, string | number> = {}
      const stats = statsMap.get(client.$id)

      columnKeys.forEach(key => {
        switch (key) {
          case 'clientName':
            row[key] = client.name || ''
            break
          case 'logoFile':
            row[key] = client.logoURL ? 'Yes' : 'No'
            break
          case 'signUpDate':
            row[key] = formatDate(client.$createdAt, appTimezone)
            break
          case 'products':
            row[key] = formatProducts(client.productType)
            break
          case 'favorites':
            row[key] = stats?.totalFavorites ?? 0
            break
        }
      })

      return row
    })
  },

  // Helper method for fetching review data for custom reports
  async fetchReviewDataForCustomReport(
    columnKeys: string[],
    dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string
  ): Promise<Record<string, string | number>[]> {
    const queries: string[] = [Query.orderDesc('$createdAt')]
    if (dateRange?.start) {
      queries.push(Query.greaterThanEqual('$createdAt', dateRange.start.toISOString()))
    }
    if (dateRange?.end) {
      const endDate = new Date(dateRange.end)
      endDate.setHours(23, 59, 59, 999)
      queries.push(Query.lessThanEqual('$createdAt', endDate.toISOString()))
    }

    const allReviews: ReviewDocument[] = []
    let offset = 0
    let chunk: ReviewDocument[]
    do {
      const result = await reviewsService.list([
        ...queries,
        Query.limit(REPORT_LIST_PAGE_SIZE),
        Query.offset(offset),
      ])
      chunk = result.documents ?? []
      allReviews.push(...chunk)
      offset += REPORT_LIST_PAGE_SIZE
    } while (chunk.length === REPORT_LIST_PAGE_SIZE)

    // Batch fetch related data
    const userIds = [...new Set(allReviews.filter(r => r.user).map(r => r.user as string))]
    const eventIds = [...new Set(allReviews.filter(r => r.event).map(r => r.event as string))]
    
    const usersMap = new Map<string, AppUser>()
    const eventsMap = new Map<string, EventDocument>()

    // Fetch users
    for (let i = 0; i < userIds.length; i += 25) {
      const batch = userIds.slice(i, i + 25)
      try {
        const users = await appUsersService.list([Query.equal('$id', batch)])
        for (const user of users) {
          usersMap.set((user as { $id?: string }).$id!, user)
        }
      } catch (err) {
        console.error('Error fetching users:', err)
      }
    }

    // Fetch events
    for (let i = 0; i < eventIds.length; i += 25) {
      const batch = eventIds.slice(i, i + 25)
      try {
        const result = await eventsService.list([Query.equal('$id', batch)])
        for (const event of (result.documents ?? []) as EventDocument[]) {
          eventsMap.set(event.$id, event)
        }
      } catch (err) {
        console.error('Error fetching events:', err)
      }
    }

    // Fetch clients/categories for brand/product columns (SAM-523)
    const clientsMap = new Map<string, ClientDocument>()
    const categoriesMap = new Map<string, string>()

    if (columnKeys.includes('clientName')) {
      const clientIds = [...new Set(
        Array.from(eventsMap.values()).filter(e => e.client).map(e => e.client!)
      )]
      for (let i = 0; i < clientIds.length; i += 25) {
        const batch = clientIds.slice(i, i + 25)
        try {
          const result = await clientsService.list([Query.equal('$id', batch)])
          for (const client of (result.documents ?? []) as ClientDocument[]) {
            clientsMap.set(client.$id, client)
          }
        } catch (err) {
          console.error('Error fetching clients:', err)
        }
      }
    }

    if (columnKeys.includes('productType')) {
      const categoryIds = [...new Set(
        Array.from(eventsMap.values()).filter(e => e.categories).map(e => e.categories!)
      )]
      for (let i = 0; i < categoryIds.length; i += 25) {
        const batch = categoryIds.slice(i, i + 25)
        try {
          const result = await categoriesService.list([Query.equal('$id', batch)])
          for (const category of result.documents ?? []) {
            categoriesMap.set(category.$id, category.title || '')
          }
        } catch (err) {
          console.error('Error fetching categories:', err)
        }
      }
    }

    return allReviews.map(review => {
      const row: Record<string, string | number> = {}
      const user = review.user ? usersMap.get(review.user as string) : undefined
      const event = review.event ? eventsMap.get(review.event as string) : undefined

      columnKeys.forEach(key => {
        switch (key) {
          case 'checkIn':
            row[key] = 'Yes'
            break
          case 'hasReview':
            row[key] = 'Yes'
            break
          case 'reviewStars':
            row[key] = review.rating || 0
            break
          case 'reviewLiked':
            const liked = review.liked
            const likedItems: string[] = Array.isArray(liked)
              ? (liked as string[])
              : liked ? String(liked).split(',').map(s => s.trim()) : []
            row[key] = likedItems.join(', ')
            break
          case 'reviewPurchased':
            row[key] = review.hasPurchased ? 'Yes' : 'No'
            break
          case 'reviewFeedback':
            row[key] = review.review || ''
            break
          case 'reviewedAt':
            row[key] = formatDate(review.$createdAt, appTimezone)
            break
          case 'pointsEarned':
            row[key] = review.pointsEarned || 0
            break
          case 'firstName':
            row[key] = user?.firstname || ''
            break
          case 'lastName':
            row[key] = user?.lastname || ''
            break
          case 'username':
            row[key] = (user as any)?.username || ''
            break
          case 'email':
            row[key] = (user as { email?: string })?.email || ''
            break
          case 'eventName':
            row[key] = event?.name || ''
            break
          case 'eventDate':
            row[key] = event ? formatDateForUpload(event.startTime || event.date, appTimezone) : ''
            break
          case 'checkInCode':
            row[key] = event?.checkInCode || ''
            break
          case 'clientName':
            row[key] = event?.client ? (clientsMap.get(event.client)?.name || '') : ''
            break
          case 'productType':
            row[key] = event?.categories ? (categoriesMap.get(event.categories) || '') : ''
            break
        }
      })

      return row
    })
  },

  // Helper method for fetching trivia data for custom reports
  async fetchTriviaDataForCustomReport(
    columnKeys: string[],
    dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string
  ): Promise<Record<string, string | number>[]> {
    // Reuse existing trivia report logic
    const { rows } = await this.generateTriviaReport(dateRange, appTimezone)
    
    // Filter to only requested columns
    return rows.map(row => {
      const filteredRow: Record<string, string | number> = {}
      columnKeys.forEach(key => {
        if (row[key] !== undefined) {
          filteredRow[key] = row[key]
        }
      })
      return filteredRow
    })
  },

  /**
   * Generate Points Earned report.
   * Fetches all users (paginated) so report total matches actual user count.
   *
   * - useDateRangeForPoints = false ("All"): every points/activity column is the user's
   *   lifetime value (User Points = user_profiles.totalPoints).
   * - useDateRangeForPoints = true ("Date Range" / winner-of-the-month): every points/activity
   *   column reflects ONLY the selected window, summed from dated records — User Points =
   *   check-in + review + trivia points earned in range, and the rows are ranked by it.
   */
  async generatePointsEarnedReport(
    dateRange?: { start: Date | null; end: Date | null },
    useDateRangeForPoints = false,
    appTimezone?: string
  ): Promise<{ columns: ReportColumn[]; rows: Record<string, string | number>[] }> {
    // Tier Level is a lifetime property of the user; derive from lifetime points when unset.
    const deriveTier = (existing: string, lifetimePoints: number): string => {
      if (existing) return existing
      if (lifetimePoints >= 1000) return 'ProSampler'
      if (lifetimePoints >= 500) return 'Sampler'
      return 'NewbieSampler'
    }

    if (useDateRangeForPoints) {
      const [usersResult, earnedByUser] = await Promise.all([
        fetchAllAppUsers(),
        fetchPointsEarnedInRangeByUser(dateRange),
      ])

      const rows = usersResult.map((user: AppUser) => {
        const userRecord = user as Record<string, unknown>
        const userId = (user as { $id?: string }).$id
        const breakdown = (userId ? earnedByUser.get(userId) : undefined) ?? emptyPointsBreakdown()
        const lifetimePoints = (userRecord.totalPoints as number) ?? (userRecord.userPoints as number) ?? 0

        return {
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          username: (userRecord.username as string) || '',
          email: user.email || '',
          lastLoginDate: formatDate(user.lastLoginDate, appTimezone),
          tierLevel: deriveTier((userRecord.tierLevel as string) || '', lifetimePoints),
          // Points earned in the selected window (check-in + review + trivia); drives the ranking.
          userPoints: breakdownTotalPoints(breakdown).toString(),
          checkInReviewPoints: breakdownCheckInReviewPoints(breakdown).toString(),
          checkIns: breakdown.checkInCount.toString(),
          reviews: breakdown.reviewCount.toString(),
          triviasWon: breakdown.triviaWins.toString(),
        }
      })

      sortPointsRowsByUserPointsDesc(rows)
      return { columns: pointsEarnedDateRangeColumns, rows }
    }

    // All-time report: lifetime totals from user_profiles + all-time aggregations.
    const [usersResult, checkInReviewPointsByUser, triviasWonByUser] = await Promise.all([
      fetchAllAppUsers(),
      fetchCheckInReviewPointsByUser(),
      fetchTriviasWonCountByUser(),
    ])

    const rows = usersResult.map((user: AppUser) => {
      const userRecord = user as Record<string, unknown>
      const userId = (user as { $id?: string }).$id

      // Map user_profiles fields - totalPoints is the main field for user points
      const totalPoints = (userRecord.totalPoints as number) ?? (userRecord.userPoints as number) ?? 0
      // Check-in/Review Pts = sum of (event checkInPoints + review pointsEarned) for each of the user's reviews
      const checkInReviewPoints =
        (userId ? checkInReviewPointsByUser.get(userId) : undefined) ??
        (userRecord.checkInReviewPoints as number) ??
        0
      const totalReviews = (userRecord.totalReviews as number) ?? (userRecord.reviews as number) ?? 0
      const totalEvents = (userRecord.totalEvents as number) ?? (userRecord.checkIns as number) ?? 0
      const triviasWon = (userId ? triviasWonByUser.get(userId) : undefined) ?? (userRecord.triviasWon as number) ?? 0

      return {
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        username: (userRecord.username as string) || '',
        email: user.email || '',
        lastLoginDate: formatDate(user.lastLoginDate, appTimezone),
        tierLevel: deriveTier((userRecord.tierLevel as string) || '', totalPoints),
        userPoints: totalPoints.toString(),
        checkInReviewPoints: checkInReviewPoints.toString(),
        checkIns: totalEvents.toString(),
        reviews: totalReviews.toString(),
        triviasWon: triviasWon.toString(),
      }
    })

    sortPointsRowsByUserPointsDesc(rows)
    return { columns: pointsEarnedColumns, rows }
  },

  /**
   * Generate Event Reviews report for a single event (for Download on event-reviews/:eventId page).
   */
  async generateEventReviewsReport(eventId: string, appTimezone?: string): Promise<{ columns: ReportColumn[]; rows: Record<string, string | number>[] }> {
    const eventReviewColumns: ReportColumn[] = [
      { header: 'Reviewer Name', key: 'reviewerName' },
      { header: 'Email', key: 'email' },
      { header: 'Rating', key: 'rating' },
      { header: 'Review', key: 'review' },
      { header: 'Reviewed At', key: 'reviewedAt' },
      { header: 'Answers', key: 'answers' },
      { header: 'Purchased Product', key: 'purchasedProduct' },
      { header: 'Time Zone', key: 'timeZone' },
    ]
    const rows: Record<string, string | number>[] = []
    let offset = 0
    const limit = 100
    let documents: ReviewDocument[] = []

    do {
      const result = await reviewsService.list([
        Query.equal('event', eventId),
        Query.orderDesc('$createdAt'),
        Query.limit(limit),
        Query.offset(offset),
      ])
      documents = result.documents ?? []
      for (const doc of documents) {
        let reviewerName = 'Anonymous'
        let email = ''
        if (doc.user) {
          try {
            const user = await appUsersService.getById(doc.user as string)
            reviewerName = [user?.firstname, user?.lastname].filter(Boolean).join(' ') || (user?.username as string) || 'Anonymous'
            email = (user as { email?: string }).email ?? ''
          } catch {
            // keep defaults
          }
        }
        const liked = doc.liked
        const likedItems: string[] = Array.isArray(liked)
          ? (liked as string[]).map((s) => String(s).trim()).filter(Boolean)
          : liked != null
            ? String(liked)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : []
        const answersDisplay =
          likedItems.length > 0
            ? likedItems.map((s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()).join(', ')
            : ''
        const createdAt = doc.$createdAt
        const reviewedAt = createdAt
          ? `${formatDate(createdAt, appTimezone)} ${formatTime(createdAt, appTimezone)}`
          : ''
        rows.push({
          reviewerName,
          email,
          rating: doc.rating ?? 0,
          review: doc.review ?? '',
          reviewedAt,
          answers: answersDisplay,
          purchasedProduct: doc.hasPurchased ? 'Yes' : 'No',
          timeZone: appTimezone ? getAppTimezoneShortLabel(appTimezone) : '',
        })
      }
      offset += limit
    } while (documents.length === limit)

    return {
      columns: eventReviewColumns,
      rows,
    }
  },

  /**
   * Export Event Reviews report (CSV or PDF) for a single event.
   */
  async exportEventReviewsReport(
    eventId: string,
    eventName: string,
    filename: string,
    format: 'csv' | 'pdf',
    appTimezone?: string
  ): Promise<void> {
    const { columns, rows } = await this.generateEventReviewsReport(eventId, appTimezone)
    if (format === 'csv') {
      const csvContent = this.exportToCSV(columns, rows)
      this.downloadCSV(filename, csvContent)
    } else {
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
      doc.setFontSize(16)
      doc.setFont('helvetica', 'bold')
      doc.text(`Event Reviews: ${eventName || 'Event'}`, 14, 15)
      doc.setFontSize(10)
      doc.setFont('helvetica', 'normal')
      doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 22)
      const headers = columns.map((c) => c.header)
      const tableRows = rows.map((row) =>
        columns.map((col) => wrapTextForPdf(String(row[col.key] ?? '')))
      )
      const pageWidth = doc.internal.pageSize.getWidth ? doc.internal.pageSize.getWidth() : doc.internal.pageSize.width
      const tableWidth = Math.min(pageWidth - 20, pageWidth * 0.98)
      const colWidth = tableWidth / columns.length
      const columnStyles: Record<string, { cellWidth: number; overflow: 'linebreak' }> = {}
      columns.forEach((_, i) => {
        columnStyles[String(i)] = { cellWidth: colWidth, overflow: 'linebreak' }
      })
      autoTable(doc, {
        head: [headers],
        body: tableRows,
        startY: 28,
        theme: 'grid',
        tableWidth,
        margin: { left: 10, right: 10 },
        columnStyles,
        styles: { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
        headStyles: { fillColor: [145, 1, 104], textColor: 255, fontStyle: 'bold', halign: 'left' },
        bodyStyles: { valign: 'top' },
        alternateRowStyles: { fillColor: [249, 250, 251] },
      })
      doc.save(filename)
    }
  },

  /**
   * Export data to CSV format.
   * @param sortLabel - If provided, prepends a comment line "Sorted by: {sortLabel}" so the file documents sort order.
   */
  exportToCSV(columns: ReportColumn[], rows: Record<string, string | number>[], sortLabel?: string): string {
    const header = columns.map(col => col.header).join(',')
    const csvRows = rows.map(row => {
      return columns.map(col => {
        const value = col.getValue ? col.getValue(row) : row[col.key]
        const stringValue = String(value ?? '')
        if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
          return `"${stringValue.replace(/"/g, '""')}"`
        }
        return stringValue
      }).join(',')
    })
    const body = [header, ...csvRows].join('\n')
    if (sortLabel) {
      return `# Sorted by: ${sortLabel}\n${body}`
    }
    return body
  },

  /**
   * Download CSV file. Prepends a UTF-8 BOM so Excel and Numbers detect the
   * encoding and render emoji / non-ASCII characters correctly (SAM-523).
   */
  downloadCSV(filename: string, csvContent: string): void {
    const BOM = '﻿'
    const blob = new Blob([BOM, csvContent], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    const url = URL.createObjectURL(blob)
    
    link.setAttribute('href', url)
    link.setAttribute('download', filename)
    link.style.visibility = 'hidden'
    
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    
    URL.revokeObjectURL(url)
  },

  /**
   * Export report to CSV and download.
   * Exported data is sorted by effectiveSortKey (provided sortKey or first column) so order matches Preview.
   */
  async exportReport(
    reportType: ReportType,
    filename: string,
    dateRange?: { start: Date | null; end: Date | null },
    sortKey?: string,
    appTimezone?: string
  ): Promise<void> {
    try {
      const { columns, rows } = await this.generateReportData(reportType, dateRange, appTimezone)
      const columnKeys = new Set(columns.map((c) => c.key))
      const reportDefaultKey = DEFAULT_EXPORT_SORT_KEY[reportType]
      const defaultSortKey = reportDefaultKey && columnKeys.has(reportDefaultKey) ? reportDefaultKey : columns[0]?.key
      const effectiveSortKey = sortKey && columnKeys.has(sortKey) ? sortKey : defaultSortKey
      const sortedRows = effectiveSortKey ? sortReportRows(rows, effectiveSortKey) : rows
      const sortLabel = effectiveSortKey ? (columns.find(c => c.key === effectiveSortKey)?.header ?? effectiveSortKey) : undefined
      const csvContent = this.exportToCSV(columns, sortedRows, sortLabel)
      this.downloadCSV(filename, csvContent)
    } catch (error) {
      console.error('Error exporting report:', error)
      throw error
    }
  },

  /**
   * Export report to PDF.
   * Exported data is sorted by effectiveSortKey (provided sortKey or first column) so order matches Preview.
   */
  async exportReportToPDF(
    reportType: ReportType,
    filename: string,
    dateRange?: { start: Date | null; end: Date | null },
    sortKey?: string,
    appTimezone?: string
  ): Promise<void> {
    try {
      const { columns, rows } = await this.generateReportData(reportType, dateRange, appTimezone)
      const columnKeys = new Set(columns.map((c) => c.key))
      const reportDefaultKey = DEFAULT_EXPORT_SORT_KEY[reportType]
      const defaultSortKey = reportDefaultKey && columnKeys.has(reportDefaultKey) ? reportDefaultKey : columns[0]?.key
      const effectiveSortKey = sortKey && columnKeys.has(sortKey) ? sortKey : defaultSortKey
      const sortedRows = effectiveSortKey ? sortReportRows(rows, effectiveSortKey) : rows

      // Use landscape when 5+ columns so all columns fit on page without being
      // cut off; bump to A3 for very wide reports so columns stay legible
      // instead of being compressed into unreadable slivers (SAM-523).
      const colCount = columns.length
      const useLandscape = colCount >= 5
      const useA3 = colCount > 12
      const doc = new jsPDF({
        orientation: useLandscape ? 'landscape' : 'portrait',
        unit: 'mm',
        format: useA3 ? 'a3' : 'a4',
      })
      
      // Add title
      const reportTitle = this.getReportTitle(reportType, dateRange)
      doc.setFontSize(16)
      doc.setFont('helvetica', 'bold')
      doc.text(reportTitle, 14, 15)
      
      // Add generation date
      doc.setFontSize(10)
      doc.setFont('helvetica', 'normal')
      doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 22)
      let startY = 28
      if (dateRange && (dateRange.start || dateRange.end)) {
        const rangeText = `Date Range: ${dateRange.start ? formatDate(dateRange.start.toISOString(), appTimezone) : 'N/A'} - ${dateRange.end ? formatDate(dateRange.end.toISOString(), appTimezone) : 'N/A'}`
        doc.text(rangeText, 14, 28)
        startY = 32
      }
      if (effectiveSortKey) {
        const sortHeader = columns.find(c => c.key === effectiveSortKey)?.header ?? effectiveSortKey
        doc.text(`Sorted by: ${sortHeader}`, 14, startY)
        startY += 6
      }

      // Prepare table data (use sorted rows); wrap long cell text so PDF does not crop
      const headers = columns.map(col => col.header)
      const tableRows = sortedRows.map(row =>
        columns.map(col => {
          const value = col.getValue ? col.getValue(row) : row[col.key]
          return wrapTextForPdf(String(value ?? ''))
        })
      )
      
      // Table width and column widths: explicit widths so all columns fit on page and text wraps
      const pageWidth = doc.internal.pageSize.getWidth ? doc.internal.pageSize.getWidth() : doc.internal.pageSize.width
      const marginLeft = 10
      const marginRight = 10
      const tableWidth = Math.min(pageWidth - marginLeft - marginRight, pageWidth * 0.98)
      const numCols = headers.length
      const colWidth = tableWidth / numCols
      const columnStyles: Record<string, { cellWidth: number; overflow: 'linebreak' }> = {}
      for (let i = 0; i < numCols; i++) {
        columnStyles[String(i)] = { cellWidth: colWidth, overflow: 'linebreak' }
      }
      // Tier font and padding to column count so wide reports stay legible
      // instead of being compressed (SAM-523).
      const tableFontSize =
        numCols > 15 ? 5 :
        numCols > 10 ? 6 :
        numCols > 7  ? 7 :
                       8
      const cellPadding = numCols > 10 ? 1 : numCols > 7 ? 1.5 : 2

      autoTable(doc, {
        head: [headers],
        body: tableRows,
        startY,
        theme: 'grid',
        tableWidth,
        margin: { left: marginLeft, right: marginRight },
        columnStyles,
        styles: {
          fontSize: tableFontSize,
          cellPadding,
          overflow: 'linebreak',
        },
        headStyles: {
          fillColor: [145, 1, 104], // Brand Purple - Bright (#910168)
          textColor: 255,
          fontStyle: 'bold',
          fontSize: tableFontSize,
          halign: 'left',
        },
        bodyStyles: {
          valign: 'top',
        },
        alternateRowStyles: {
          fillColor: [249, 250, 251], // Gray-50
        },
        didDrawPage: (data) => {
          // Footer with page numbers
          const pageCount = doc.getNumberOfPages()
          const pageSize = doc.internal.pageSize
          const pageHeight = pageSize.height || pageSize.getHeight()
          
          doc.setFontSize(8)
          doc.setFont('helvetica', 'normal')
          doc.text(
            `Page ${data.pageNumber} of ${pageCount}`,
            pageSize.width / 2,
            pageHeight - 10,
            { align: 'center' }
          )
        },
      })
      
      // Save the PDF
      doc.save(filename)
    } catch (error) {
      console.error('Error generating PDF:', error)
      throw error
    }
  },

  /**
   * Export custom report directly to PDF
   * Uses already generated data instead of regenerating
   */
  async exportCustomReportToPDF(
    columns: ReportColumn[],
    rows: Record<string, string | number>[],
    filename: string,
    title: string,
    dateRange?: { start: Date | null; end: Date | null },
    appTimezone?: string
  ): Promise<void> {
    try {
      const numCols = columns.length
      // Use A3 landscape for very wide reports so columns don't get squeezed
      // beyond legibility; A4 landscape otherwise (SAM-523).
      const useA3 = numCols > 12
      const doc = new jsPDF({
        orientation: 'landscape',
        unit: 'mm',
        format: useA3 ? 'a3' : 'a4',
      })

      // Add title and metadata
      doc.setFontSize(16)
      doc.text(title, 14, 15)

      // Add date range if provided
      if (dateRange?.start || dateRange?.end) {
        doc.setFontSize(10)
        let dateText = ''
        if (dateRange.start && dateRange.end) {
          const startStr = dateRange.start.toLocaleDateString()
          const endStr = dateRange.end.toLocaleDateString()
          dateText = `Date Range: ${startStr} - ${endStr}`
        } else if (dateRange.start) {
          dateText = `From: ${dateRange.start.toLocaleDateString()}`
        } else if (dateRange.end) {
          dateText = `To: ${dateRange.end.toLocaleDateString()}`
        }
        doc.text(dateText, 14, 22)
      }

      // Add timezone if provided
      if (appTimezone) {
        doc.setFontSize(8)
        doc.text(`Timezone: ${getAppTimezoneShortLabel(appTimezone)}`, 14, 28)
      }

      // Prepare data for table; wrap text so cells linebreak instead of crop.
      const headers = columns.map(col => col.header)
      const data = rows.map(row =>
        columns.map(col => {
          const value = col.getValue ? col.getValue(row) : row[col.key]
          return wrapTextForPdf(String(value ?? ''))
        })
      )

      // Scale font and padding to column count so wide reports stay legible
      // instead of being compressed into unreadable slivers (SAM-523).
      const tableFontSize =
        numCols > 15 ? 5 :
        numCols > 10 ? 6 :
        numCols > 7  ? 7 :
                       8
      const cellPadding = numCols > 10 ? 1 : numCols > 7 ? 1.5 : 2

      // Distribute column widths evenly across the printable area so every
      // column is visible and overflow wraps inside the cell.
      const pageWidth = doc.internal.pageSize.getWidth
        ? doc.internal.pageSize.getWidth()
        : doc.internal.pageSize.width
      const marginLeft = 10
      const marginRight = 10
      const tableWidth = pageWidth - marginLeft - marginRight
      const colWidth = tableWidth / numCols
      const columnStyles: Record<string, { cellWidth: number; overflow: 'linebreak' }> = {}
      for (let i = 0; i < numCols; i++) {
        columnStyles[String(i)] = { cellWidth: colWidth, overflow: 'linebreak' }
      }

      autoTable(doc, {
        head: [headers],
        body: data,
        startY: 35,
        theme: 'grid',
        tableWidth,
        margin: { left: marginLeft, right: marginRight },
        columnStyles,
        styles: {
          fontSize: tableFontSize,
          cellPadding,
          overflow: 'linebreak',
        },
        headStyles: {
          fillColor: [145, 1, 104], // Brand Purple
          textColor: 255,
          fontStyle: 'bold',
          fontSize: tableFontSize,
        },
        bodyStyles: {
          valign: 'top',
        },
      })

      // Save the PDF
      doc.save(filename)
    } catch (error) {
      console.error('Error generating custom PDF:', error)
      throw error
    }
  },

  /**
   * Get report title based on report type
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getReportTitle(reportType: ReportType, _dateRange?: { start: Date | null; end: Date | null }): string {
    switch (reportType) {
      case 'dashboard-all':
        return 'Dashboard Report - All Events'
      case 'dashboard-date-range':
        return 'Dashboard Report - Date Range'
      case 'event-list':
        return 'Event List Report'
      case 'clients-brands':
        return 'Clients & Brands Report'
      case 'app-users':
        return 'App Users Report'
      case 'points-earned-all':
        return 'Points Earned Report'
      case 'points-earned-date-range':
        return 'Points Earned Report (Date Range)'
      case 'event-recap':
        return 'Event Recap Report'
      case 'trivia-report':
        return 'Trivia Report'
      case 'custom':
        return 'Custom Report'
      default:
        return 'Report'
    }
  },
}
