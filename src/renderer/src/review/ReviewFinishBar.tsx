import type { PullRequestReviewEvent, RepositoryReview } from '../../../shared/contracts'
import { pullRequestReviewBarModule } from './ReviewStatusBar'
import { useLazyModule } from '../app/lazyModule'
import { reviewBarMode, type ReviewWorldSource } from './reviewHeaderModel'

export interface ReviewFinishBarProps {
  /** Only the multi-file review ends with a composer; the file view does not. */
  visible: boolean
  review: RepositoryReview | null
  reviewWorldSource: ReviewWorldSource
  /** The decision being posted to GitHub, or null. */
  submitting: PullRequestReviewEvent | null
  message: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  expanded: boolean
  body: string
  onExpandedChange(expanded: boolean): void
  onBodyChange(body: string): void
  onSubmit(event: PullRequestReviewEvent, body: string): Promise<boolean>
}

/** The composer at the foot of a multi-file review, after the last file. */
export function ReviewFinishBar({
  visible,
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
  onSubmit
}: ReviewFinishBarProps): React.JSX.Element | null {
  // Asked for as soon as a pull request review is on screen, so it is here
  // before the reader reaches the foot of the review.
  const wanted = visible && review?.kind === 'github' && reviewBarMode(review, reviewWorldSource) === 'submit'
  const bar = useLazyModule(pullRequestReviewBarModule, wanted)
  if (!wanted || review?.kind !== 'github' || bar == null) return null
  return (
    <bar.PullRequestReviewBar
      variant="finish"
      submitting={submitting}
      message={message}
      inlineCommentCount={inlineCommentCount}
      orphanedCommentCount={orphanedCommentCount}
      viewerCanSubmitDecision={review.viewerCanSubmitDecision}
      expanded={expanded}
      body={body}
      onExpandedChange={onExpandedChange}
      onBodyChange={onBodyChange}
      onSubmit={onSubmit}
    />
  )
}
