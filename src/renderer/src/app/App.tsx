import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useLayoutEffect,
  useState,
  type CSSProperties
} from 'react'

import type { RepositoryChangeEvent, RepositorySnapshot } from '../../../shared/contracts'
import type { DiffStyle, WorkspaceView } from './AppView'
import type { AppLayoutProps, WorkspaceLayoutProps } from './appLayoutProps'
import { AppChrome } from './AppChrome'
import { WorkspaceStage } from './WorkspaceStage'
import { useAppCommands, useCommandPaletteControls } from './useAppCommands'
import { useHibernationListener } from './useHibernation'
import { useAppPersistence } from './useAppPersistence'
import { useExternalPullRequest } from '../github/useExternalPullRequest'
import { useFolderOpen } from '../explorer/useFolderOpen'
import { useSessionRestore } from './useSessionRestore'
import { useRepositoryChangeSync } from './useRepositoryChangeSync'
import { ErrorBanner } from './ErrorBanner'
import { CommandPaletteHost } from '../palette/CommandPaletteHost'
import { formatTerminalToggleShortcut } from '../settings/keybindings'
import {
  CODE_FONTS,
  getEditorThemeType,
  loadPreferences,
  type AppPreferences
} from '../settings/preferences'
import { accentVars, themePaletteVars } from '../settings/themePalette'
import { PullRequestLoadingIndicator } from '../github/PullRequestLoadingIndicator'
import { isPullRequestWorkspacePending } from '../github/pullRequestOpen'
import { getErrorMessage } from '../explorer/repositoryApi'
import { useRecentFiles } from '../explorer/recentFiles'
import {
  loadRecentFolders,
  rememberRecentFolder,
  saveRecentFolders,
  type RecentFolder
} from '../explorer/recentFolders'
import { useGitWorkflow } from '../git/useGitWorkflow'
import { useAgentSession } from '../agent/useAgentSession'
import { useTerminalVisibility } from '../terminal/useTerminalVisibility'
import { includesPath, retainSnapshotIdentity, snapshotLooksUnchanged } from '../explorer/snapshotPaths'
import { useComparisonLoader } from '../review/useComparisonLoader'
import { usePresence, useRetainedPresence } from './usePresence'
import { ConfirmDialog } from './ConfirmDialog'
import { useConfirm } from './useConfirm'
import { agentSubjectForWorld, formatAgentReviewContext } from '../agent/agentReviewContext'
import { openFileInEditor, setEditorCommand } from '../review/editorTarget'
import { installDefinitionTrigger, setDefinitionOpeners } from '../definitions/definitionTrigger'
import { requestReveal } from './revealLocation'
import { considerAutoGuide, expectExternalGuide, publishGuideAgent } from '../review/reviewGuideView'
import { sessionWorkspaceStage } from '../../../shared/sessionRestore'
import { comparisonFromCachedText, initialWorkspacePaint } from '../../../shared/workspaceCache'
import { automaticWorkspaceView, firstOpenPathForSnapshot } from '../explorer/workspaceMode'
import { openInWorkspace, revealInExplorer } from '../explorer/explorerReveal'
import { isLiveSnapshot, reportAppliedSnapshot } from '../explorer/folderOpenSettle'
import { findCollisionPaths, newWorldHoldsReview } from '../review/useReviewWorlds'
import {
  getLoadedWorkspaceRoot,
  preloadWorkspaceRoot,
  preloadWorkspaceViewer,
  subscribeWorkspaceRoot,
  useLoadedModule
} from './workspaceBoot'
import { markRendererStartup } from './startupMetrics'
import { loadRepositoryPanel } from '../git/repositoryPanelChunk'

const TerminalDock = lazy(() => import('../terminal/TerminalDock'))
const RepositoryPanel = lazy(async () => ({
  default: (await loadRepositoryPanel()).RepositoryPanel
}))
const SettingsPage = lazy(async () => ({
  default: (await import('../settings/SettingsPage')).SettingsPage
}))
// The titlebar reserves 92px for the traffic lights; in fullscreen there are
// none, so the CSS collapses the reserve off this attribute.
function useFullscreenSync(): void {
  useEffect(() => window.repository?.onFullscreenChange((fullscreen) => {
    document.documentElement.dataset.fullscreen = fullscreen ? 'true' : ''
  }), [])
}

function useWindowVisibilitySync(): void {
  useEffect(() => {
    let frame = 0
    let wasHidden = document.hidden
    const refreshLayout = (): void => {
      void window.repository?.setVisibility(!document.hidden)
      if (document.hidden) {
        wasHidden = true
        return
      }
      if (!wasHidden) return
      wasHidden = false
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
      })
    }
    document.addEventListener('visibilitychange', refreshLayout)
    window.addEventListener('focus', refreshLayout)
    void window.repository?.setVisibility(!document.hidden)
    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', refreshLayout)
      window.removeEventListener('focus', refreshLayout)
      void window.repository?.setVisibility(false)
    }
  }, [])
}

const AgentSessionLayout = memo(function AgentSessionLayout(view: WorkspaceLayoutProps): React.JSX.Element {
  const { gitWorkflow } = view
  // Main drives this from the snooze clock; the vetoes registered elsewhere in
  // the tree decide whether it is safe before any payload is released.
  useHibernationListener(gitWorkflow.hibernateReviews)
  // Both surfaces have a closed-state rule in styles.css that only bites while
  // the node is still in the tree, so presence holds them for the exit.
  const reviewLoadingPresence = usePresence(gitWorkflow.actionKey?.startsWith('review:') ?? false, 160)
  const repositoryPanelPresence = usePresence(gitWorkflow.panelOpen, 220)
  // The message is null the moment the banner is dismissed; the exit still needs text.
  const errorPresence = useRetainedPresence(view.error, 160)
  // Keep the tab/review summary stable while answer tokens stream.
  const agentSubject = useMemo(
    () => agentSubjectForWorld(gitWorkflow.activeWorld),
    [gitWorkflow.activeWorld]
  )
  const agentContext = useMemo(
    () => formatAgentReviewContext(gitWorkflow.repositoryReview, agentSubject),
    [agentSubject, gitWorkflow.repositoryReview]
  )
  const agent = useAgentSession({ context: agentContext, subject: agentSubject })
  // The Guide view writes with the dock's model and describes the active review.
  const { provider, model, effort, models, login, open: agentOpen, toggle: toggleAgent } = agent
  const { guideAutoGenerate, guideOpensFirst } = view.preferences
  const activeWorld = gitWorkflow.activeWorld ?? null
  useEffect(() => {
    const guideAgent = {
      subject: agentSubject,
      provider,
      model,
      effort,
      models,
      login,
      openAgent: () => { if (!agentOpen) toggleAgent() }
    }
    publishGuideAgent(guideAgent)
    considerAutoGuide(activeWorld, guideAgent, { guideAutoGenerate, guideOpensFirst })
  }, [activeWorld, agentOpen, agentSubject, effort, guideAutoGenerate, guideOpensFirst, login, model, models, provider, toggleAgent])
  const collisionPaths = useMemo(
    () => findCollisionPaths(view.snapshot?.statuses ?? [], gitWorkflow.repositoryReview),
    [gitWorkflow.repositoryReview, view.snapshot?.statuses]
  )
  const activeNewWorld = gitWorkflow.activeWorld?.source === 'new' ? gitWorkflow.activeWorld : null
  const pullRequestWorkspacePending = isPullRequestWorkspacePending(
    gitWorkflow.actionKey,
    gitWorkflow.activeWorld ?? null
  )
  const workspaceStage = sessionWorkspaceStage({
    hasNewWorld: activeNewWorld != null,
    snapshot: view.snapshot,
    restorePending: view.restorePending,
    pullRequestPending: pullRequestWorkspacePending
  })
  return <>
    <AppChrome
      view={view}
      activeNewWorld={activeNewWorld}
      agentOpen={agent.open}
      onAgentToggle={agent.toggle}
    />

    {reviewLoadingPresence.mounted ? <PullRequestLoadingIndicator closing={reviewLoadingPresence.closing} /> : null}
    {repositoryPanelPresence.mounted && view.snapshot?.kind === 'git' ? <Suspense fallback={null}>
      <RepositoryPanel open={gitWorkflow.panelOpen} initialTab={gitWorkflow.panelTab}
        root={view.snapshot.root} repositoryName={view.snapshot.name} branch={view.snapshot.branch}
        statuses={view.snapshot.statuses} onTabChange={gitWorkflow.setPanelTab}
        onConfirmStage={gitWorkflow.confirmSensitiveStage}
        onStage={gitWorkflow.stagePaths} onUnstage={gitWorkflow.unstagePaths}
        onDiscard={gitWorkflow.discardPaths} onCommit={gitWorkflow.commitChanges}
        onOpenChangedFile={gitWorkflow.openChangedFile}
        integration={gitWorkflow.integration} loading={gitWorkflow.loadingIntegration}
        inbox={gitWorkflow.inbox} loadingInbox={gitWorkflow.loadingInbox}
        actionKey={gitWorkflow.actionKey} onClose={() => gitWorkflow.setPanelOpen(false)}
        onRefresh={gitWorkflow.refreshPanelData} updatedAt={gitWorkflow.integrationFetchedAt}
        onSwitchBranch={(name) => void gitWorkflow.switchBranch(name)}
        onReviewLocalBranch={(base, head) => void gitWorkflow.reviewLocalBranch(base, head)}
        onReviewCommit={(oid) => void gitWorkflow.reviewCommit(oid)} onFetch={() => void gitWorkflow.fetchRemote()}
        onPull={() => void gitWorkflow.pullCurrentBranch()} onPush={() => void gitWorkflow.pushCurrentBranch()}
        onReview={(pullRequest) => void gitWorkflow.reviewPullRequest(pullRequest)}
        onMerge={(pullRequest, strategy) => void gitWorkflow.mergePullRequest(pullRequest, strategy)}
        onMarkReady={(pullRequest) => void gitWorkflow.markPullRequestReady(pullRequest)}
        onOpenPullRequest={(selector) => void gitWorkflow.openPullRequestReview(selector)}
        onCheckout={(pullRequest) => void gitWorkflow.checkoutPullRequest(pullRequest)} />
    </Suspense> : null}

    {view.settingsOpen ? <Suspense fallback={null}>
      <SettingsPage preferences={view.preferences} onChange={view.setPreferences}
        onClose={() => view.setSettingsOpen(false)} />
    </Suspense> : null}
    {!view.settingsOpen && errorPresence.mounted && errorPresence.retained != null
      ? <ErrorBanner key={errorPresence.retained} message={errorPresence.retained} closing={errorPresence.closing}
          onDismiss={() => view.setError(null)} />
      : null}

    <WorkspaceStage
      workspaceStage={workspaceStage}
      view={view}
      agent={agent}
      collisionPaths={collisionPaths}
    />
  </>
})

const AppLayout = memo(function AppLayout(view: AppLayoutProps): React.JSX.Element {
  // Keyed on the repository only. Opening a pull request review keys the
  // workspace below, not this: remounting here would tear down the agent
  // transcript (useAgentAnswer cancels the in-flight request on unmount) and,
  // with ViewerProviders inside, the worker pool and every cached edit session.
  const agentSessionKey = view.snapshot?.root ?? view.restoreRoot ?? 'welcome'
  const { commandPaletteRef, terminalDockRef, ...workspace } = view
  const branches = workspace.gitWorkflow.integration?.branches
  const paletteBranches = useMemo(() => {
    if (branches == null) return undefined
    const names: string[] = []
    for (const branch of branches) if (!branch.current) names.push(branch.name)
    return names
  }, [branches])
  const selectWorkspacePath = workspace.selectPath
  const selectedWorkspacePath = workspace.selectedPath
  useEffect(() => {
    setDefinitionOpeners({
      openFile(path, line) {
        requestReveal({ path, line })
        if (!openInWorkspace(path)) selectWorkspacePath(path)
      },
      openInEditor: (path, line) => void openFileInEditor(path, line).catch(() => {}),
      currentPath: () => selectedWorkspacePath
    })
  }, [selectWorkspacePath, selectedWorkspacePath])
  const shellStyle = {
    '--terminal-panel-height': `${view.terminalHeight}px`,
    '--terminal-dock-offset': view.terminalOpen ? `${view.terminalHeight}px` : '0px',
    ...themePaletteVars(view.preferences.editorTheme),
    // Accent is applied last so an explicit choice wins over a themed palette.
    ...accentVars(view.preferences.accentColor, view.preferences.editorTheme)
  } as CSSProperties
  return <main
    className={`app-shell ${view.terminalOpen ? 'terminal-open' : ''} ${view.terminalResizing ? 'terminal-resizing' : ''}`}
    data-theme-type={getEditorThemeType(view.preferences.editorTheme)}
    style={shellStyle}
  >
    <CommandPaletteHost
      ref={commandPaletteRef}
      snapshot={workspace.snapshot}
      repositoryReview={workspace.gitWorkflow.repositoryReview}
      keybindings={workspace.preferences.keybindings}
      onError={workspace.setError}
      onOpenPullRequest={workspace.openPullRequestFromPalette}
      onOpenRepository={workspace.gitWorkflow.openPanel}
      onOpenSettings={workspace.openSettings}
      onToggleTerminal={workspace.toggleTerminal}
      onRunCommand={workspace.runCommand}
      recentFiles={workspace.recentFiles}
      onOpenFile={(path) => {
        if (!openInWorkspace(path)) workspace.selectPath(path)
      }}
      currentPath={workspace.selectedPath}
      onRevealDirectory={revealInExplorer}
      branches={paletteBranches}
      onSwitchBranch={(branch) => void workspace.gitWorkflow.switchBranch(branch)}
    />
    <AgentSessionLayout key={agentSessionKey} {...workspace} />
    {view.snapshot != null && view.terminalMounted ? <Suspense fallback={null}>
      <TerminalDock
        key={view.snapshot.root}
        ref={terminalDockRef}
        open={view.terminalOpen}
        projectName={view.snapshot.name}
        projectRoot={view.snapshot.root}
        height={view.terminalHeight}
        fontFamily={CODE_FONTS[view.preferences.codeFont].fontFamily}
        fontSize={view.preferences.codeFontSize}
        lineHeight={Math.min(1.8, Math.max(1, view.preferences.codeLineHeight / view.preferences.codeFontSize))}
        scrollback={view.preferences.terminalScrollback}
        theme={view.preferences.editorTheme}
        shortcutLabel={formatTerminalToggleShortcut()}
        onClose={view.closeTerminal}
        onHeightChange={view.setTerminalHeight}
        onHeightCommit={view.commitTerminalHeight}
        onResizingChange={view.setTerminalResizing}
      />
    </Suspense> : null}
    {view.confirmRequest == null ? null : (
      <ConfirmDialog {...view.confirmRequest} onResolve={view.resolveConfirm} />
    )}
  </main>
})

export interface AppProps {
  initialPreferences?: AppPreferences
  sessionSnapshot?: Promise<RepositorySnapshot | null>
}

export function App({
  initialPreferences = loadPreferences(),
  sessionSnapshot
}: AppProps = {}): React.JSX.Element {
  useLayoutEffect(() => markRendererStartup('reactCommitted'), [])
  useWindowVisibilitySync()
  useFullscreenSync()
  // Reading and re-deriving the cached paint is boot work, not render work: both
  // ran on every App render before, at up to 35ms each on a 3,000-path tree.
  const [cachedPaint] = useState(() => initialWorkspacePaint(window.repository?.cachedWorkspace ?? null))
  const [snapshot, setSnapshot] = useState<RepositorySnapshot | null>(cachedPaint.snapshot)
  const [selectedPath, setSelectedPath] = useState<string | null>(
    () => cachedPaint.selectedPath
      ?? (cachedPaint.snapshot == null ? null : firstOpenPathForSnapshot(cachedPaint.snapshot))
  )
  const [error, setError] = useState<string | null>(null)
  const [sidebarVisible, setSidebarVisible] = useState(true)
  const [diffStyle, setDiffStyle] = useState<DiffStyle>('unified')
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(cachedPaint.workspaceView)
  const [preferences, setPreferences] = useState<AppPreferences>(initialPreferences)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>(loadRecentFolders)
  const [repositoryChange, setRepositoryChange] = useState<RepositoryChangeEvent | null>(null)
  const restoreHint = window.repository?.restoreHint ?? null
  const [sessionReady, setSessionReady] = useState(false)
  const [startupSessionSnapshot] = useState(() => sessionSnapshot
    ?? window.repository?.getSessionSnapshot()
    ?? Promise.resolve(null))
  const WorkspaceRoot = useLoadedModule(subscribeWorkspaceRoot, getLoadedWorkspaceRoot)
  const commandPalette = useCommandPaletteControls()
  // Most-recently-opened files lead the palette's empty-query list. Tracked here
  // because this is the only place that sees every selection, wherever it came from.
  const recentFiles = useRecentFiles(snapshot?.root ?? null, selectedPath)
  const confirmation = useConfirm()
  const closeOverlays = useCallback(() => {
    commandPalette.close()
    setSettingsOpen(false)
  }, [commandPalette])
  const terminal = useTerminalVisibility({
    enabled: snapshot != null,
    keybindings: preferences.keybindings,
    onBeforeOpen: closeOverlays
  })

  const appliedSnapshotRef = useRef<RepositorySnapshot | null>(cachedPaint.snapshot)

  const ensureWorkspaceRoot = useCallback(() => {
    void preloadWorkspaceRoot().catch((loadError: unknown) => setError(getErrorMessage(loadError)))
  }, [])

  const changeWorkspaceView = useCallback((nextView: WorkspaceView) => {
    void preloadWorkspaceViewer(nextView).catch((loadError: unknown) => setError(getErrorMessage(loadError)))
    setWorkspaceView(nextView)
  }, [])

  const applySnapshot = useCallback(
    (nextSnapshot: RepositorySnapshot) => {
      reportAppliedSnapshot(nextSnapshot)
      const previous = appliedSnapshotRef.current
      const snapshotToApply = retainSnapshotIdentity(previous, nextSnapshot)
      if (snapshotLooksUnchanged(previous, snapshotToApply)) return
      appliedSnapshotRef.current = snapshotToApply
      markRendererStartup('snapshotReady')
      setSnapshot(snapshotToApply)
      // A watcher tick must never move the reader: the selection only falls back
      // once the selected file has actually left the repository.
      setSelectedPath((currentPath) =>
        currentPath != null && includesPath(snapshotToApply.paths, currentPath)
          ? currentPath
          : firstOpenPathForSnapshot(snapshotToApply)
      )
    },
    []
  )

  // Armed while a freshly opened folder is still showing its skeleton snapshot.
  // The live snapshot re-derives the view and the first file from real statuses,
  // but only until the reader has picked something themselves.
  const skeletonOpenRootRef = useRef<string | null>(null)

  const selectPath = useCallback((path: string | null) => {
    skeletonOpenRootRef.current = null
    setSelectedPath(path)
  }, [])

  const activateSnapshot = useCallback((nextSnapshot: RepositorySnapshot | null) => {
    if (nextSnapshot != null) {
      // A tab only hands its snapshot over once its session answers. A new tab
      // in between marked the session gone, and nothing marked it back: every
      // file then sat over "Select a file in the explorer".
      setSessionReady(true)
      applySnapshot(nextSnapshot)
      return
    }
    appliedSnapshotRef.current = null
    setSessionReady(false)
    setSnapshot(null)
    setSelectedPath(null)
    setRepositoryChange(null)
  }, [applySnapshot])

  const gitWorkflow = useGitWorkflow({
    snapshot,
    selectedPath,
    workspaceView,
    applySnapshot,
    activateSnapshot,
    onError: setError,
    onSelectPath: setSelectedPath,
    onWorkspaceViewChange: changeWorkspaceView,
    confirm: confirmation.confirm
  })
  const openPullRequestReview = gitWorkflow.openPullRequestReview
  const openWorkingTree = gitWorkflow.openWorkingTree

  const comparisonLoader = useComparisonLoader({
    snapshot,
    selectedPath,
    workspaceView,
    repositoryReview: gitWorkflow.repositoryReview,
    initialComparison: comparisonFromCachedText(cachedPaint.fileText),
    sessionReady,
    onError: setError
  })

  const openPullRequestFromPalette = useCallback((selector: number | string) => {
    void openPullRequestReview(selector)
  }, [openPullRequestReview])

  useExternalPullRequest((url, root) => {
    void gitWorkflow.openPullRequestFromLocator(url, root)
  })

  const openSettings = useCallback(() => {
    commandPalette.close()
    setSettingsOpen(true)
  }, [commandPalette])

  const toggleSidebar = useCallback(() => {
    setSidebarVisible((visible) => !visible)
  }, [])

  // The workspace view and the first file come from the snapshot the open
  // returned. A skeleton has no statuses, so a dirty repository would land in
  // the file view and stay there; arm the re-derivation for the git snapshot
  // still on its way.
  const adoptOpenedSnapshot = useCallback((nextSnapshot: RepositorySnapshot) => {
    setSessionReady(true)
    setSelectedPath(null)
    openWorkingTree(nextSnapshot)
    changeWorkspaceView(automaticWorkspaceView(nextSnapshot, null))
    setRecentFolders((current) => rememberRecentFolder(current, nextSnapshot))
    skeletonOpenRootRef.current = isLiveSnapshot(nextSnapshot) ? null : nextSnapshot.root
  }, [changeWorkspaceView, openWorkingTree])

  const folderOpen = useFolderOpen({
    recentFolders,
    adoptSnapshot: adoptOpenedSnapshot,
    ensureWorkspaceRoot,
    onBeforePickerOpen: commandPalette.close,
    onError: setError
  })
  const closeFolderPicker = folderOpen.closeFolderPicker

  // `kodi <folder>` while the app is up. Main holds the folder until the window
  // takes it, which it does only once its startup snapshot has settled: taken
  // during boot, the restore that landed a moment later covered it.
  const startupSettledRef = useRef(false)
  const adoptExternalFolder = useEffectEvent((nextSnapshot: RepositorySnapshot) => {
    const active = gitWorkflow.activeWorld
    if (active?.source === 'desk' && active.root === nextSnapshot.root) {
      // Already in front: `kodi .` asks for its changes, so a file view goes back
      // to the review, by the snapshot on screen (main's may be a skeleton, with
      // no statuses). A reader already in the review keeps their place.
      if (workspaceView === 'file') gitWorkflow.resyncDeskNavigation(appliedSnapshotRef.current ?? nextSnapshot)
      return
    }
    ensureWorkspaceRoot()
    setError(null)
    adoptOpenedSnapshot(nextSnapshot)
  })
  // `kodi <commit>` and `kodi --guide-file` name more than a folder; that part
  // is taken once the folder is in front.
  const takeExternalTarget = useEffectEvent(async () => {
    const target = await window.repository?.takeExternalTarget()
    if (target == null) return
    if (target.guide) expectExternalGuide()
    if (target.oid != null) await gitWorkflow.reviewCommit(target.oid)
  })
  const takeExternalFolder = useEffectEvent(() => {
    if (!startupSettledRef.current) return
    void window.repository?.takeExternalFolder().then((nextSnapshot) => {
      if (nextSnapshot != null) adoptExternalFolder(nextSnapshot)
      return takeExternalTarget()
    })
  })
  useEffect(() => {
    const settled = (): void => {
      startupSettledRef.current = true
      takeExternalFolder()
    }
    void startupSessionSnapshot.then(settled, settled)
    return window.repository?.onOpenExternalFolder(takeExternalFolder)
  }, [startupSessionSnapshot])

  useRepositoryChangeSync({
    appliedRoot: snapshot?.root ?? null,
    selectedPath,
    appliedSnapshotRef,
    skeletonOpenRootRef,
    gitWorkflow,
    comparisonLoader,
    applySnapshot,
    onRepositoryChange: setRepositoryChange,
    onError: setError
  })

  const hasSnapshot = snapshot != null

  const restorePending = useSessionRestore({
    snapshotPromise: startupSessionSnapshot,
    restoreHint,
    paintedSnapshot: () => appliedSnapshotRef.current,
    onRestore: (restoredSnapshot) => {
      setSessionReady(true)
      ensureWorkspaceRoot()
      const holdingReview = gitWorkflow.worlds.some((world) => newWorldHoldsReview(world))
      // Read before the tab opens: opening it applies the snapshot, and read
      // after, every restore looked like the folder already painted, so a
      // skeleton's file view stuck once the live snapshot came in.
      const painted = appliedSnapshotRef.current?.root === restoredSnapshot.root
      openWorkingTree(restoredSnapshot)
      if (!holdingReview && !painted) {
        changeWorkspaceView(automaticWorkspaceView(restoredSnapshot, null))
        // A restore that lands as a skeleton derived its view from no statuses;
        // the live snapshot behind it re-derives it, as a fresh open does.
        if (!isLiveSnapshot(restoredSnapshot)) skeletonOpenRootRef.current = restoredSnapshot.root
      }
      setRecentFolders((current) => rememberRecentFolder(current, restoredSnapshot))
    },
    onError: setError
  })

  useAppPersistence({
    preferences,
    root: snapshot?.root ?? null,
    selectedPath,
    workspaceView,
    comparison: comparisonLoader.comparison
  })

  useEffect(() => {
    saveRecentFolders(recentFolders)
  }, [recentFolders])

  useEffect(() => setEditorCommand(preferences.editorCommand), [preferences.editorCommand])
  useEffect(() => installDefinitionTrigger(), [])
  const runCommand = useAppCommands({
    commandPalette,
    closeFolderPicker,
    toggleFolderPicker: folderOpen.toggleFolderPicker,
    gitWorkflow,
    keybindings: preferences.keybindings,
    hasSnapshot,
    settingsOpen,
    setSettingsOpen,
    setPreferences,
    toggleSidebar,
    toggleTerminal: terminal.toggle,
    selectedPath,
    editorCommand: preferences.editorCommand,
    onError: setError
  })

  const view: Omit<AppLayoutProps, 'commandPaletteRef' | 'terminalDockRef'> = {
    WorkspaceRoot, snapshot, selectedPath, repositoryChange,
    comparison: comparisonLoader.comparison, loadingDiff: comparisonLoader.loading,
    opening: folderOpen.opening, openingRecentPath: folderOpen.openingRecentPath,
    error, sidebarVisible, diffStyle, workspaceView,
    terminalOpen: terminal.open, terminalMounted: terminal.mounted,
    terminalHeight: terminal.height, terminalResizing: terminal.resizing,
    preferences, settingsOpen,
    recentFolders,
    restorePending, restoreRoot: restorePending ? restoreHint?.lastRoot ?? null : null,
    gitWorkflow,
    setSettingsOpen, setError, setRecentFolders, setPreferences, selectPath, onComparisonSaved: comparisonLoader.save,
    setDiffStyle, setWorkspaceView: changeWorkspaceView,
    setTerminalHeight: terminal.setHeight, setTerminalResizing: terminal.setResizing,
    toggleSidebar, toggleTerminal: terminal.toggle, closeTerminal: terminal.close,
    commitTerminalHeight: terminal.commitHeight,
    openFolder: folderOpen.openFolder, openFolderFromPicker: folderOpen.openFolderFromPicker,
    openRecentFolder: folderOpen.openRecentFolder, folderPickerOpen: folderOpen.folderPickerOpen,
    openFolderPicker: folderOpen.openFolderPicker, closeFolderPicker, toggleFolderPicker: folderOpen.toggleFolderPicker,
    openPullRequestFromPalette, openCommandPalette: commandPalette.open,
    openSettings, runCommand, recentFiles,
    confirmRequest: confirmation.request, confirm: confirmation.confirm, resolveConfirm: confirmation.resolve
  }
  // The two refs stay out of `view`: the React Compiler treats a ref read into an
  // object literal as a ref access during render and bails out of the component.
  return <AppLayout {...view}
    commandPaletteRef={commandPalette.ref}
    terminalDockRef={terminal.dockRef} />
}
