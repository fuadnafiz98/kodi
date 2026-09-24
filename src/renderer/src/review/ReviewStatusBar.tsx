import type { PullRequestReviewEvent, RepositoryReview } from '../../../shared/contracts'
import { PullRequestReviewBar } from '../github/PullRequestReviewBar'
import { PullRequestReviewSummaryBar, type NewRevisionNotice } from '../github/PullRequestReviewSummaryBar'
import { reviewBarMode, type ReviewWorldSource } from './reviewHeaderModel'

export interface ReviewStatusBarProps {
  review: RepositoryReview | null
  reviewWorldSource: ReviewWorldSource
  submitting: boolean
  message: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  expanded: boolean
  body: string
  onExpandedChange(expanded: boolean): void
  onBodyChange(body: string): void
  onOpen(): void
  onSubmit(event: PullRequestReviewEvent, body: string): Promise<boolean>
}

/**
 * The composer, and only while it is open. Everything the collapsed bar used to
 * say now lives on the toolbar row — see `ReviewToolbarActions` and
 * `ReviewToolbarBadge` — so a review costs one header row, not two.
 */
export function ReviewStatusBar({
  review,
  reviewWorldSource,
  submitting,
  message,
  inlineCommentCount,
  orphanedCommentCount,
  expanded,
  body,
  onExpandedChange,
  onBodyChange,
  onOpen,
  onSubmit
}: ReviewStatusBarProps): React.JSX.Element | null {
  if (!expanded || review?.kind !== 'github' || reviewBarMode(review, reviewWorldSource) !== 'submit') return null
  return (
    <PullRequestReviewBar
      submitting={submitting}
      message={message}
      inlineCommentCount={inlineCommentCount}
      orphanedCommentCount={orphanedCommentCount}
      viewerCanSubmitDecision={review.viewerCanSubmitDecision}
      expanded
      body={body}
      onExpandedChange={onExpandedChange}
      onBodyChange={onBodyChange}
      onOpen={onOpen}
      onSubmit={onSubmit}
    />
  )
}

export interface ReviewToolbarActionsProps {
  review: RepositoryReview | null
  reviewWorldSource: ReviewWorldSource
  message: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  newRevision: NewRevisionNotice | null
  expanded: boolean
  onExpandedChange(expanded: boolean): void
  onOpen(): void
}

/** The review session's status and its composer toggle, on the toolbar row. */
export function ReviewToolbarActions({
  review,
  reviewWorldSource,
  message,
  inlineCommentCount,
  orphanedCommentCount,
  newRevision,
  expanded,
  onExpandedChange,
  onOpen
}: ReviewToolbarActionsProps): React.JSX.Element | null {
  if (reviewBarMode(review, reviewWorldSource) !== 'submit') return null
  return (
    <PullRequestReviewSummaryBar
      message={message}
      inlineCommentCount={inlineCommentCount}
      orphanedCommentCount={orphanedCommentCount}
      newRevision={newRevision}
      expanded={expanded}
      onSubmitReview={() => {
        if (!expanded) onOpen()
        onExpandedChange(!expanded)
      }}
    />
  )
}

/**
 * Why this review cannot be submitted, as a quiet pill beside the comparison.
 * The full sentence moved into its tooltip.
 */
export function ReviewToolbarBadge({
  review,
  reviewWorldSource
}: {
  review: RepositoryReview | null
  reviewWorldSource: ReviewWorldSource
}): React.JSX.Element | null {
  const mode = reviewBarMode(review, reviewWorldSource)
  if (mode === 'closed' && review?.kind === 'github') {
    const state = review.pullRequest.state.toLowerCase()
    return (
      <span className={`review-state-pill state-${state}`}
        title={`This pull request is ${state}. Review submission is disabled.`}>
        {state}
      </span>
    )
  }
  if (mode === 'local') {
    return (
      <span className="review-state-pill"
        title="Local branch review. Comments stay local and can be copied from the review summary.">
        local
      </span>
    )
  }
  return null
}
