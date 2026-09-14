import { lazy, Suspense } from 'react'

import type { SessionWorkspaceStage } from '../../../shared/sessionRestore'
import type { WorkspaceLayoutProps } from './appLayoutProps'
import { AgentDock } from '../agent/AgentDock'
import { agentContextLabel } from '../agent/agentReviewContext'
import type { useAgentSession } from '../agent/useAgentSession'
import { WorkspaceRootHost } from './WorkspaceRootHost'

// Only ever seen with no folder open, and it is the one screen that pulls
// FolderPicker and its icons in. Off the boot chunk it goes.
const Welcome = lazy(async () => ({
  default: (await import('../welcome/Welcome')).Welcome
}))

export interface WorkspaceStageProps {
  workspaceStage: SessionWorkspaceStage
  view: WorkspaceLayoutProps
  agent: ReturnType<typeof useAgentSession>
  collisionPaths: ReadonlySet<string>
}

/** Welcome, the opening canvas, or the workspace itself. */
export function WorkspaceStage({
  workspaceStage,
  view,
  agent,
  collisionPaths
}: WorkspaceStageProps): React.JSX.Element | null {
  const { gitWorkflow, snapshot } = view

  if (workspaceStage === 'welcome') {
    if (view.settingsOpen) return null
    return (
      <Suspense fallback={null}>
        <Welcome onOpen={view.openFolder} onOpenPickedFolder={(path) => void view.openFolderFromPicker(path)} opening={view.opening}
          recentFolders={view.recentFolders} openingRecentPath={view.openingRecentPath} onRecentOpen={view.openRecentFolder}
          onRecentRemove={(path) => view.setRecentFolders((current) => current.filter((folder) => folder.path !== path))}
          onOpenPullRequest={(url) => view.gitWorkflow.openPullRequestFromLocator(url)}
          keybindings={view.preferences.keybindings} inboxRepos={view.preferences.inboxRepos} />
      </Suspense>
    )
  }

  if (workspaceStage === 'opening') {
    return (
      <div className="workspace-host workspace-opening" aria-hidden={view.settingsOpen} inert={view.settingsOpen}>
        <div className="workspace-opening-canvas" />
      </div>
    )
  }

  if (snapshot == null) return null

  return (
    <div className="workspace-host" aria-hidden={view.settingsOpen} inert={view.settingsOpen}>
      <div className={`workspace ${view.sidebarVisible ? '' : 'sidebar-hidden'} ${agent.open ? 'agent-open' : ''}`}>
        <WorkspaceRootHost view={view} snapshot={snapshot} agent={agent} collisionPaths={collisionPaths} />
        <AgentDock session={agent}
          confirm={view.confirm}
          contextLabel={agentContextLabel(gitWorkflow.activeWorld ?? null, gitWorkflow.repositoryReview)} />
      </div>
    </div>
  )
}
