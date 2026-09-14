import { IconCheck, IconInReview } from '@pierre/icons'

import { reviewBarSummary } from './pullRequestReviewBarModel'
import { ReviewCheckpointStatus, type ReviewCheckpointBarProps } from '../review/ReviewCheckpointStatus'

export interface PullRequestReviewSummaryBarProps {
  message: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  checkpointBar?: ReviewCheckpointBarProps
  onSubmitReview(): void
}

/**
 * The collapsed review-session bar: which baseline this review is against,
 * what is ready to send, and the way into the composer — one strip, not two.
 */
export function PullRequestReviewSummaryBar({
  message,
  inlineCommentCount,
  orphanedCommentCount,
  checkpointBar,
  onSubmitReview
}: PullRequestReviewSummaryBarProps): React.JSX.Element {
  const meaningful = message != null || inlineCommentCount > 0 || orphanedCommentCount > 0
  return (
    <div className="review-bar review-session-bar" role="status">
      <div className="review-session-status">
        {checkpointBar == null ? null : <ReviewCheckpointStatus {...checkpointBar} />}
        {meaningful ? (
          <span className={`review-session-summary${message == null ? '' : ' success'}`}>
            {reviewBarSummary(message, inlineCommentCount, orphanedCommentCount)}
          </span>
        ) : checkpointBar == null ? (
          <span className="review-session-summary">Review this pull request on GitHub</span>
        ) : null}
      </div>
      <div className="review-session-actions">
        {checkpointBar == null ? null : (
          <button
            className="bar-button"
            type="button"
            disabled={!checkpointBar.reviewReady}
            title={checkpointBar.reviewReady ? 'Save this complete patch as the review baseline' : 'Wait for the complete patch'}
            onClick={checkpointBar.onSetCheckpoint}
          ><IconCheck />{checkpointBar.checkpoint == null ? 'Set checkpoint' : 'Update checkpoint'}</button>
        )}
        <button className="bar-button" type="button" onClick={onSubmitReview}><IconInReview />Submit Review</button>
      </div>
    </div>
  )
}
