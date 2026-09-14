export const CONTENT_SEARCH_MIN_QUERY_LENGTH = 3

// The debounce buys two things at once: fewer ripgrep spawns, and a first result
// the reader did not wait for. A longer query is a narrower search and a stronger
// signal that the reader has stopped composing, so it waits less.
export const CONTENT_SEARCH_SHORT_QUERY_MS = 180
export const CONTENT_SEARCH_MEDIUM_QUERY_MS = 120
export const CONTENT_SEARCH_LONG_QUERY_MS = 90
export const CONTENT_SEARCH_LONG_QUERY_LENGTH = 5

/**
 * `src/renderer/App` is navigation, not grep. Content search still runs — the
 * reader may well be looking for that string — but only after a real pause.
 */
export const CONTENT_SEARCH_PATH_PAUSE_MS = 250

/**
 * A slash is the whole rule. Counting file-name hits as a second path signal
 * looked reasonable and was wrong: "app" is an ordinary word that happens to
 * prefix a dozen file names in a large repository, and it paid the pause for it
 * — 419 ms to the first content result where the budget is 150 ms.
 */
export function isPathLikeQuery(query: string): boolean {
  return query.includes('/')
}

export function contentSearchDelay(
  previousQuery: string,
  nextQuery: string,
  pathLike = false
): number {
  const previousLength = previousQuery.trim().length
  const nextLength = nextQuery.trim().length
  if (nextLength < CONTENT_SEARCH_MIN_QUERY_LENGTH) return CONTENT_SEARCH_SHORT_QUERY_MS
  if (pathLike) return CONTENT_SEARCH_PATH_PAUSE_MS
  // More than one character at once is a paste, not typing: nothing more is coming.
  if (nextLength - previousLength > 1) return 0
  return nextLength < CONTENT_SEARCH_LONG_QUERY_LENGTH
    ? CONTENT_SEARCH_MEDIUM_QUERY_MS
    : CONTENT_SEARCH_LONG_QUERY_MS
}

interface QueryEvent {
  at: number
  query: string
}

export interface SearchScheduleResult {
  starts: number
  stableQueryDelay: number
}

export function simulateContentSearchSchedule(
  events: readonly QueryEvent[],
  delayForQuery: (previousQuery: string, nextQuery: string) => number
): SearchScheduleResult {
  let previousQuery = ''
  let pendingAt: number | null = null
  let starts = 0
  for (const event of events) {
    if (pendingAt != null && pendingAt <= event.at) starts += 1
    pendingAt = null
    const delay = delayForQuery(previousQuery, event.query)
    previousQuery = event.query
    if (event.query.trim().length >= CONTENT_SEARCH_MIN_QUERY_LENGTH) pendingAt = event.at + delay
  }
  if (pendingAt != null) starts += 1
  const lastEvent = events.at(-1)
  return {
    starts,
    stableQueryDelay: lastEvent == null ? 0 : delayForQuery(
      events.at(-2)?.query ?? '',
      lastEvent.query
    )
  }
}
