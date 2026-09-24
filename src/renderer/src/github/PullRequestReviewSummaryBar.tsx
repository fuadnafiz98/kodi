import { IconInReview, IconReload } from '@pierre/icons'

import { reviewBarSummary } from './pullRequestReviewBarModel'

export interface NewRevisionNotice {
  headOid: string
  onAdopt(): void
}

export interface PullRequestReviewSummaryBarProps {
  message: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  newRevision?: NewRevisionNotice | null
  expanded?: boolean
  onSubmitReview(): void
}

/**
 * The review session, folded into the diff toolbar's trailing edge: what is
 * ready to send, a pushed head to adopt, and the way into the composer. It only
 * speaks when it has something to say — an idle review is just the button.
 */
export function PullRequestReviewSummaryBar({
  message,
  inlineCommentCount,
  orphanedCommentCount,
  newRevision = null,
  expanded = false,
  onSubmitReview
}: PullRequestReviewSummaryBarProps): React.JSX.Element {
  const meaningful = message != null || inlineCommentCount > 0 || orphanedCommentCount > 0
  const tone = message != null ? ' success' : orphanedCommentCount > 0 ? ' warning' : ''
  return (
    <div className="review-session-inline" role="status">
      {meaningful ? (
        <span className={`review-session-summary${tone}`}>
          {reviewBarSummary(message, inlineCommentCount, orphanedCommentCount)}
        </span>
      ) : null}
      {newRevision == null ? null : (
        <button className="bar-button primary" type="button"
          title={`Pushed ${newRevision.headOid.slice(0, 8)}. Load the pull request at its new head commit`}
          onClick={newRevision.onAdopt}><IconReload />Load new commits</button>
      )}
      <button className="bar-button" type="button" aria-expanded={expanded}
        data-active={expanded ? '' : undefined} onClick={onSubmitReview}>
        <IconInReview />Submit Review
      </button>
    </div>
  )
}
