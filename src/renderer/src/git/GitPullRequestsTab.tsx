import { IconRefresh } from '@pierre/icons'

import type {
  GitIntegrationSnapshot,
  InboxPullRequest,
  PullRequestInboxSnapshot,
  PullRequestMergeStrategy,
  PullRequestSummary
} from '../../../shared/contracts'
import { ClosedPullRequestList } from '../github/ClosedPullRequestList'
import { OpenPullRequestForm } from '../github/OpenPullRequestForm'
import { PullRequestRow } from '../github/PullRequestRow'
import type { ClosedPullRequests } from '../github/useClosedPullRequests'

export interface GitPullRequestsTabProps {
  integration: GitIntegrationSnapshot | null
  inbox: PullRequestInboxSnapshot | null
  loadingInbox: boolean
  /** The inbox when it has anything, otherwise the repository's own list. */
  visiblePullRequests: readonly (PullRequestSummary | InboxPullRequest)[]
  inboxPullRequestCount: number
  pullRequestsByNumber: ReadonlyMap<number, PullRequestSummary>
  actionKey: string | null
  closed: ClosedPullRequests
  pullRequestQuery: string
  pullRequestQueryError: string | null
  onPullRequestQueryChange(query: string): void
  onSubmitPullRequestQuery(): void
  onReview(pullRequest: PullRequestSummary): void
  onMerge(pullRequest: PullRequestSummary, strategy: PullRequestMergeStrategy): void
  onMarkReady(pullRequest: PullRequestSummary): void
  onOpenPullRequest(selector: number | string): void
  onCheckout(pullRequest: PullRequestSummary): void
}

export function GitPullRequestsTab({
  integration,
  inbox,
  loadingInbox,
  visiblePullRequests,
  inboxPullRequestCount,
  pullRequestsByNumber,
  actionKey,
  closed,
  pullRequestQuery,
  pullRequestQueryError,
  onPullRequestQueryChange,
  onSubmitPullRequestQuery,
  onReview,
  onMerge,
  onMarkReady,
  onOpenPullRequest,
  onCheckout
}: GitPullRequestsTabProps): React.JSX.Element {
  const heading = inbox?.available === true && inboxPullRequestCount > 0
    ? 'Inbox'
    : 'Repository pull requests'
  return (
    <section className="pr-list" aria-label="Recent pull requests">
      <OpenPullRequestForm
        query={pullRequestQuery}
        error={pullRequestQueryError}
        opening={actionKey?.startsWith('review:') === true}
        onQueryChange={onPullRequestQueryChange}
        onSubmit={onSubmitPullRequestQuery}
      />
      <div className="pr-inbox" aria-label="Pull requests">
        <div className="pr-inbox-heading">
          <strong>{heading}</strong>
          <span>{visiblePullRequests.length}</span>
          {loadingInbox ? <IconRefresh className="spin" /> : null}
        </div>
        {visiblePullRequests.length === 0 && loadingInbox ? null : visiblePullRequests.length === 0 ? (
          <div className="git-panel-state"><strong>Inbox zero</strong><span>Nothing needs your review right now.</span></div>
        ) : visiblePullRequests.map((pullRequest) => (
          <PullRequestRow key={pullRequest.number} summary={pullRequest}
            details={pullRequestsByNumber.get(pullRequest.number)} actionKey={actionKey}
            onReview={onReview} onMerge={onMerge} onMarkReady={onMarkReady}
            onOpenPullRequest={onOpenPullRequest} onCheckout={onCheckout} />
        ))}
      </div>
      <ClosedPullRequestList
        closed={closed}
        actionKey={actionKey}
        onReview={onReview}
        onMerge={onMerge}
        onMarkReady={onMarkReady}
        onOpenPullRequest={onOpenPullRequest}
        onCheckout={onCheckout}
      />
      {integration?.githubAvailable === false ? (
        <div className="git-panel-notice"><strong>GitHub is unavailable</strong><span>{integration.githubMessage}</span></div>
      ) : null}
    </section>
  )
}
