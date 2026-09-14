/**
 * How the palette reads what the reader typed. `>` switches to commands-only,
 * everything else is a file/content query, and a prefix of the top match is a
 * completion Tab can accept.
 */

export function isCommandOnlyQuery(query: string): boolean {
  return query.trimStart().startsWith('>')
}

export function paletteFilterQuery(query: string): string {
  const trimmed = query.trimStart()
  return trimmed.startsWith('>') ? trimmed.slice(1).trim() : query
}

export function searchQueryForRepository(query: string): string {
  return isCommandOnlyQuery(query) ? '' : query
}

/**
 * The remainder of the best match when the reader has typed a genuine prefix of
 * it — what Tab accepts and what the ghost text shows.
 */
export function pathCompletion(query: string, topMatch: string | undefined): string | null {
  if (query === '' || topMatch == null) return null
  if (topMatch.length <= query.length) return null
  if (!topMatch.toLowerCase().startsWith(query.toLowerCase())) return null
  return topMatch.slice(query.length)
}

export function pullRequestNumber(selector: number | string): number {
  if (typeof selector === 'number') return selector
  const match = /\/pull\/(\d+)/i.exec(selector)
  return Number(match?.[1])
}

export function fileNameFromPath(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}
