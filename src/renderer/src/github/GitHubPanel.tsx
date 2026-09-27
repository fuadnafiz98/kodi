import { useEffect, useMemo, useRef, useState } from 'react'
import { IconBranch, IconX } from '@pierre/icons'
import './GitHubPanel.css'

import type {
  GitIntegrationSnapshot,
  PullRequestMergeStrategy,
  PullRequestInboxSnapshot,
  PullRequestSummary,
  RepositoryStatusEntry
} from '../../../shared/contracts'
import { GitChangesTab } from '../git/GitChangesTab'
import { GitPanelBody } from '../git/GitPanelBody'
import { visiblePullRequestsFor } from '../git/gitPanelInbox'
import { GitPanelTabs } from '../git/GitPanelTabs'
import { FRESHNESS_TICK_MS, isMutatingAction } from '../git/gitPanelModel'
import { GitSyncBar } from '../git/GitSyncBar'
import { parsePullRequestSelector } from './pullRequestSelector'
import { useClosedPullRequests } from './useClosedPullRequests'
import type { CommitOptions, RepositoryPanelTab } from '../git/useGitWorkflow'

export { formatUpdatedAgo } from '../git/gitPanelModel'

interface RepositoryPanelProps {
  open: boolean
  initialTab: RepositoryPanelTab
  root: string
  repositoryName: string
  branch: string | null
  statuses: readonly RepositoryStatusEntry[]
  onTabChange(tab: RepositoryPanelTab): void
  onConfirmStage(paths: readonly string[]): Promise<boolean>
  onStage(paths: readonly string[]): Promise<boolean>
  onUnstage(paths: readonly string[]): Promise<boolean>
  onDiscard(paths: readonly string[], untrackedCount: number): Promise<boolean>
  onCommit(options: CommitOptions): Promise<boolean>
  onOpenChangedFile(path: string): void
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
  root,
  repositoryName,
  branch,
  statuses,
  onTabChange,
  onConfirmStage,
  onStage,
  onUnstage,
  onDiscard,
  onCommit,
  onOpenChangedFile,
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
  const [requestedTab, setRequestedTab] = useState(initialTab)
  // The panel stays mounted while it is open and for its closing transition, so
  // a tab asked for from outside — the titlebar's Source Control while Branches
  // is showing, or a reopen inside the exit window — has to win over the tab in
  // use. Adjusted during render so the old tab never paints for a frame.
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  if (requestedTab !== initialTab) {
    setRequestedTab(initialTab)
    setTab(initialTab)
  }
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
            <span>
              <strong id="git-panel-title">{repositoryName}</strong>
              {/* A live snapshot always names a branch or a short oid; null only means
                  git status has not answered yet. */}
              <small>{branch == null ? 'Reading status…' : <>On <code>{branch}</code></>}</small>
            </span>
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
          changeCount={statuses.length}
          pullRequestCount={pullRequests.visible.length}
          onTabChange={(next) => {
            setTab(next)
            onTabChange(next)
          }}
        />

        <div className="git-panel-content" data-tab={tab}>
          {tab === 'changes' ? (
            // Keyed by repository: pending stages, the selection, collapsed
            // sections and revealed rows all name paths in one repository, and
            // an in-flight stage for A showed as staged on B's same-named row.
            <GitChangesTab
              key={root}
              root={root}
              branch={branch}
              statuses={statuses}
              lastCommitSubject={integration?.commits[0]?.subject ?? null}
              committing={actionKey === 'scm:commit'}
              blocked={mutating && actionKey !== 'scm:commit'}
              onConfirmStage={onConfirmStage}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
              onCommit={onCommit}
              onOpenFile={onOpenChangedFile}
            />
          ) : <GitPanelBody
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
          />}
        </div>
      </aside>
    </dialog>
  )
}
