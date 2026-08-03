// Pure, dependency-free text matching for the admin list screens' client-side search.
//
// Background — the bug this replaces:
// every list page tested each field independently against the WHOLE query:
//
//   [firstname, lastname, username, email].some(f => f.toLowerCase().includes(query))
//
// so a query that spans two fields could never match. Searching "Kelsey Cooper"
// returned nothing (firstname holds only "Kelsey", lastname only "Cooper") while
// "Kelsey" alone found her — reported by the client as "the search still does not
// work accurately". Typing a person's full name is the most natural way to look
// them up, and it was the one query guaranteed to fail.
//
// The rule here instead: split the query on whitespace and require EVERY token to
// appear in AT LEAST ONE field (AND across tokens, OR across fields). Token order
// doesn't matter, so "Cooper Kelsey" works too. A single-token query behaves
// exactly as it did before, so existing partial-match searches are unaffected.

/** Lowercase whitespace-separated tokens; empty/whitespace-only input yields []. */
export function searchTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * True when every token of `query` is a substring of at least one field.
 *
 * An empty/whitespace-only query matches everything (callers treat "no search" as
 * "no filter"). Null/undefined fields are skipped rather than coerced to "null".
 */
export function matchesAllTokens(
  fields: readonly (string | null | undefined)[],
  query: string
): boolean {
  const tokens = searchTokens(query)
  if (tokens.length === 0) return true
  const haystack = fields
    .filter((f): f is string => f != null && f !== '')
    .map((f) => String(f).toLowerCase())
  if (haystack.length === 0) return false
  return tokens.every((token) => haystack.some((field) => field.includes(token)))
}
