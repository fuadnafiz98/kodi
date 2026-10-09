import type { StartupReviewFetch } from './startupReview'

// Lives in the entry chunk, which starts the launch's review fetch before the
// boot chunk has even arrived; the review chunk takes it from here. Types only
// from `startupReview`, so the entry does not pull the review's code in.
let request: Promise<StartupReviewFetch | null> | null = null

export function requestStartupReview(start: () => Promise<StartupReviewFetch | null>): void {
  request = start().catch(() => null)
}

export function peekStartupReviewRequest(): Promise<StartupReviewFetch | null> | null {
  return request
}

/** The launch's request, once; null when the launch made none or it was taken. */
export function takeStartupReviewRequest(): Promise<StartupReviewFetch | null> | null {
  const taken = request
  request = null
  return taken
}
