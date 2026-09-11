// Pure search / filter / sort for the pop-up viewer list ("Who saw this pop-up").
//
// Kept dependency-free and outside the component so it can be executed directly by
// scripts/verify-popup-viewers.mjs, the same arrangement as lib/userSearch.ts and
// lib/userListView.ts. Everything here runs client-side over the rows the Statistics
// function returns (capped at 1000, newest first); a server-side filter would hide
// matching rows inside that cap.

import { matchesAllTokens } from './userSearch'
import { appTimeToUTC } from './dateUtils'
import type { SortOrder } from './userListView'

/**
 * The fields this module needs. `PopupViewerRow` from services.ts satisfies it —
 * declared structurally so the verification script can build fixtures without
 * pulling in the Appwrite client.
 */
export interface ViewerLike {
  userId: string
  name: string
  username: string
  shownAt: string | null
  clickedAt: string | null
  is21Plus: boolean
}

export type ViewerEngagementFilter = 'all' | 'clicked' | 'notClicked'
export type ViewerAgeFilter = 'all' | '21plus' | 'under21'
export type ViewerSortBy = 'shownAt' | 'clickedAt' | 'name'

export interface ViewerDateRange {
  start: Date | null
  end: Date | null
}

export interface ViewerFilters {
  search: string
  engagement: ViewerEngagementFilter
  age: ViewerAgeFilter
  dateRange: ViewerDateRange
  sortBy: ViewerSortBy
  sortOrder: SortOrder
}

/** Newest sighting first — the order the function already returns rows in. */
export const initialViewerFilters: ViewerFilters = {
  search: '',
  engagement: 'all',
  age: 'all',
  dateRange: { start: null, end: null },
  sortBy: 'shownAt',
  sortOrder: 'desc',
}

export const ENGAGEMENT_LABELS: Record<ViewerEngagementFilter, string> = {
  all: 'All Viewers',
  clicked: 'Clicked',
  notClicked: 'Did Not Click',
}

// "All" must not read as "everyone is 21+": these describe the viewer at the moment
// the pop-up was shown, which is what the interaction row recorded.
export const VIEWER_AGE_LABELS: Record<ViewerAgeFilter, string> = {
  all: 'All Age Groups',
  '21plus': '21+ when shown',
  under21: 'Under 21 when shown',
}

export const VIEWER_SORT_LABELS: Record<ViewerSortBy, string> = {
  shownAt: 'Shown',
  clickedAt: 'Clicked',
  name: 'Name',
}

/**
 * True when anything narrows the list. Sort is deliberately excluded: reordering
 * hides nothing, so offering to "clear" it would be misleading.
 */
export const hasActiveViewerFilters = (filters: ViewerFilters): boolean =>
  filters.search.trim() !== '' ||
  filters.engagement !== 'all' ||
  filters.age !== 'all' ||
  filters.dateRange.start !== null

const pad = (n: number): string => String(n).padStart(2, '0')

/** The calendar date the admin picked. The picker builds Dates at LOCAL midnight. */
const pickedDayKey = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * Turn a picked day (or span of days) into the UTC instants that bound it **in the app
 * timezone**, because that is the timezone the Shown column is rendered in. Reading the
 * range in the browser's own timezone instead would let an admin abroad pick the day a
 * row visibly displays and watch that row vanish from the table.
 *
 * The end is exclusive — the next day's midnight — rather than 23:59, which would drop
 * anything shown in that last minute.
 */
const rangeBounds = (
  dateRange: ViewerDateRange,
  appTimezone: string
): { start: number; endExclusive: number } | null => {
  if (!dateRange.start) return null
  const lastDay = new Date(dateRange.end ?? dateRange.start)
  lastDay.setDate(lastDay.getDate() + 1)
  return {
    start: appTimeToUTC(pickedDayKey(dateRange.start), '00:00', appTimezone).getTime(),
    endExclusive: appTimeToUTC(pickedDayKey(lastDay), '00:00', appTimezone).getTime(),
  }
}

export function filterViewers<T extends ViewerLike>(
  rows: readonly T[],
  filters: ViewerFilters,
  appTimezone: string
): T[] {
  const range = rangeBounds(filters.dateRange, appTimezone)

  return rows.filter((row) => {
    if (!matchesAllTokens([row.name, row.username], filters.search)) return false

    if (filters.engagement === 'clicked' && !row.clickedAt) return false
    if (filters.engagement === 'notClicked' && row.clickedAt) return false

    if (filters.age === '21plus' && !row.is21Plus) return false
    if (filters.age === 'under21' && row.is21Plus) return false

    if (range) {
      // The range applies to when the pop-up was shown. A row with no shownAt cannot
      // be placed on a timeline, so it drops out of a date-narrowed view rather than
      // being silently treated as in range.
      const shown = row.shownAt ? Date.parse(row.shownAt) : NaN
      if (Number.isNaN(shown) || shown < range.start || shown >= range.endExclusive) return false
    }

    return true
  })
}

const displayName = (row: ViewerLike): string =>
  (row.name || row.username || row.userId).toLowerCase()

/**
 * Sort a copy of `rows`.
 *
 * Missing timestamps always sort last, in BOTH directions. A null `clickedAt` means
 * "never clicked", not "clicked at the beginning of time": treating it as a value
 * would flood the top of an ascending sort with people who never engaged, which is
 * the opposite of what an admin sorting by Clicked is looking for.
 *
 * `userId` breaks ties so paging through equal timestamps cannot reshuffle rows
 * between renders.
 */
export function sortViewers<T extends ViewerLike>(
  rows: readonly T[],
  sortBy: ViewerSortBy,
  sortOrder: SortOrder
): T[] {
  const direction = sortOrder === 'asc' ? 1 : -1

  return [...rows].sort((a, b) => {
    let result = 0

    if (sortBy === 'name') {
      result = displayName(a).localeCompare(displayName(b)) * direction
    } else {
      const aRaw = sortBy === 'shownAt' ? a.shownAt : a.clickedAt
      const bRaw = sortBy === 'shownAt' ? b.shownAt : b.clickedAt
      const aTime = aRaw ? Date.parse(aRaw) : NaN
      const bTime = bRaw ? Date.parse(bRaw) : NaN
      const aMissing = Number.isNaN(aTime)
      const bMissing = Number.isNaN(bTime)

      if (aMissing || bMissing) {
        if (aMissing && bMissing) result = 0
        else result = aMissing ? 1 : -1 // missing last, whichever way we're sorting
      } else {
        result = (aTime - bTime) * direction
      }
    }

    return result !== 0 ? result : a.userId.localeCompare(b.userId)
  })
}

export function filterAndSortViewers<T extends ViewerLike>(
  rows: readonly T[],
  filters: ViewerFilters,
  appTimezone: string
): T[] {
  return sortViewers(filterViewers(rows, filters, appTimezone), filters.sortBy, filters.sortOrder)
}
