import type { RepositoryReview } from '../../../shared/contracts'

/** What the diff toolbar calls the open review; `undefined` outside a review. */
export function reviewToolbarTitle(review: RepositoryReview | null): string | undefined {
  if (review == null) return undefined
  if (review.kind === 'github') return `#${review.pullRequest.number} ${review.pullRequest.title}`
  return review.title
}

/** The `base → head` line under the title. */
export function reviewToolbarComparison(review: RepositoryReview | null): string | undefined {
  if (review == null) return undefined
  if (review.kind === 'github') {
    return `${review.pullRequest.baseRefName} → ${review.pullRequest.headRefName}`
  }
  return `${review.baseRefName} → ${review.headRefName}`
}

export type ReviewWorldSource = 'desk' | 'patch' | 'since'

/**
 * Which bar sits under the toolbar: the composer, or one of the read-only
 * explanations for why a review cannot be submitted here.
 */
export type ReviewBarMode = 'none' | 'submit' | 'since' | 'closed' | 'local'

export function reviewBarMode(
  review: RepositoryReview | null,
  reviewWorldSource: ReviewWorldSource
): ReviewBarMode {
  if (review == null) return 'none'
  if (review.kind === 'local') return 'local'
  if (reviewWorldSource === 'since') return 'since'
  if (reviewWorldSource === 'patch' && review.pullRequest.state === 'OPEN') return 'submit'
  return 'closed'
}
