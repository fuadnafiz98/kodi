import type { WorkspaceLayoutProps } from './appLayoutProps'
import { CachedWorkspaceFallback } from './CachedWorkspaceFallback'
import type { RepositorySnapshot } from '../../../shared/contracts'
import type { useAgentSession } from '../agent/useAgentSession'


export interface WorkspaceRootHostProps {
  view: WorkspaceLayoutProps
  /** Never null here: the stage only renders this once a snapshot exists. */
  snapshot: RepositorySnapshot
  agent: ReturnType<typeof useAgentSession>
  collisionPaths: ReadonlySet<string>
}

/**
 * The real workspace, or the cached flat list while its chunk is still loading.
 * All of the world-shaped props the viewer needs are resolved here.
 */
export function WorkspaceRootHost({
  view,
  snapshot,
  agent,
  collisionPaths
}: WorkspaceRootHostProps): React.JSX.Element {
  const { gitWorkflow, WorkspaceRoot } = view
  if (WorkspaceRoot == null) {
    return (
      <CachedWorkspaceFallback
        snapshot={snapshot}
        selectedPath={view.selectedPath}
        onSelectPath={view.selectPath}
      />
    )
  }
  return (
    <WorkspaceRoot workspaceKey={snapshot.root}
      theme={view.preferences.editorTheme}
      snapshot={snapshot} selectedPath={view.selectedPath} comparison={view.comparison}
      loadingDiff={view.loadingDiff} diffStyle={view.diffStyle} workspaceView={view.workspaceView}
      preferences={view.preferences} onPreferencesChange={view.setPreferences}
      onAttachToAgent={agent.attach}
      repositoryReview={gitWorkflow.repositoryReview} repositoryChange={view.repositoryChange}
      reviewWorldSource={gitWorkflow.activeWorld?.source === 'new'
        ? 'desk'
        : gitWorkflow.activeWorld?.source ?? 'desk'}
      collisionPaths={collisionPaths}
      initialReviewScrollTop={gitWorkflow.initialReviewScrollTop}
      onReviewScrollPositionChange={gitWorkflow.rememberReviewScroll}
      onSelectPath={view.selectPath} onDiffStyleChange={view.setDiffStyle}
      onWorkspaceViewChange={view.setWorkspaceView}
      onReloadReview={(url) => gitWorkflow.openPullRequestReview(url, snapshot,
        gitWorkflow.activeWorld?.worldId ?? null, { refresh: true })}
      submittingPullRequestReview={gitWorkflow.submittingReview} pullRequestReviewMessage={gitWorkflow.submissionMessage}
      onSubmitPullRequestReview={gitWorkflow.submitReview} onComparisonSaved={view.onComparisonSaved}
      onError={view.setError}
      patchLoadError={gitWorkflow.activeWorld?.source === 'patch'
        ? gitWorkflow.activeWorld.errorMessage
        : null}
      reviewWorldId={gitWorkflow.activeWorld?.worldId ?? `desk:${snapshot.root}`}
      sidebarVisible={view.sidebarVisible}
      onSidebarToggle={view.toggleSidebar}
      onBranchesOpen={gitWorkflow.openBranches} />
  )
}
