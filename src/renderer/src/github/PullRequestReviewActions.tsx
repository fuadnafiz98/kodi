import { IconApproved, IconComment, IconWarningOctogonFill, IconX } from '@pierre/icons'

import type { PullRequestReviewEvent } from '../../../shared/contracts'

export interface PullRequestReviewActionsProps {
  /** The finish variant has no Cancel: it lives at the foot of the review. */
  showCancel: boolean
  submitting: boolean
  /** Orphaned comments block every decision until they are dealt with. */
  blocked: boolean
  hasReviewContent: boolean
  viewerCanSubmitDecision: boolean
  onCancel(): void
  onSubmit(event: PullRequestReviewEvent): void
}

export function PullRequestReviewActions({
  showCancel,
  submitting,
  blocked,
  hasReviewContent,
  viewerCanSubmitDecision,
  onCancel,
  onSubmit
}: PullRequestReviewActionsProps): React.JSX.Element {
  const requestChangesTitle = viewerCanSubmitDecision
    ? undefined
    : 'You cannot request changes on your own pull request.'
  const approveTitle = viewerCanSubmitDecision
    ? undefined
    : 'You cannot approve your own pull request.'
  return (
    <div>
      {showCancel ? (
        <button className="bar-button" type="button" onClick={onCancel} disabled={submitting}><IconX />Cancel</button>
      ) : null}
      <button className="bar-button" type="button" onClick={() => onSubmit('comment')}
        disabled={blocked || !hasReviewContent}><IconComment />Comment</button>
      <button
        className="bar-button danger"
        type="button"
        title={requestChangesTitle}
        onClick={() => onSubmit('request-changes')}
        disabled={blocked || !hasReviewContent || !viewerCanSubmitDecision}
      ><IconWarningOctogonFill />Request Changes</button>
      <button
        className="bar-button primary"
        type="button"
        title={approveTitle}
        onClick={() => onSubmit('approve')}
        disabled={blocked || !viewerCanSubmitDecision}
      ><IconApproved />Approve</button>
    </div>
  )
}
