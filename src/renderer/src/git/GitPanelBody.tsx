import { IconRefresh } from '@pierre/icons'

import type {
  GitIntegrationSnapshot,
  InboxPullRequest,
  PullRequestInboxSnapshot,
  PullRequestMergeStrategy,
  PullRequestSummary
} from '../../../shared/contracts'
import { GitBranchesTab } from './GitBranchesTab'
import { GitHistoryTab } from './GitHistoryTab'
import { GitPullRequestsTab } from './GitPullRequestsTab'
import { GitRemotesTab } from './GitRemotesTab'
import type { ClosedPullRequests } from '../github/useClosedPullRequests'
import type { RepositoryPanelTab } from './useGitWorkflow'

export interface GitPanelBodyProps {
  tab: RepositoryPanelTab
  integration: GitIntegrationSnapshot | null
  loading: boolean
  inbox: PullRequestInboxSnapshot | null
  loadingInbox: boolean
  actionKey: string | null
  /** Any action holding the index or HEAD, which blocks a branch switch. */
  mutating: boolean
  baseBranch: string
  visiblePullRequests: readonly (PullRequestSummary | InboxPullRequest)[]
  inboxPullRequestCount: number
  pullRequestsByNumber: ReadonlyMap<number, PullRequestSummary>
  closed: ClosedPullRequests
  pullRequestQuery: string
  pullRequestQueryError: string | null
  onBaseBranchChange(name: string): void
  onPullRequestQueryChange(query: string): void
  onSubmitPullRequestQuery(): void
  onSwitchBranch(name: string): void
  onReviewLocalBranch(baseRef: string, headRef: string): void
  onReviewCommit(oid: string): void
  onReview(pullRequest: PullRequestSummary): void
  onMerge(pullRequest: PullRequestSummary, strategy: PullRequestMergeStrategy): void
  onMarkReady(pullRequest: PullRequestSummary): void
  onOpenPullRequest(selector: number | string): void
  onCheckout(pullRequest: PullRequestSummary): void
}

/** Whichever tab is selected, or the first-load state. */
export function GitPanelBody({
  tab,
  integration,
  loading,
  inbox,
  loadingInbox,
  actionKey,
  mutating,
  baseBranch,
  visiblePullRequests,
  inboxPullRequestCount,
  pullRequestsByNumber,
  closed,
  pullRequestQuery,
  pullRequestQueryError,
  onBaseBranchChange,
  onPullRequestQueryChange,
  onSubmitPullRequestQuery,
  onSwitchBranch,
  onReviewLocalBranch,
  onReviewCommit,
  onReview,
  onMerge,
  onMarkReady,
  onOpenPullRequest,
  onCheckout
}: GitPanelBodyProps): React.JSX.Element {
  if (loading && integration == null) {
    return <div className="git-panel-state"><IconRefresh className="spin" /><span>Loading repository data…</span></div>
  }
  if (tab === 'history') {
    return <GitHistoryTab integration={integration} actionKey={actionKey} onReviewCommit={onReviewCommit} />
  }
  if (tab === 'pull-requests') {
    return (
      <GitPullRequestsTab
        integration={integration}
        inbox={inbox}
        loadingInbox={loadingInbox}
        visiblePullRequests={visiblePullRequests}
        inboxPullRequestCount={inboxPullRequestCount}
        pullRequestsByNumber={pullRequestsByNumber}
        actionKey={actionKey}
        closed={closed}
        pullRequestQuery={pullRequestQuery}
        pullRequestQueryError={pullRequestQueryError}
        onPullRequestQueryChange={onPullRequestQueryChange}
        onSubmitPullRequestQuery={onSubmitPullRequestQuery}
        onReview={onReview}
        onMerge={onMerge}
        onMarkReady={onMarkReady}
        onOpenPullRequest={onOpenPullRequest}
        onCheckout={onCheckout}
      />
    )
  }
  if (tab === 'branches') {
    return (
      <GitBranchesTab
        integration={integration}
        actionKey={actionKey}
        mutating={mutating}
        baseBranch={baseBranch}
        onBaseBranchChange={onBaseBranchChange}
        onSwitchBranch={onSwitchBranch}
        onReviewLocalBranch={onReviewLocalBranch}
      />
    )
  }
  return <GitRemotesTab integration={integration} />
}
