import { IconApproved, IconComment, IconRefresh, IconWarningOctogonFill, IconX } from '@pierre/icons'

import type { PullRequestReviewEvent } from '../../../shared/contracts'

export interface PullRequestReviewActionsProps {
  /** The finish variant has no Cancel: it lives at the foot of the review. */
  showCancel: boolean
  /** The decision being posted to GitHub, or null. Its button says so meanwhile. */
  submitting: PullRequestReviewEvent | null
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
  const spinner = <IconRefresh className="spin" />
  return (
    <div>
      {showCancel ? (
        <button className="bar-button" type="button" onClick={onCancel} disabled={submitting != null}><IconX />Cancel</button>
      ) : null}
      <button className="bar-button" type="button" onClick={() => onSubmit('comment')}
        disabled={blocked || !hasReviewContent} aria-busy={submitting === 'comment'}>
        {submitting === 'comment' ? <>{spinner}Commenting…</> : <><IconComment />Comment</>}
      </button>
      <button
        className="bar-button danger"
        type="button"
        title={requestChangesTitle}
        onClick={() => onSubmit('request-changes')}
        disabled={blocked || !hasReviewContent || !viewerCanSubmitDecision}
        aria-busy={submitting === 'request-changes'}
      >{submitting === 'request-changes' ? <>{spinner}Requesting Changes…</> : <><IconWarningOctogonFill />Request Changes</>}</button>
      <button
        className="bar-button primary"
        type="button"
        title={approveTitle}
        onClick={() => onSubmit('approve')}
        disabled={blocked || !viewerCanSubmitDecision}
        aria-busy={submitting === 'approve'}
      >{submitting === 'approve' ? <>{spinner}Approving…</> : <><IconApproved />Approve</>}</button>
    </div>
  )
}
