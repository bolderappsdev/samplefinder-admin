// Fetch EVERY page of a listable Appwrite collection.
//
// Admin list screens filter/sort some results client-side (e.g. text search across
// several fields, or a status derived from multiple attributes). Those paths cannot
// rely on a single capped fetch: a record outside the fetched window is invisible to
// the client-side filter, so a match can "disappear" until an unrelated filter shifts
// the window. This helper pages through the whole result set instead.
//
// Uses cursor pagination (Query.cursorAfter), NOT offset — mirrors listAllPaged in
// exportService.ts. Cursor paging has no ~5,000-row offset ceiling and is stable when
// many documents share a sort-key value (offset paging can duplicate/skip rows on ties).
//
// `listPage(cursor, limit)` runs one page: the caller adds `Query.cursorAfter(cursor)`
// when cursor is non-null, plus whatever filters/order it needs. It returns the page's
// documents plus the collection's (filtered) total so we can stop on the last page.
export async function fetchAllPages<T extends { $id: string }>(
  listPage: (cursor: string | null, limit: number) => Promise<{ documents: T[]; total: number }>,
  pageSize = 500,
): Promise<T[]> {
  const all: T[] = []
  let cursor: string | null = null
  for (;;) {
    const page = await listPage(cursor, pageSize)
    all.push(...page.documents)
    // Stop on a short/last page or once we've collected the full (filtered) total.
    if (page.documents.length < pageSize || all.length >= page.total) break
    cursor = page.documents[page.documents.length - 1]!.$id
  }
  return all
}
