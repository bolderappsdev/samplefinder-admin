// Pure, dependency-free source selection for the dynamic Report Builder.
//
// Kept free of Appwrite/Vite imports so the decision can be unit-tested in isolation
// (see scripts/verify-report-builder-source.mjs).
//
// Background: a custom report is materialized by exactly ONE fetcher — concatenating rows from
// several fetchers produces rows with mismatched columns (SAM-523). Each fetcher emits one row per
// record of its own collection and can only populate the columns it knows how to join, so the
// choice of fetcher decides BOTH the row granularity and which cells get filled.
//
// A column's `dataSource` list is exactly "which fetchers can populate me", so the best primary
// source is the one covering the most selected columns. The previous rule — "any selected column
// mentions reviews? use the review fetcher" — mis-routed user reports: First/Last Name, Username
// and Email list both 'users' and 'reviews', so a report of user totals was emitted
// one-row-per-review (the same user repeated once per review) with every users-only metric
// (User Points, Check-in/Review Pts, Check-Ins, Reviews, Trivias Won) left blank.

export type PrimarySource = 'events' | 'users' | 'clients' | 'reviews' | 'trivia'

/** Minimal column shape needed to pick a source (structurally a ColumnDefinition). */
export interface SourcedColumn {
  key: string
  dataSource: readonly string[]
}

/**
 * Candidate fetchers in tie-break order: an earlier entry wins an equal-coverage tie, so a
 * selection that several fetchers could serve is reported at the granularity of the entity it is
 * *about* — identity-only columns (First Name, Email, ...) list one row per user rather than one
 * row per review.
 *
 * 'locations' is absent on purpose: it has no fetcher of its own, and every location column is
 * also served by 'events' (which joins the location).
 */
const SOURCE_PRIORITY: PrimarySource[] = ['users', 'clients', 'events', 'trivia', 'reviews']

/** How many of the selected columns the given fetcher can populate. */
export function countCoveredBy(source: PrimarySource, columns: SourcedColumn[]): number {
  return columns.filter((col) => col.dataSource.includes(source)).length
}

/** Selected columns the given fetcher cannot populate — these would render as blank cells. */
export function columnsNotCoveredBy(source: PrimarySource, columns: SourcedColumn[]): string[] {
  return columns.filter((col) => !col.dataSource.includes(source)).map((col) => col.key)
}

/**
 * Pick the single fetcher that can populate the most selected columns.
 * Returns null when no candidate covers any column (nothing sensible to fetch).
 */
export function pickPrimarySource(columns: SourcedColumn[]): PrimarySource | null {
  let best: PrimarySource | null = null
  let bestCount = 0
  for (const source of SOURCE_PRIORITY) {
    const count = countCoveredBy(source, columns)
    if (count > bestCount) {
      best = source
      bestCount = count
    }
  }
  return best
}
