import { useEffect, useMemo, useRef, useState } from 'react'
import { IconBranch, IconX } from '@pierre/icons'
import './GitHubPanel.css'

import type {
  GitIntegrationSnapshot,
  PullRequestMergeStrategy,
  PullRequestInboxSnapshot,
  PullRequestSummary
} from '../../../shared/contracts'
import { GitPanelBody } from '../git/GitPanelBody'
import { visiblePullRequestsFor } from '../git/gitPanelInbox'
import { GitPanelTabs } from '../git/GitPanelTabs'
import { FRESHNESS_TICK_MS, isMutatingAction } from '../git/gitPanelModel'
import { GitSyncBar } from '../git/GitSyncBar'
import { parsePullRequestSelector } from './pullRequestSelector'
import { useClosedPullRequests } from './useClosedPullRequests'
import type { RepositoryPanelTab } from '../git/useGitWorkflow'

export { formatUpdatedAgo } from '../git/gitPanelModel'

interface RepositoryPanelProps {
  open: boolean
  initialTab: RepositoryPanelTab
  integration: GitIntegrationSnapshot | null
  loading: boolean
  inbox: PullRequestInboxSnapshot | null
  loadingInbox: boolean
  actionKey: string | null
  onClose(): void
  onSwitchBranch(name: string): void
  onReviewLocalBranch(baseRef: string, headRef: string): void
  onReviewCommit(oid: string): void
  onFetch(): void
  onPull(): void
  onPush(): void
  onReview(pullRequest: PullRequestSummary): void
  onMerge(pullRequest: PullRequestSummary, strategy: PullRequestMergeStrategy): void
  onMarkReady(pullRequest: PullRequestSummary): void
  onOpenPullRequest(selector: number | string): void
  onCheckout(pullRequest: PullRequestSummary): void
  onRefresh?(): void
  updatedAt: number | null
}

export function RepositoryPanel({
  open,
  initialTab,
  integration,
  loading,
  inbox,
  loadingInbox,
  actionKey,
  onClose,
  onSwitchBranch,
  onReviewLocalBranch,
  onReviewCommit,
  onFetch,
  onPull,
  onPush,
  onReview,
  onMerge,
  onMarkReady,
  onOpenPullRequest,
  onCheckout,
  onRefresh,
  updatedAt
}: RepositoryPanelProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<RepositoryPanelTab>(initialTab)
  const [selectedBaseBranch, setSelectedBaseBranch] = useState('')
  const [pullRequestQuery, setPullRequestQuery] = useState('')
  const [pullRequestQueryError, setPullRequestQueryError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const closed = useClosedPullRequests()
  const currentBranch = integration?.branches.find((branch) => branch.current)?.name ?? null
  const mutating = isMutatingAction(actionKey)
  const pullRequests = visiblePullRequestsFor(inbox, integration)
  const pullRequestsByNumber = useMemo(
    () => new Map(integration?.pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]) ?? []),
    [integration?.pullRequests]
  )
  const baseBranch = selectedBaseBranch || integration?.defaultBranch || currentBranch || ''

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog == null) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
    return () => {
      if (dialog.open) dialog.close()
    }
  }, [open])

  useEffect(() => {
    if (updatedAt == null) return
    const timer = window.setInterval(() => setNow(Date.now()), FRESHNESS_TICK_MS)
    return () => window.clearInterval(timer)
  }, [updatedAt])

  const submitPullRequestQuery = (): void => {
    const selector = parsePullRequestSelector(pullRequestQuery)
    if (selector == null) {
      setPullRequestQueryError('Enter a PR number or a GitHub pull request URL.')
      return
    }
    setPullRequestQueryError(null)
    onOpenPullRequest(selector)
  }

  return (
    <dialog
      ref={dialogRef}
      className="git-panel-layer"
      aria-labelledby="git-panel-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <button
        className="git-panel-dismiss-area"
        type="button"
        tabIndex={-1}
        aria-label="Close repository panel"
        onClick={onClose}
      />
      <aside className="git-panel">
        <header className="git-panel-header">
          <div>
            <IconBranch />
            <span><strong id="git-panel-title">Repository</strong><small>Local Git · GitHub optional</small></span>
          </div>
          <div>
            <button type="button" onClick={onClose} aria-label="Close repository panel" title="Close Repository Panel"><IconX /></button>
          </div>
        </header>

        <GitSyncBar
          integration={integration}
          loading={loading}
          loadingInbox={loadingInbox}
          actionKey={actionKey}
          mutating={mutating}
          syncing={actionKey?.startsWith('sync:') === true}
          updatedAt={updatedAt}
          now={now}
          onRefresh={onRefresh}
          onFetch={onFetch}
          onPull={onPull}
          onPush={onPush}
        />

        <GitPanelTabs
          tab={tab}
          integration={integration}
          pullRequestCount={pullRequests.visible.length}
          onTabChange={setTab}
        />

        <div className="git-panel-content">
          <GitPanelBody
            tab={tab}
            integration={integration}
            loading={loading}
            inbox={inbox}
            loadingInbox={loadingInbox}
            actionKey={actionKey}
            mutating={mutating}
            baseBranch={baseBranch}
            visiblePullRequests={pullRequests.visible}
            inboxPullRequestCount={pullRequests.inboxCount}
            pullRequestsByNumber={pullRequestsByNumber}
            closed={closed}
            pullRequestQuery={pullRequestQuery}
            pullRequestQueryError={pullRequestQueryError}
            onBaseBranchChange={setSelectedBaseBranch}
            onPullRequestQueryChange={(query) => {
              setPullRequestQuery(query)
              if (pullRequestQueryError != null) setPullRequestQueryError(null)
            }}
            onSubmitPullRequestQuery={submitPullRequestQuery}
            onSwitchBranch={onSwitchBranch}
            onReviewLocalBranch={onReviewLocalBranch}
            onReviewCommit={onReviewCommit}
            onReview={onReview}
            onMerge={onMerge}
            onMarkReady={onMarkReady}
            onOpenPullRequest={onOpenPullRequest}
            onCheckout={onCheckout}
          />
        </div>
      </aside>
    </dialog>
  )
}
