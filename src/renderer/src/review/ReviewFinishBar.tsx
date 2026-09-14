import type { PullRequestReviewEvent, RepositoryReview } from '../../../shared/contracts'
import { PullRequestReviewBar } from '../github/PullRequestReviewBar'
import { reviewBarMode, type ReviewWorldSource } from './reviewHeaderModel'

export interface ReviewFinishBarProps {
  /** Only the multi-file review ends with a composer; the file view does not. */
  visible: boolean
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
  onOpen,
  onSubmit
}: ReviewFinishBarProps): React.JSX.Element | null {
  if (!visible) return null
  if (reviewBarMode(review, reviewWorldSource) !== 'submit' || review?.kind !== 'github') return null
  return (
    <PullRequestReviewBar
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
      onOpen={onOpen}
      onSubmit={onSubmit}
    />
  )
}
