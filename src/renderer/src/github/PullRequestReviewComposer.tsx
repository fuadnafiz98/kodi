import type { Ref } from 'react'

import type { PullRequestReviewEvent } from '../../../shared/contracts'
import { PullRequestReviewActions } from './PullRequestReviewActions'
import { PullRequestReviewNotices } from './PullRequestReviewNotices'

export interface PullRequestReviewComposerProps {
  /** `finish` sits at the foot of the review; `toolbar` is the expanded bar. */
  variant: 'toolbar' | 'finish'
  /** The decision being posted to GitHub, or null. */
  submitting: PullRequestReviewEvent | null
  message: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  viewerCanSubmitDecision: boolean
  body: string
  bodyRef: Ref<HTMLTextAreaElement>
  onBodyChange(body: string): void
  onCancel(): void
  onSubmit(event: PullRequestReviewEvent): void
}

export function PullRequestReviewComposer({
  variant,
  submitting,
  message,
  inlineCommentCount,
  orphanedCommentCount,
  viewerCanSubmitDecision,
  body,
  bodyRef,
  onBodyChange,
  onCancel,
  onSubmit
}: PullRequestReviewComposerProps): React.JSX.Element {
  const finish = variant === 'finish'
  const bodyId = finish ? 'pull-request-review-finish-body' : 'pull-request-review-body'

  return (
    <section
      className={finish ? 'pr-review-finish' : 'review-bar pr-review-bar expanded'}
      aria-label={finish ? 'Finish review' : 'Submit pull request review'}
    >
      {finish ? <strong>Finish review</strong> : null}
      <label className="sr-only" htmlFor={bodyId}>Review summary</label>
      <textarea
        ref={bodyRef}
        id={bodyId}
        value={body}
        onChange={(event) => onBodyChange(event.target.value)}
        placeholder={viewerCanSubmitDecision
          ? 'Add an optional approval note, or explain requested changes…'
          : 'Add a review comment…'}
      />
      <PullRequestReviewNotices
        message={message}
        inlineCommentCount={inlineCommentCount}
        orphanedCommentCount={orphanedCommentCount}
        viewerCanSubmitDecision={viewerCanSubmitDecision}
      />
      <PullRequestReviewActions
        showCancel={!finish}
        submitting={submitting}
        blocked={submitting != null || orphanedCommentCount > 0}
        hasReviewContent={body.trim() !== '' || inlineCommentCount > 0}
        viewerCanSubmitDecision={viewerCanSubmitDecision}
        onCancel={onCancel}
        onSubmit={onSubmit}
      />
    </section>
  )
}
