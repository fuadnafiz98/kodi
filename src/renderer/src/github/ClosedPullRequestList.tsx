import { IconChevronSm, IconRefresh } from '@pierre/icons'

import type { PullRequestMergeStrategy, PullRequestSummary } from '../../../shared/contracts'
import { PullRequestRow } from './PullRequestRow'
import type { ClosedPullRequests } from './useClosedPullRequests'

export interface ClosedPullRequestListProps {
  closed: ClosedPullRequests
  actionKey: string | null
  onReview(pullRequest: PullRequestSummary): void
  onMerge(pullRequest: PullRequestSummary, strategy: PullRequestMergeStrategy): void
  onMarkReady(pullRequest: PullRequestSummary): void
  onOpenPullRequest(selector: number | string): void
  onCheckout(pullRequest: PullRequestSummary): void
}

export function ClosedPullRequestList({
  closed,
  actionKey,
  onReview,
  onMerge,
  onMarkReady,
  onOpenPullRequest,
  onCheckout
}: ClosedPullRequestListProps): React.JSX.Element {
  return (
    <div className="pr-inbox" aria-label="Closed pull requests">
      {/* The heading is the control. A section that opens does not need a label
          and a separate button beside it: one quiet row reads as a sibling of
          the inbox heading above, where a bordered control read as a stray
          form field parked over empty space. */}
      <button
        type="button"
        className="pr-inbox-heading pr-inbox-disclosure"
        aria-expanded={closed.shown}
        onClick={closed.toggle}
      >
        <IconChevronSm className="pr-inbox-disclosure-chevron" aria-hidden="true" />
        <strong>Closed and merged</strong>
        {closed.pullRequests == null ? null : <span>{closed.pullRequests.length}</span>}
        {closed.loading ? <IconRefresh className="spin" /> : null}
      </button>
      <ClosedPullRequestBody
        closed={closed}
        actionKey={actionKey}
        onReview={onReview}
        onMerge={onMerge}
        onMarkReady={onMarkReady}
        onOpenPullRequest={onOpenPullRequest}
        onCheckout={onCheckout}
      />
    </div>
  )
}

function ClosedPullRequestBody({
  closed,
  actionKey,
  onReview,
  onMerge,
  onMarkReady,
  onOpenPullRequest,
  onCheckout
}: ClosedPullRequestListProps): React.JSX.Element | null {
  if (!closed.shown || closed.loading) return null
  if (closed.error != null) {
    return (
      <div className="git-panel-state">
        <strong>Could not load closed pull requests</strong>
        <span>{closed.error}</span>
      </div>
    )
  }
  if (closed.pullRequests == null) return null
  if (closed.pullRequests.length === 0) {
    return <div className="git-panel-state"><strong>Nothing closed</strong><span>No recently closed pull requests.</span></div>
  }
  return (
    <>
      {closed.pullRequests.map((pullRequest) => (
        <PullRequestRow key={pullRequest.number} summary={pullRequest} details={pullRequest}
          actionKey={actionKey} onReview={onReview} onMerge={onMerge} onMarkReady={onMarkReady}
          onOpenPullRequest={onOpenPullRequest} onCheckout={onCheckout} />
      ))}
    </>
  )
}
