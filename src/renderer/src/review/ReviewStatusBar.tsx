import type { PullRequestReviewEvent, RepositoryReview } from '../../../shared/contracts'
import { PullRequestReviewBar } from '../github/PullRequestReviewBar'
import type { ReviewCheckpointBarProps } from './ReviewCheckpointStatus'
import { reviewBarMode, type ReviewWorldSource } from './reviewHeaderModel'

export interface ReviewStatusBarProps {
  review: RepositoryReview | null
  reviewWorldSource: ReviewWorldSource
  submitting: boolean
  message: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  checkpointBar?: ReviewCheckpointBarProps
  expanded: boolean
  body: string
  onExpandedChange(expanded: boolean): void
  onBodyChange(body: string): void
  onOpen(): void
  onSubmit(event: PullRequestReviewEvent, body: string): Promise<boolean>
}

/**
 * The composer, or the one-line reason this review cannot be submitted from
 * where the reader is standing.
 */
export function ReviewStatusBar({
  review,
  reviewWorldSource,
  submitting,
  message,
  inlineCommentCount,
  orphanedCommentCount,
  checkpointBar,
  expanded,
  body,
  onExpandedChange,
  onBodyChange,
  onOpen,
  onSubmit
}: ReviewStatusBarProps): React.JSX.Element | null {
  const mode = reviewBarMode(review, reviewWorldSource)
  if (mode === 'submit' && review?.kind === 'github') {
    return (
      <PullRequestReviewBar
        submitting={submitting}
        message={message}
        inlineCommentCount={inlineCommentCount}
        orphanedCommentCount={orphanedCommentCount}
        viewerCanSubmitDecision={review.viewerCanSubmitDecision}
        checkpointBar={checkpointBar}
        expanded={expanded}
        body={body}
        onExpandedChange={onExpandedChange}
        onBodyChange={onBodyChange}
        onOpen={onOpen}
        onSubmit={onSubmit}
      />
    )
  }
  if (mode === 'since') {
    return (
      <div className="review-bar pr-review-readonly" role="status">
        File-level changes since the checkpoint. Return to the Patch world to submit a review.
      </div>
    )
  }
  if (mode === 'closed' && review?.kind === 'github') {
    return (
      <div className="review-bar pr-review-readonly" role="status">
        This pull request is {review.pullRequest.state.toLowerCase()}. Review submission is disabled.
      </div>
    )
  }
  if (mode === 'local') {
    return (
      <div className="review-bar pr-review-readonly" role="status">Local branch review. Comments stay local and can be copied from the review summary.</div>
    )
  }
  return null
}
