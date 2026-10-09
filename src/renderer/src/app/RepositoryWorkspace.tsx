import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type Ref, type SetStateAction } from 'react'
import type { FileContents } from '@pierre/diffs'
import type { Editor } from '@pierre/diffs/edit'
import type { FileTree as FileTreeModel } from '@pierre/trees'
import { useFileTree } from '@pierre/trees/react'

import type { FileComparison, PullRequestReviewComment, PullRequestReviewEvent, RepositoryChangeEvent, RepositoryFileStatus, RepositoryReview, RepositorySnapshot } from '../../../shared/contracts'
import { isMarkdownPath } from '../../../shared/markdownPreview'
import type { DiffStyle, FileEditControls, WorkspaceView } from './AppView'
import { DiffToolbar } from '../diff/DiffToolbar'
import { Explorer } from '../explorer/Explorer'
import { type AppPreferences } from '../settings/preferences'
import { SidebarResizer } from '../explorer/SidebarResizer'
import { ReviewStatusBar, ReviewToolbarActions, ReviewToolbarBadge } from '../review/ReviewStatusBar'
import { ReviewFinishBar } from '../review/ReviewFinishBar'
import { ConversationErrorBar } from '../agent/ConversationErrorBar'
import { EditConflictBar } from './WorkspaceNoticeBars'
import { useViewerChunkPreload } from './useViewerChunkPreload'
import { reviewToolbarComparison, reviewToolbarTitle } from '../review/reviewHeaderModel'
import type { ReviewAnnotationMetadata, ReviewThread } from '../review/ReviewComments'
import { createPullRequestReviewComments } from '../github/pullRequestReviewComments'
import type { AgentSelection } from '../agent/agentAttachments'
import { usePullRequestConversation } from '../github/usePullRequestConversation'
import { useNewRevisionWatch } from '../github/useNewRevisionWatch'
import type { NewRevisionNotice } from '../github/PullRequestReviewSummaryBar'
import { useReviewSession } from '../review/useReviewSession'
import { useReviewLoadState, type ReviewLoadState } from '../review/useReviewLoadState'
import { useHibernationVeto } from './useHibernation'
import { useViewerSuspension } from './useViewerSuspension'
import { formatKeybinding, type ReviewCommand } from '../settings/keybindings'
import { useReviewShortcuts } from '../review/useReviewShortcuts'
import {
  applyTreePathDelta,
  diffTreePaths,
  expandDirectories,
  expandedDirectoryPaths,
  getDirectoryPaths,
  getTreeFollowBehavior,
  orderPathsForTree,
  treeContentSyncMode,
  type AppliedTreeContent
} from '../explorer/treeExpansion'
import { FindBar } from '../review/FindBar'
import { WorkspaceCodeSkeleton } from './WorkspaceSkeleton'
import { setExplorerRevealHandler, setWorkspaceFileOpener } from '../explorer/explorerReveal'
import { markWorkspaceRender } from '../perf/workspaceRenderMetric'
import { countKodiMetric } from '../perf/kodiCounters'
import { useCodeZoomGesture } from '../diff/useCodeZoomGesture'
import { useFileEditing, type WorkingDrafts } from '../diff/useFileEditing'
import { EditorStatusBar } from '../editor/EditorStatusBar'
import { useViewerContext } from '../editor/ViewerProviders'
import { retainReviewItems } from '../review/reviewItems'
import { applyReviewFileFilter, EMPTY_REVIEW_FILE_FILTER } from '../review/reviewFileFilter'
import { useGeneratedPathTest } from '../review/reviewFileMarks'
import { useReviewDraft } from '../review/useReviewDraft'
import { reviewPathsForSnapshot, workspaceViewForTreePath } from '../explorer/workspaceMode'
import { samePathList } from '../explorer/snapshotPaths'
import { copyWorkingFileContents } from '../diff/copyFilePath'
import {
  getLoadedDiffSurface,
  getLoadedMultiFileReview,
  subscribeDiffSurface,
  subscribeMultiFileReview,
  useLoadedModule
} from './workspaceBoot'
import { reportFirstScreenAfter } from './firstScreen'
import { markRendererStartup } from './startupMetrics'

// How long a launch waits for the viewer's first highlighted render before
// showing the window anyway.
const WORKSPACE_FIRST_SCREEN_MS = 400

type TreeFileStatus = Exclude<RepositoryFileStatus, 'conflicted'>

function selectOnlyTreePath(model: FileTreeModel, path: string): void {
  const selectedPaths = model.getSelectedPaths()
  if (selectedPaths.length === 1 && selectedPaths[0] === path) return
  for (const selectedPath of selectedPaths) {
    if (selectedPath !== path) model.getItem(selectedPath)?.deselect()
  }
  if (!selectedPaths.includes(path)) model.getItem(path)?.select()
}

/** Whether the row for `path` is rendered and wholly inside the tree's viewport. */
function treeRowInView(model: FileTreeModel, path: string): boolean {
  const container = model.getFileTreeContainer()
  const row = container?.shadowRoot?.querySelector(`[data-item-path="${CSS.escape(path)}"]`)
  if (container == null || row == null) return false
  const bounds = container.getBoundingClientRect()
  const rect = row.getBoundingClientRect()
  return rect.height > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom
}

// The file tree has no conflicted state, so conflicts ride along as modified there.
function toTreeStatus(status: RepositoryFileStatus): TreeFileStatus {
  return status === 'conflicted' ? 'modified' : status
}

const TREE_STYLES = `
  ${/* Named rather than a bare \`*\`: the document rule cannot cross the shadow
     boundary, and these are the only corners the tree rounds. The row's own
     ::before is the focus ring, so it has to match the row it traces. */ ''}
  button,
  [data-type="item"],
  [data-type="item"]::before,
  [data-type="context-menu-trigger"],
  [data-type="context-menu-anchor"] > slot,
  ::-webkit-scrollbar-thumb {
    corner-shape: squircle;
  }

  ${/* The status letter carries the colour; the filename stays readable text. */ ''}
  [data-item-git-status] > [data-item-section="content"] {
    color: inherit;
  }

  [data-item-section="git"] {
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    letter-spacing: var(--track-caps-11);
  }

  ${/* In a review every folder contains a change, so the dot says nothing. */ ''}
  :host([data-review-mode="true"]) [data-item-type="folder"] > [data-item-section="git"] {
    visibility: hidden;
  }

  button {
    touch-action: manipulation;
    transition: scale 110ms var(--ease-out), background-color 100ms var(--ease-out);
  }

  button:active:not(:disabled) {
    scale: 0.96;
    transition-duration: 0s, 100ms;
  }

  ${/* No row scales on press. The ratio above is a 1px squeeze on a 22px icon
     button and a ~10px collapse on a 250px row, which reads as the row being
     crushed — a tree row is a button by markup, not by size.
     The selected-row exemption used to carry this rule, which left the scale in
     place for selected rows: clicking a folder selects it, so every click after
     the first jumped. The exemption belongs on the tint, which is only there to
     stand in for a fill the row does not have yet.

     :not(:disabled) is not decoration — it is what carries this past the
     button:active rule above, whose own :not() counts toward its specificity. */ ''}
  [data-type="item"]:active:not(:disabled) {
    scale: 1;
  }

  [data-type="item"]:active:not([data-item-selected="true"]) {
    background: var(--accent-soft);
  }

  [data-type="item"] {
    border-radius: var(--corner-compact);
    ${/* Rows have nothing to say with scale, so it cannot be transitioned back in. */ ''}
    transition: background-color 100ms var(--ease-out);
  }

  ${/* A stationary pointer must not paint every virtualized row that passes under
     it during wheel or trackpad scrolling. The selected row stays visible. */ ''}
  [data-file-tree-virtualized-root="true"][data-is-scrolling] [data-type="item"] {
    pointer-events: none;
    transition: none;
  }

  [data-file-tree-virtualized-root="true"][data-is-scrolling]
  [data-type="item"]:hover:not([data-item-selected="true"]),
  [data-file-tree-virtualized-root="true"][data-is-scrolling]
  [data-type="item"][data-item-context-hover="true"]:not([data-item-selected="true"]) {
    background-color: var(--trees-bg);
    --truncate-marker-background-overlay-color: transparent;
  }

  ${/* The tree marks pointer-focused rows with data-item-focused, which makes its
     focus outline jump between rows on every click. Keep the outline for
     keyboard navigation, where it communicates focus, and let pointer clicks
     use the stable selection fill. Pseudo-elements skip the selector list
     above, so the ring declares its curve next to the suppression. */ ''}
  [data-type="item"]::before {
    corner-shape: squircle;
  }

  [data-type="item"][data-item-focused="true"]:not(:focus-visible)::before {
    content: none;
  }

  ${/* The menu itself is portaled onto .app-shell so the sidebar cannot clip it
     and light-theme tokens still apply. Only the row trigger lives here. */ ''}
  [data-type="context-menu-trigger"] {
    width: 22px;
    height: 22px;
    min-width: 22px;
    border: 0;
    border-radius: var(--corner-compact);
    padding: 0;
    background: transparent;
    color: var(--muted);
  }

  [data-type="context-menu-trigger"]:hover,
  [data-type="context-menu-trigger"][aria-expanded="true"] {
    background: var(--control-fill-hover);
    color: var(--text);
  }

  @media (prefers-reduced-motion: reduce) {
    button {
      transition-property: background-color, color, border-color !important;
      transition-duration: 160ms !important;
      transition-timing-function: ease !important;
    }

    button:active:not(:disabled) {
      scale: 1 !important;
      transform: none !important;
    }
  }
`

const TREE_INSTANT_FOLLOW_RESET_MS = 800

export interface RepositoryWorkspaceProps {
  snapshot: RepositorySnapshot
  selectedPath: string | null
  comparison: FileComparison | null
  loadingDiff: boolean
  diffStyle: DiffStyle
  workspaceView: WorkspaceView
  preferences: AppPreferences
  onAttachToAgent(selection: AgentSelection, prompt?: string): void
  onPreferencesChange(preferences: AppPreferences): void
  repositoryReview: RepositoryReview | null
  reviewWorldSource: 'desk' | 'patch'
  repositoryChange: RepositoryChangeEvent | null
  collisionPaths: ReadonlySet<string>
  initialReviewScrollTop: number
  onReviewScrollPositionChange(scrollTop: number): void
  onSelectPath(path: string): void
  onDiffStyleChange(style: DiffStyle): void
  onWorkspaceViewChange(view: WorkspaceView): void
  /** Reopens the pull request at whatever its head commit is now. */
  /** Resolves false when the reload failed, so a watch can raise its notice again. */
  onReloadReview(pullRequestUrl: string): Promise<boolean>
  submittingPullRequestReview: PullRequestReviewEvent | null
  pullRequestReviewMessage: string | null
  onSubmitPullRequestReview(event: PullRequestReviewEvent, body: string, comments: PullRequestReviewComment[]): Promise<boolean>
  onComparisonSaved(comparison: FileComparison): void
  onError(message: string | null): void
  patchLoadError?: string | null
  reviewWorldId: string
  sidebarVisible: boolean
  onSidebarToggle(): void
  onBranchesOpen(): void
}

interface RepositoryReviewHeaderProps {
  comparison: FileComparison | null
  selectedPath: string | null
  isGitRepository: boolean
  isFilePreview: boolean
  diffStyle: DiffStyle
  workspaceView: WorkspaceView
  reviewFileCount: number
  repositoryReview: RepositoryReview | null
  reviewWorldSource: 'desk' | 'patch'
  wordWrap: boolean
  foldUnchanged: boolean
  fileEdit: FileEditControls
  submittingPullRequestReview: PullRequestReviewEvent | null
  pullRequestReviewMessage: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  newRevision: NewRevisionNotice | null
  reviewComposerExpanded: boolean
  reviewComposerBody: string
  onReviewComposerExpandedChange(expanded: boolean): void
  onReviewComposerBodyChange(body: string): void
  onDiffStyleChange(style: DiffStyle): void
  onWordWrapToggle(): void
  onFoldUnchangedToggle(): void
  onOpenReviewSummary(): void
  onSubmitPullRequestReview(event: PullRequestReviewEvent, body: string): Promise<boolean>
  sidebarVisible: boolean
  onSidebarToggle(): void
  sidebarShortcut: string
  reviewWorldId?: string
}

function RepositoryReviewHeader({
  comparison,
  selectedPath,
  isGitRepository,
  isFilePreview,
  diffStyle,
  workspaceView,
  reviewFileCount,
  repositoryReview,
  reviewWorldSource,
  wordWrap,
  foldUnchanged,
  fileEdit,
  submittingPullRequestReview,
  pullRequestReviewMessage,
  inlineCommentCount,
  orphanedCommentCount,
  newRevision,
  reviewComposerExpanded,
  reviewComposerBody,
  onReviewComposerExpandedChange,
  onReviewComposerBodyChange,
  onDiffStyleChange,
  onWordWrapToggle,
  onFoldUnchangedToggle,
  onOpenReviewSummary,
  onSubmitPullRequestReview,
  sidebarVisible,
  onSidebarToggle,
  sidebarShortcut,
  reviewWorldId
}: RepositoryReviewHeaderProps): React.JSX.Element {
  return (
    <>
      <DiffToolbar
        comparison={comparison}
        selectedPath={selectedPath}
        isGitRepository={isGitRepository}
        isFilePreview={isFilePreview}
        diffStyle={diffStyle}
        workspaceView={workspaceView}
        reviewFileCount={reviewFileCount}
        reviewTitle={reviewToolbarTitle(repositoryReview)}
        reviewComparison={reviewToolbarComparison(repositoryReview)}
        wordWrap={wordWrap}
        foldUnchanged={foldUnchanged}
        fileEdit={fileEdit}
        onDiffStyleChange={onDiffStyleChange}
        onWordWrapToggle={onWordWrapToggle}
        onFoldUnchangedToggle={onFoldUnchangedToggle}
        sidebarVisible={sidebarVisible}
        onSidebarToggle={onSidebarToggle}
        sidebarShortcut={sidebarShortcut}
        reviewWorldId={reviewWorldId}
        reviewLink={repositoryReview?.kind === 'github' && workspaceView === 'multi'
          ? { href: repositoryReview.pullRequest.url, label: `Open #${repositoryReview.pullRequest.number} on GitHub` }
          : undefined}
        reviewBadge={<ReviewToolbarBadge review={repositoryReview} reviewWorldSource={reviewWorldSource} />}
        reviewActions={repositoryReview == null ? null : (
          <ReviewToolbarActions
            review={repositoryReview}
            reviewWorldSource={reviewWorldSource}
            message={pullRequestReviewMessage}
            inlineCommentCount={inlineCommentCount}
            orphanedCommentCount={orphanedCommentCount}
            newRevision={newRevision}
            expanded={reviewComposerExpanded}
            onExpandedChange={onReviewComposerExpandedChange}
            onOpen={onOpenReviewSummary}
          />
        )}
      />
      <ReviewStatusBar
        review={repositoryReview}
        reviewWorldSource={reviewWorldSource}
        submitting={submittingPullRequestReview}
        message={pullRequestReviewMessage}
        inlineCommentCount={inlineCommentCount}
        orphanedCommentCount={orphanedCommentCount}
        expanded={reviewComposerExpanded}
        body={reviewComposerBody}
        onExpandedChange={onReviewComposerExpandedChange}
        onBodyChange={onReviewComposerBodyChange}
        onSubmit={onSubmitPullRequestReview}
      />
    </>
  )
}

function useReviewPaths(
  snapshot: RepositorySnapshot,
  repositoryReview: RepositoryReview | null
): readonly string[] {
  const { kind, statuses } = snapshot
  // Retained before ordering: a status tick on a very dirty repository (tens of
  // thousands of untracked files) changes a status, not the set, and sorting
  // every path with the natural comparator again was the bulk of that tick.
  const unorderedReviewPaths = useRetainedPathList(useMemo(
    () => reviewPathsForSnapshot({ kind, statuses }, repositoryReview),
    [kind, repositoryReview, statuses]
  ))
  const ordered = useMemo(() => orderPathsForTree(unorderedReviewPaths), [unorderedReviewPaths])
  return useRetainedPathList(ordered)
}

/**
 * The same paths keep the same array. A `git add` changes a status but not
 * which files are in the review, and a new array identity there re-ran the
 * review's loader: fifty comparisons refetched, re-parsed and re-highlighted.
 */
function useRetainedPathList(paths: readonly string[]): readonly string[] {
  const [retained, setRetained] = useState(paths)
  if (retained === paths) return paths
  if (samePathList(retained, paths)) return retained
  setRetained(paths)
  return paths
}

function useReviewTreeData(
  snapshot: RepositorySnapshot,
  repositoryReview: RepositoryReview | null,
  treePaths: readonly string[],
  threadsByPath: Record<string, ReviewThread[]>,
  reviewWorldSource: RepositoryWorkspaceProps['reviewWorldSource']
) {
  // Both source arrays are already memoized, so identity is the whole test the
  // tree needs. Joining them into multi-megabyte keys on every render was the
  // most expensive thing this component did on a large repository.
  const treeStatuses = useMemo<Array<{ path: string; status: TreeFileStatus }>>(
    () => reviewWorldSource === 'desk' && repositoryReview == null
      ? snapshot.statuses.map((status) => ({ path: status.path, status: toTreeStatus(status.status) }))
      : (repositoryReview?.files ?? []).map((file) => ({ path: file.path, status: 'modified' as const })),
    [repositoryReview, reviewWorldSource, snapshot.statuses]
  )
  const reviewComments = useMemo(
    () => createPullRequestReviewComments(threadsByPath),
    [threadsByPath]
  )
  const orphanedCommentCount = useMemo(
    () => Object.values(threadsByPath).reduce(
      (count, threads) => threads.reduce(
        (pathCount, thread) => pathCount + (thread.orphaned ? 1 : 0),
        count
      ),
      0
    ),
    [threadsByPath]
  )

  return { treePaths, treeStatuses, reviewComments, orphanedCommentCount }
}

function useViewerPreferences(
  preferences: AppPreferences,
  codeZoom: { codeFontSize: number; codeLineHeight: number }
): AppPreferences {
  return useMemo(
    () => ({
      ...preferences,
      codeFontSize: codeZoom.codeFontSize,
      codeLineHeight: codeZoom.codeLineHeight
    }),
    [codeZoom.codeFontSize, codeZoom.codeLineHeight, preferences]
  )
}

// Ancestors of every path, shallowest first. Unlike getDirectoryPaths this does
// not sort — the tree only needs deepest-first for the collapse pass, which the
// single sorted list already provides.
function collectDirectoryPaths(paths: readonly string[]): Set<string> {
  const directories = new Set<string>()
  for (const path of paths) {
    let index = path.indexOf('/')
    while (index > 0) {
      directories.add(path.slice(0, index))
      index = path.indexOf('/', index + 1)
    }
  }
  return directories
}

function repositoryReviewIdentity(repositoryReview: RepositoryReview | null): string {
  if (repositoryReview == null) return 'working-tree'
  return repositoryReview.kind === 'github'
    ? `github:${repositoryReview.pullRequest.url}`
    : repositoryReview.id
}

function positionPortaledTreeMenu(
  menu: HTMLElement,
  anchor: { top: number; right: number; bottom: number; left: number }
): void {
  const gap = 4
  const width = menu.offsetWidth || 196
  const height = menu.offsetHeight || 104
  const maxLeft = window.innerWidth - width - 8
  const maxTop = window.innerHeight - height - 8
  let left = anchor.right - width
  if (left < 8) left = Math.min(anchor.left, maxLeft)
  left = Math.max(8, Math.min(left, maxLeft))
  let top = anchor.bottom + gap
  if (top > maxTop) top = Math.max(8, anchor.top - height - gap)
  menu.style.left = `${Math.round(left)}px`
  menu.style.top = `${Math.round(top)}px`
}

function createTreeContextMenu(
  root: string,
  item: { path: string },
  context: { close: () => void; anchorRect: { top: number; right: number; bottom: number; left: number } },
  isFile: boolean
): HTMLElement {
  const menu = document.createElement('div')
  menu.dataset.kodiTreeMenu = ''
  menu.dataset.fileTreeContextMenuRoot = 'true'
  menu.setAttribute('role', 'menu')
  const addAction = (label: string, run: () => void): void => {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.textContent = label
    button.addEventListener('click', () => {
      context.close()
      run()
    })
    menu.append(button)
  }
  addAction('Copy relative path', () => void navigator.clipboard.writeText(item.path))
  const absolutePath = `${root.replace(/[/\\]$/, '')}/${item.path}`
  addAction('Copy absolute path', () => void navigator.clipboard.writeText(absolutePath))
  if (isFile) addAction('Copy contents', () => void copyWorkingFileContents(item.path))
  addAction('Reveal in Finder', () => void window.repository?.revealPath(item.path))

  document.querySelector('[data-kodi-tree-menu]')?.remove()
  const host = document.querySelector('.app-shell') ?? document.body
  host.append(menu)
  positionPortaledTreeMenu(menu, context.anchorRect)

  const placeholder = document.createElement('span')
  placeholder.hidden = true
  return placeholder
}

// Applying the same paths again would collapse every directory, so the model is
// only reset when the content behind it actually changed.
function useTreeContentSync(
  model: FileTreeModel,
  root: string,
  isGitRepository: boolean,
  treePaths: readonly string[],
  treeStatuses: readonly { path: string; status: TreeFileStatus }[],
  directoryPaths: readonly string[],
  changedDirectoryPaths: readonly string[]
): void {
  const appliedTreeContentRef = useRef<AppliedTreeContent | null>(null)

  useLayoutEffect(() => {
    const applied = appliedTreeContentRef.current
    const mode = treeContentSyncMode(applied, root, treePaths, treeStatuses)
    if (mode === 'skip') return
    // A changed folder opens once, when it becomes changed. Opening every
    // changed folder on every tick undid the reader's collapse on each save, and
    // past a handful of them rebuilt the whole tree to do it.
    const openedBefore = mode === 'adopt' ? null : applied?.changedDirectories
    const newlyChanged = !isGitRepository
      ? []
      : openedBefore == null
        ? changedDirectoryPaths
        : changedDirectoryPaths.filter((directoryPath) => !openedBefore.has(directoryPath))
    appliedTreeContentRef.current = {
      root,
      paths: treePaths,
      statuses: treeStatuses,
      directories: directoryPaths,
      changedDirectories: new Set(changedDirectoryPaths)
    }
    if (mode === 'status') {
      model.setGitStatus(treeStatuses)
      // A burst of new files (a build folder, a vendored package) can dirty
      // thousands of folders in one watcher tick; opening them one call at a
      // time froze the window, so past a handful this is one rebuild.
      expandDirectories(model, treePaths, directoryPaths, newlyChanged)
      return
    }
    if (mode === 'reset' && applied != null) {
      // A save, a new file, a deleted one: the lists differ in a short window,
      // and one batch keeps every folder the reader opened. A reset re-sorted
      // every path and closed them all.
      const delta = diffTreePaths(applied.paths, treePaths)
      if (delta != null) {
        try {
          applyTreePathDelta(model, delta, directoryPaths)
          countKodiMetric('treeBatches')
          model.setGitStatus(treeStatuses)
          expandDirectories(model, treePaths, directoryPaths, newlyChanged)
          return
        } catch {
          // The store refused an operation (a file became a folder); rebuild.
        }
      }
      model.resetPaths(treePaths, {
        initialExpandedPaths: [
          ...expandedDirectoryPaths(model, applied.directories ?? []),
          ...newlyChanged
        ]
      })
      countKodiMetric('treeResets')
      model.setGitStatus(treeStatuses)
      return
    }
    // A reset rebuilds the store, so its expansion is whatever it is built with:
    // the changed folders on a repository, the top level of a plain folder. The
    // old collapse-everything-then-expand passes notified once per folder.
    model.resetPaths(treePaths, {
      initialExpandedPaths: isGitRepository
        ? changedDirectoryPaths
        : directoryPaths.filter((directoryPath) => !directoryPath.includes('/'))
    })
    countKodiMetric('treeResets')
    model.setGitStatus(treeStatuses)
  }, [changedDirectoryPaths, directoryPaths, isGitRepository, model, root, treePaths, treeStatuses])

}

/**
 * A direct navigation (tree click, ⌘P, review shortcut) should land instantly,
 * while the review's own scroll-follow animates. The pending target says which
 * of the two the next visible-path report came from.
 */
function useInstantTreeFollow(): {
  markInstantTreeFollowTarget(path: string): void
  consumeInstantTreeFollowTarget(path: string): string | null
} {
  const targetRef = useRef<string | null>(null)
  const resetRef = useRef<number | null>(null)

  const clearReset = useCallback(() => {
    if (resetRef.current == null) return
    window.clearTimeout(resetRef.current)
    resetRef.current = null
  }, [])

  const markInstantTreeFollowTarget = useCallback((path: string) => {
    targetRef.current = path
    clearReset()
    resetRef.current = window.setTimeout(() => {
      targetRef.current = null
      resetRef.current = null
    }, TREE_INSTANT_FOLLOW_RESET_MS)
  }, [clearReset])

  const consumeInstantTreeFollowTarget = useCallback((path: string) => {
    const target = targetRef.current
    if (target !== path) return target
    targetRef.current = null
    clearReset()
    return target
  }, [clearReset])

  useEffect(() => clearReset, [clearReset])

  return { markInstantTreeFollowTarget, consumeInstantTreeFollowTarget }
}

interface RepositoryDiffPanelProps {
  surfaceRef: Ref<HTMLElement>
  isFilePreview: boolean
  header: RepositoryReviewHeaderProps
  conflict: { path: string } | null
  onKeepDraft(): void
  onReloadFromDisk(): void
  conversationUnavailable: string | null
  onRetryConversation(): void
  patchLoadError?: string | null
  viewerSuspended: boolean
  workspaceView: WorkspaceView
  reviewWorldId: string
  reviewRoot: string
  reviewSessionRevision: number
  reviewPaths: readonly string[]
  diffStyle: DiffStyle
  viewerPreferences: AppPreferences
  repositoryReview: RepositoryReview | null
  reviewLoadState: ReviewLoadState
  reviewLoading: boolean
  reviewTargetPathCount: number
  onLoadMoreReviewFiles(): void
  pullRequestConversation: ReturnType<typeof usePullRequestConversation>['conversation']
  reviewScrollRevision: number
  selectedPath: string | null
  multiFileNavigationRevision: number
  handledNavigationRevisionRef: { current: number }
  getInitialScrollTop(): number
  onScrollPositionChange(scrollTop: number): void
  onVisiblePathChange(path: string): void
  threadsByPath: Record<string, ReviewThread[]>
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>
  viewedFiles: ReturnType<typeof useReviewSession>['viewedFiles']
  setViewedFiles: ReturnType<typeof useReviewSession>['setViewedFiles']
  remoteThreadsByPath: ReturnType<typeof usePullRequestConversation>['threadsByPath']
  pendingRemoteThreadId: string | null
  onReplyToRemoteThread(threadId: string, body: string): void
  onResolveRemoteThread(threadId: string, resolved: boolean): void
  onAttachToAgent(selection: AgentSelection, prompt?: string): void
  reviewCommand: { command: ReviewCommand; path: string; revision: number } | null
  surfaceComparison: FileComparison | null
  surfaceLoading: boolean
  editMode: 'edit' | 'read'
  documentView: FileEditControls['documentView']
  onStartEdit?: FileEditControls['onStart']
  onDraftFileChange(file: FileContents): void
  onEditorAttach(editor: Editor<ReviewAnnotationMetadata>): void
  onEditorBlur(): void
  showStatusBar: boolean
  fileExtension: string | undefined
  dirty: boolean
  getEditor(): Editor<ReviewAnnotationMetadata> | null
  onError(message: string | null): void
  workingDrafts: WorkingDrafts
  autosaveOnBlur: boolean
}

function useRepositoryReviewHeader({
  comparison,
  selectedPath,
  isGitRepository,
  isFilePreview,
  diffStyle,
  workspaceView,
  reviewFileCount,
  repositoryReview,
  reviewWorldSource,
  preferences,
  fileEdit,
  submittingPullRequestReview,
  pullRequestReviewMessage,
  inlineCommentCount,
  orphanedCommentCount,
  newRevision,
  reviewComposerExpanded,
  reviewComposerBody,
  onReviewComposerExpandedChange,
  onReviewComposerBodyChange,
  onDiffStyleChange,
  onPreferencesChange,
  onOpenReviewSummary,
  onSubmitPullRequestReview,
  sidebarVisible,
  onSidebarToggle,
  sidebarShortcut
}: {
  comparison: FileComparison | null
  selectedPath: string | null
  isGitRepository: boolean
  isFilePreview: boolean
  diffStyle: DiffStyle
  workspaceView: WorkspaceView
  reviewFileCount: number
  repositoryReview: RepositoryReview | null
  reviewWorldSource: 'desk' | 'patch'
  preferences: AppPreferences
  fileEdit: FileEditControls
  submittingPullRequestReview: PullRequestReviewEvent | null
  pullRequestReviewMessage: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  newRevision: NewRevisionNotice | null
  reviewComposerExpanded: boolean
  reviewComposerBody: string
  onReviewComposerExpandedChange(expanded: boolean): void
  onReviewComposerBodyChange(body: string): void
  onDiffStyleChange(style: DiffStyle): void
  onPreferencesChange(preferences: AppPreferences): void
  onOpenReviewSummary(): void
  onSubmitPullRequestReview(event: PullRequestReviewEvent, body: string): Promise<boolean>
  sidebarVisible: boolean
  onSidebarToggle(): void
  sidebarShortcut: string
}): RepositoryReviewHeaderProps {
  const toggleWordWrap = useCallback(() => {
    onPreferencesChange({ ...preferences, wordWrap: !preferences.wordWrap })
  }, [onPreferencesChange, preferences])
  const toggleFoldUnchanged = useCallback(() => {
    onPreferencesChange({ ...preferences, foldUnchanged: !preferences.foldUnchanged })
  }, [onPreferencesChange, preferences])
  return useMemo(() => ({
    comparison,
    selectedPath,
    isGitRepository,
    isFilePreview,
    diffStyle,
    workspaceView,
    reviewFileCount,
    repositoryReview,
    reviewWorldSource,
    wordWrap: preferences.wordWrap,
    foldUnchanged: preferences.foldUnchanged,
    fileEdit,
    submittingPullRequestReview,
    pullRequestReviewMessage,
    inlineCommentCount,
    orphanedCommentCount,
    newRevision,
    reviewComposerExpanded,
    reviewComposerBody,
    onReviewComposerExpandedChange,
    onReviewComposerBodyChange,
    onDiffStyleChange,
    onWordWrapToggle: toggleWordWrap,
    onFoldUnchangedToggle: toggleFoldUnchanged,
    onOpenReviewSummary,
    onSubmitPullRequestReview,
    sidebarVisible,
    onSidebarToggle,
    sidebarShortcut
  }), [
    comparison,
    diffStyle,
    fileEdit,
    inlineCommentCount,
    orphanedCommentCount,
    newRevision,
    isFilePreview,
    reviewComposerBody,
    reviewComposerExpanded,
    onReviewComposerBodyChange,
    onReviewComposerExpandedChange,
    isGitRepository,
    onDiffStyleChange,
    onOpenReviewSummary,
    onSubmitPullRequestReview,
    preferences.foldUnchanged,
    preferences.wordWrap,
    pullRequestReviewMessage,
    repositoryReview,
    reviewWorldSource,
    reviewFileCount,
    selectedPath,
    submittingPullRequestReview,
    toggleFoldUnchanged,
    toggleWordWrap,
    workspaceView,
    sidebarVisible,
    onSidebarToggle,
    sidebarShortcut
  ])
}

const RepositoryDiffPanel = memo(function RepositoryDiffPanel({
  surfaceRef,
  isFilePreview,
  header,
  conflict,
  onKeepDraft,
  onReloadFromDisk,
  conversationUnavailable,
  onRetryConversation,
  patchLoadError,
  viewerSuspended,
  workspaceView,
  reviewWorldId,
  reviewRoot,
  reviewSessionRevision,
  reviewPaths,
  diffStyle,
  viewerPreferences,
  repositoryReview,
  reviewLoadState,
  reviewLoading,
  reviewTargetPathCount,
  onLoadMoreReviewFiles,
  pullRequestConversation,
  reviewScrollRevision,
  selectedPath,
  multiFileNavigationRevision,
  handledNavigationRevisionRef,
  getInitialScrollTop,
  onScrollPositionChange,
  onVisiblePathChange,
  threadsByPath,
  setThreadsByPath,
  viewedFiles,
  setViewedFiles,
  remoteThreadsByPath,
  pendingRemoteThreadId,
  onReplyToRemoteThread,
  onResolveRemoteThread,
  onAttachToAgent,
  reviewCommand,
  surfaceComparison,
  surfaceLoading,
  editMode,
  documentView,
  onStartEdit,
  onDraftFileChange,
  onEditorAttach,
  onEditorBlur,
  showStatusBar,
  fileExtension,
  dirty,
  getEditor,
  onError,
  workingDrafts,
  autosaveOnBlur
}: RepositoryDiffPanelProps): React.JSX.Element {
  const DiffSurface = useLoadedModule(subscribeDiffSurface, getLoadedDiffSurface)
  const MultiFileReview = useLoadedModule(subscribeMultiFileReview, getLoadedMultiFileReview)

  useViewerChunkPreload(workspaceView, onError)

  return (
    <section ref={surfaceRef} className={`diff-panel ${isFilePreview ? 'file-preview-mode' : ''}`} id="repository-diff">
      <RepositoryReviewHeader {...header} reviewWorldId={reviewWorldId} />
      <FindBar />
      <EditConflictBar conflict={conflict} onKeepDraft={onKeepDraft} onReloadFromDisk={onReloadFromDisk} />
      <ConversationErrorBar message={conversationUnavailable} onRetry={onRetryConversation} />
      {patchLoadError == null ? null : (
        <div className="multi-file-error" role="alert">{patchLoadError}</div>
      )}
      {viewerSuspended ? (
        <div className="diff-state"><span>Viewer paused while the app is hidden.</span></div>
      ) : workspaceView === 'multi' ? (
        MultiFileReview == null ? <WorkspaceCodeSkeleton /> : (
            <MultiFileReview
              key={reviewSessionRevision}
              worldId={reviewWorldId}
              reviewRoot={reviewRoot}
              workingDrafts={workingDrafts}
              autosaveOnBlur={autosaveOnBlur}
              onError={onError}
              paths={reviewPaths}
              diffStyle={diffStyle}
              preferences={viewerPreferences}
              repositoryReview={repositoryReview}
              loadState={reviewLoadState}
              loading={reviewLoading}
              targetPathCount={reviewTargetPathCount}
              onLoadMore={onLoadMoreReviewFiles}
              pullRequestConversation={pullRequestConversation}
              scrollToReviewRevision={reviewScrollRevision}
              navigationPath={selectedPath}
              navigationRevision={multiFileNavigationRevision}
              handledNavigationRevisionRef={handledNavigationRevisionRef}
              getInitialScrollTop={getInitialScrollTop}
              onScrollPositionChange={onScrollPositionChange}
              onVisiblePathChange={onVisiblePathChange}
              threadsByPath={threadsByPath}
              setThreadsByPath={setThreadsByPath}
              viewedFiles={viewedFiles}
              setViewedFiles={setViewedFiles}
              remoteThreadsByPath={remoteThreadsByPath}
              pendingRemoteThreadId={pendingRemoteThreadId}
              onReplyToRemoteThread={onReplyToRemoteThread}
              onResolveRemoteThread={onResolveRemoteThread}
              onAttachToAgent={onAttachToAgent}
              reviewCommand={reviewCommand}
            />
        )
      ) : (
        DiffSurface == null ? <WorkspaceCodeSkeleton /> : (
            <DiffSurface comparison={surfaceComparison} loading={surfaceLoading} diffStyle={diffStyle}
              preferences={viewerPreferences} editMode={editMode} documentView={documentView}
              onStartEdit={onStartEdit} getEditor={getEditor}
              onDraftFileChange={onDraftFileChange} onEditorAttach={onEditorAttach}
              onEditorBlur={onEditorBlur}
              onAttachToAgent={onAttachToAgent}
              threadsByPath={threadsByPath} setThreadsByPath={setThreadsByPath} />
        )
      )}
      <ReviewFinishBar
        visible={workspaceView === 'multi'}
        review={header.repositoryReview}
        reviewWorldSource={header.reviewWorldSource}
        submitting={header.submittingPullRequestReview}
        message={header.pullRequestReviewMessage}
        inlineCommentCount={header.inlineCommentCount}
        orphanedCommentCount={header.orphanedCommentCount}
        expanded={header.reviewComposerExpanded}
        body={header.reviewComposerBody}
        onExpandedChange={header.onReviewComposerExpandedChange}
        onBodyChange={header.onReviewComposerBodyChange}
        onSubmit={header.onSubmitPullRequestReview}
      />
      {showStatusBar ? (
        <EditorStatusBar
          mode={editMode}
          documentView={documentView}
          dirty={dirty}
          fileExtension={fileExtension}
          getEditor={getEditor}
        />
      ) : null}
    </section>
  )
})

function useRetainedComparison(
  comparison: FileComparison | null,
  selectedPath: string | null,
  loading: boolean,
  workspaceView: WorkspaceView
): { comparison: FileComparison | null; loading: boolean } {
  // Multi-file review unmounts DiffSurface. Retain only the last comparison for
  // the same path so returning to a file does not flash an empty viewer.
  const retainedRef = useRef<FileComparison | null>(null)
  useEffect(() => {
    if (comparison != null) retainedRef.current = comparison
  }, [comparison])
  useEffect(() => {
    if (workspaceView === 'multi' && retainedRef.current?.path !== selectedPath) {
      retainedRef.current = null
    }
  }, [selectedPath, workspaceView])
  const retained = comparison ?? (retainedRef.current?.path === selectedPath ? retainedRef.current : null)
  return {
    comparison: retained,
    loading: loading || (comparison == null && retained != null)
  }
}

function usePullRequestReviewSubmission(
  orphanedCommentCount: number,
  reviewComments: PullRequestReviewComment[],
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>,
  submit: RepositoryWorkspaceProps['onSubmitPullRequestReview'],
  onSubmitFailed: () => void
): {
  reviewSessionRevision: number
  submitReview(event: PullRequestReviewEvent, body: string): Promise<boolean>
} {
  const [reviewSessionRevision, setReviewSessionRevision] = useState(0)
  const submitReview = useCallback(async (event: PullRequestReviewEvent, body: string) => {
    if (orphanedCommentCount > 0) return false
    const submitted = await submit(event, body, reviewComments)
    if (submitted) {
      setThreadsByPath({})
      setReviewSessionRevision((revision) => revision + 1)
    } else {
      // The usual refusal is a push since the review opened. Reading the
      // conversation now brings the new head in, and with it "Load new commits",
      // instead of leaving the reader at a dead end for up to a poll interval.
      onSubmitFailed()
    }
    return submitted
  }, [onSubmitFailed, orphanedCommentCount, reviewComments, setThreadsByPath, submit])
  return { reviewSessionRevision, submitReview }
}

function useRepositoryReviewSession({
  root,
  reviewIdentity,
  reviewWorldId,
  reviewPaths,
  workspaceView,
  repositoryReview,
  repositoryChange,
  reviewWorldSource
}: {
  root: string
  reviewIdentity: string
  reviewWorldId: string
  reviewPaths: readonly string[]
  workspaceView: WorkspaceView
  repositoryReview: RepositoryReview | null
  repositoryChange: RepositoryChangeEvent | null
  reviewWorldSource: RepositoryWorkspaceProps['reviewWorldSource']
}) {
  const active = workspaceView === 'multi'
  const activePaths = useMemo(() => active ? [...reviewPaths] : [], [active, reviewPaths])
  const pathsKey = useMemo(() => activePaths.join('\0'), [activePaths])
  const load = useReviewLoadState({
    pathsKey,
    stablePaths: activePaths,
    repositoryReview: active ? repositoryReview : null,
    repositoryChange: active ? repositoryChange : null,
    worldId: reviewWorldId,
    root
  })
  const session = useReviewSession(root, reviewIdentity, {
    items: load.loadState.items,
    loading: load.loading,
    enabled: active && reviewWorldSource === 'patch' && repositoryReview?.kind === 'github'
  })
  return { ...session, load }
}

function useReviewNavigation({
  paths,
  workspaceView,
  worldId,
  initialScrollTop,
  markInstantTreeFollowTarget,
  onSelectPath,
  onWorkspaceViewChange,
  onScrollPositionChange
}: {
  paths: readonly string[]
  workspaceView: WorkspaceView
  worldId: string
  initialScrollTop: number
  markInstantTreeFollowTarget(path: string): void
  onSelectPath(path: string): void
  onWorkspaceViewChange(view: WorkspaceView): void
  onScrollPositionChange(scrollTop: number): void
}) {
  const [reviewCommand, setReviewCommand] = useState<{
    command: ReviewCommand
    path: string
    revision: number
  } | null>(null)
  const [scrollRevision, setScrollRevision] = useState(0)
  const [navigationRevision, setNavigationRevision] = useState(0)
  const visiblePathRef = useRef<string | null>(null)
  // The workspace outlives its review worlds, and one scroll position served
  // them all: a commit review opened from a Desk scrolled to its fortieth file
  // started at that same offset, on whatever file sat there. The position is
  // remembered with the world it belongs to, and a world seen for the first time
  // starts where that world was left (`initialScrollTop` is per world), captured
  // once per switch — the prop moves on every scroll and must not re-seed.
  const [seed, setSeed] = useState({ worldId, scrollTop: initialScrollTop })
  if (seed.worldId !== worldId) setSeed({ worldId, scrollTop: initialScrollTop })
  const seedScrollTop = seed.worldId === worldId ? seed.scrollTop : initialScrollTop
  const scrollTopRef = useRef<{ worldId: string; scrollTop: number }>({ worldId, scrollTop: initialScrollTop })
  const getInitialScrollTop = useCallback(() => {
    const remembered = scrollTopRef.current
    return remembered.worldId === worldId ? remembered.scrollTop : seedScrollTop
  }, [seedScrollTop, worldId])
  // Which request the review has acted on. It lives here, not in the review: a
  // click on a review file from the single-file view mounts the review in the
  // same update that asks it to move, and a review seeding "handled" from the
  // revision it mounted with took that request as already done — it reopened
  // where it was left instead of on the file.
  const handledNavigationRevisionRef = useRef(0)
  const advance = useCallback(() => setNavigationRevision((revision) => revision + 1), [])
  const openSummary = useCallback(() => {
    scrollTopRef.current = { worldId, scrollTop: 0 }
    onWorkspaceViewChange('multi')
    setScrollRevision((revision) => revision + 1)
  }, [onWorkspaceViewChange, worldId])
  const rememberScroll = useCallback((scrollTop: number) => {
    scrollTopRef.current = { worldId, scrollTop }
    onScrollPositionChange(scrollTop)
  }, [onScrollPositionChange, worldId])
  const navigate = useCallback((path: string) => {
    markInstantTreeFollowTarget(path)
    onSelectPath(path)
    advance()
  }, [advance, markInstantTreeFollowTarget, onSelectPath])
  const runItemCommand = useCallback((command: ReviewCommand, path: string) => {
    setReviewCommand((current) => ({ command, path, revision: (current?.revision ?? 0) + 1 }))
  }, [])

  useReviewShortcuts({
    active: workspaceView === 'multi',
    paths,
    currentPathRef: visiblePathRef,
    onNavigate: navigate,
    onItemCommand: runItemCommand
  })

  return {
    advance,
    getInitialScrollTop,
    handledNavigationRevisionRef,
    navigationRevision,
    openSummary,
    rememberScroll,
    reviewCommand,
    scrollRevision,
    visiblePathRef
  }
}

// Visibility reports this soon after a selection belong to the jump landing,
// not to the reader scrolling (see useRepositoryExplorer).
const NAVIGATION_SETTLE_MS = 1_000

function useRepositoryExplorer({
  snapshot,
  reviewWorldId,
  initialReviewScrollTop,
  reviewWorldSource,
  treePaths,
  treeStatuses,
  selectedPath,
  workspaceView,
  reviewPathSet,
  collisionPathsRef,
  markInstantTreeFollowTarget,
  consumeInstantTreeFollowTarget,
  onSelectPath,
  onWorkspaceViewChange,
  advanceMultiFileNavigation,
  visibleMultiFilePathRef
}: {
  snapshot: RepositorySnapshot
  reviewWorldId: string
  initialReviewScrollTop: number
  reviewWorldSource: RepositoryWorkspaceProps['reviewWorldSource']
  treePaths: readonly string[]
  treeStatuses: readonly { path: string; status: TreeFileStatus }[]
  selectedPath: string | null
  workspaceView: WorkspaceView
  reviewPathSet: ReadonlySet<string>
  collisionPathsRef: { current: ReadonlySet<string> }
  markInstantTreeFollowTarget(path: string): void
  consumeInstantTreeFollowTarget(path: string): string | null
  onSelectPath(path: string): void
  onWorkspaceViewChange(view: WorkspaceView): void
  advanceMultiFileNavigation(): void
  visibleMultiFilePathRef: { current: string | null }
}): {
  model: FileTreeModel
  explorerPaths: readonly string[]
  activateTreeRow(path: string): void
  handleVisibleMultiFilePathChange(path: string): void
} {
  const treeContent = useMemo(
    () => ({ treePaths, treeStatuses }),
    [treePaths, treeStatuses]
  )
  const deferredTreeContent = useDeferredValue(treeContent)
  const liveTree = reviewWorldSource !== 'desk'
  const explorerPaths = liveTree ? treePaths : deferredTreeContent.treePaths
  const explorerStatuses = liveTree ? treeStatuses : deferredTreeContent.treeStatuses
  const pathSet = useMemo(() => new Set(explorerPaths), [explorerPaths])
  const directoryPaths = useMemo(() => getDirectoryPaths(explorerPaths), [explorerPaths])
  // Which files changed moves far less often than how: staging flips a status
  // and keeps the set, so the folder walk keys on the retained set.
  const changedPaths = useRetainedPathList(useMemo(
    () => explorerStatuses.map((status) => status.path),
    [explorerStatuses]
  ))
  const changedDirectoryPaths = useMemo(() => {
    const changed = collectDirectoryPaths(changedPaths)
    return directoryPaths.filter((directoryPath) => changed.has(directoryPath))
  }, [changedPaths, directoryPaths])
  const activateTreeRow = useCallback((path: string) => {
    if (!pathSet.has(path)) return
    markInstantTreeFollowTarget(path)
    onSelectPath(path)
    const nextView = workspaceViewForTreePath(reviewPathSet.has(path))
    if (nextView !== workspaceView) onWorkspaceViewChange(nextView)
    if (nextView === 'multi') advanceMultiFileNavigation()
  }, [advanceMultiFileNavigation, markInstantTreeFollowTarget, onSelectPath,
    onWorkspaceViewChange, pathSet, reviewPathSet, workspaceView])

  // The palette's way in (see openInWorkspace). A path that is already
  // selected leaves the effect below with nothing to react to, so this moves the
  // review itself; a new path is handled there too, and a second bump of the
  // navigation revision in the same commit is one jump.
  const navigatedSelectionRef = useRef(selectedPath)
  // A pick is a request to go there, even to the file the review last reported
  // as on screen: that report is debounced, so straight after a jump from A to B
  // it still said A, and picking A again read as "already there" and did nothing.
  const pickedPathRef = useRef<string | null>(null)
  const openFromPalette = useCallback((path: string) => {
    pickedPathRef.current = path
    onSelectPath(path)
    // A new path moves through the effect below; only the one it will not see
    // changing is moved here. Doing both left a second instant-follow mark that
    // turned a later scroll's tree follow into a jump.
    if (path !== navigatedSelectionRef.current) return
    pickedPathRef.current = null
    if (workspaceView !== 'multi' || !reviewPathSet.has(path) || !pathSet.has(path)) return
    markInstantTreeFollowTarget(path)
    advanceMultiFileNavigation()
  }, [advanceMultiFileNavigation, markInstantTreeFollowTarget, onSelectPath, pathSet, reviewPathSet,
    workspaceView])
  useEffect(() => setWorkspaceFileOpener(openFromPalette), [openFromPalette])

  // A file's changes can go away while it is open: committed (here or from a
  // terminal), reverted, stashed. The review then has nothing for it, and the
  // reader was left on "No files to review" — or on another file — with the file
  // they were reading still selected and no way to see it. The file itself is
  // what there is to show. Only a file that was in the review and left it
  // counts: while a folder opens, the review is empty before its statuses land.
  const reviewedSelectionRef = useRef<string | null>(null)
  // Whether the reader has scrolled on to another file since selecting this one;
  // a reader who has keeps reading what they scrolled to. Set by the review's
  // visibility reports (see handleVisibleMultiFilePathChange), reset by every
  // selection.
  const scrolledAwayRef = useRef({ path: null as string | null, since: 0, away: false })
  const selectionStateRef = useRef({ selectedPath, reviewPathSet })
  useLayoutEffect(() => {
    selectionStateRef.current = { selectedPath, reviewPathSet }
    if (scrolledAwayRef.current.path !== selectedPath) {
      scrolledAwayRef.current = { path: selectedPath, since: performance.now(), away: false }
    }
  }, [reviewPathSet, selectedPath])
  useEffect(() => {
    if (selectedPath == null) return
    if (reviewPathSet.has(selectedPath)) {
      reviewedSelectionRef.current = selectedPath
      return
    }
    if (reviewedSelectionRef.current !== selectedPath) return
    reviewedSelectionRef.current = null
    if (workspaceView !== 'multi' || reviewWorldSource !== 'desk' || !pathSet.has(selectedPath)) return
    if (reviewPathSet.size > 0 && scrolledAwayRef.current.path === selectedPath && scrolledAwayRef.current.away) return
    onWorkspaceViewChange('file')
  }, [onWorkspaceViewChange, pathSet, reviewPathSet, reviewWorldSource, selectedPath, workspaceView])

  // Coming back to a review tab hands the workspace that tab's selection, which
  // is a restore, not a request to move: the tab's viewer puts its own scroll
  // back. Navigating here jumped every returning tab to its selected file. A tab
  // that arrives with no scroll of its own — a new review, or Source Control
  // opening a file on the Desk — does go to its selected file.
  const navigatedWorldIdRef = useRef(reviewWorldId)
  useEffect(() => {
    const previous = navigatedSelectionRef.current
    navigatedSelectionRef.current = selectedPath
    const picked = pickedPathRef.current != null && pickedPathRef.current === selectedPath
    pickedPathRef.current = null
    const worldChanged = navigatedWorldIdRef.current !== reviewWorldId
    navigatedWorldIdRef.current = reviewWorldId
    if (worldChanged && initialReviewScrollTop > 0) return
    if (selectedPath == null || (!worldChanged && selectedPath === previous)) return
    if (workspaceView !== 'multi') return
    if (!reviewPathSet.has(selectedPath)) {
      // A patch world that was released, or is still streaming its pages, has no
      // file list yet. Demoting it now would strand the tab in the single-file
      // view against the working tree once the pages land.
      if (reviewWorldSource === 'patch' && reviewPathSet.size === 0) return
      onWorkspaceViewChange('file')
      return
    }
    if (!picked && selectedPath === visibleMultiFilePathRef.current) return
    if (!pathSet.has(selectedPath)) return
    markInstantTreeFollowTarget(selectedPath)
    advanceMultiFileNavigation()
  }, [advanceMultiFileNavigation, markInstantTreeFollowTarget, onWorkspaceViewChange, pathSet,
    initialReviewScrollTop, reviewPathSet, reviewWorldId, reviewWorldSource, selectedPath, visibleMultiFilePathRef,
    workspaceView])

  /**
   * The two effects below mirror app state into the tree's selection, and
   * `@pierre/trees` reports that selection back synchronously, inside the same
   * commit. Switching to a pull request tab writes the review's path into the
   * tree during the layout phase, the echo arrived before the passive effect had
   * refreshed this ref, and the *previous* world's handler ran: it saw a path
   * that is not in its own review, decided the reader had clicked a file outside
   * the diff, and switched the workspace to the single-file view against the
   * working tree. Which is what a reader coming back to their review found.
   *
   * So: only a real click may re-derive the view, and the ref is refreshed in the
   * layout phase, before any mirror can fire.
   */
  const mirroringTreeSelectionRef = useRef(false)
  const handleTreeSelection = useCallback((paths: readonly string[]) => {
    if (mirroringTreeSelectionRef.current) return
    const path = paths.at(-1)
    if (path == null || path === visibleMultiFilePathRef.current) return
    activateTreeRow(path)
  }, [activateTreeRow, visibleMultiFilePathRef])

  const treeSelectionRef = useRef(handleTreeSelection)
  useLayoutEffect(() => {
    treeSelectionRef.current = handleTreeSelection
  }, [handleTreeSelection])

  const { model } = useFileTree({
    id: 'repository-tree',
    paths: [],
    initialExpansion: snapshot.kind === 'git' ? 0 : 1,
    flattenEmptyDirectories: true,
    // The preset scales the gaps with the row. Setting a row height alone leaves
    // every gap at its full-size value, and the tree reads loose however short
    // the rows are.
    density: 'compact',
    overscan: 12,
    stickyFolders: true,
    // The filter field above the tree is the one input; the library's own search
    // would render a second one directly under it, reading as two searches for
    // two different things.
    search: false,
    // In a review tree every row is a changed file, so tinted filetype glyphs
    // are five more colours competing with the one that means something.
    icons: { set: 'complete', colored: false },
    renderRowDecoration: ({ item }) => collisionPathsRef.current.has(item.path)
      ? {
          text: 'Desk',
          title: 'This path also has changes on Desk',
          parts: [{ text: 'Desk', color: 'var(--status-warning-text)' }]
        }
      : null,
    unsafeCSS: TREE_STYLES,
    composition: {
      contextMenu: {
        enabled: true,
        triggerMode: 'both',
        buttonVisibility: 'when-needed',
        render: (item, context) => createTreeContextMenu(
          snapshot.root, item, context, pathSet.has(item.path)
        ),
        onClose: () => {
          document.querySelector('[data-kodi-tree-menu]')?.remove()
        }
      }
    },
    onSelectionChange: (paths) => treeSelectionRef.current(paths)
  })

  const scrollTreeToPath = useCallback((path: string, offset: 'nearest' | 'center') => {
    model.scrollToPath(path, { focus: false, offset })
  }, [model])

  /** Writes app state into the tree without it reading back as a click. */
  const mirrorTreeSelection = useCallback((path: string) => {
    mirroringTreeSelectionRef.current = true
    try {
      selectOnlyTreePath(model, path)
    } finally {
      mirroringTreeSelectionRef.current = false
    }
  }, [model])

  useTreeContentSync(model, snapshot.root, snapshot.kind === 'git', explorerPaths, explorerStatuses,
    directoryPaths, changedDirectoryPaths)

  // A file opened from anywhere — ⌘K, a search result, a restore — is opened
  // out to in the tree: a row inside a closed folder does not exist, so it was
  // neither shown nor selected. Once per file, so a folder the reader closes
  // afterwards stays closed through the ticks that follow.
  const revealedSelectionRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (selectedPath == null) return
    if (revealedSelectionRef.current !== selectedPath) {
      for (const directoryPath of collectDirectoryPaths([selectedPath])) {
        const item = model.getItem(directoryPath)
        if (item != null && 'expand' in item) item.expand()
      }
      if (model.getItem(selectedPath) != null) revealedSelectionRef.current = selectedPath
    }
    mirrorTreeSelection(selectedPath)
    scrollTreeToPath(selectedPath, 'nearest')
  }, [explorerPaths, mirrorTreeSelection, model, scrollTreeToPath, selectedPath])

  // A fling through the review crosses a file every few milliseconds, and each
  // report used to cost the tree three notifications (deselect, select,
  // scroll) and a render each. The latest report of a frame is the only one
  // anybody sees, so the tree follows once per frame.
  const pendingFollowRef = useRef<{ path: string; frame: number } | null>(null)
  const followVisiblePath = useCallback((path: string) => {
    for (const directoryPath of collectDirectoryPaths([path])) {
      const item = model.getItem(directoryPath)
      if (item != null && 'expand' in item) item.expand()
    }
    mirrorTreeSelection(path)
    const instantTarget = consumeInstantTreeFollowTarget(path)
    const followBehavior = getTreeFollowBehavior(instantTarget == null ? 'review-scroll' : 'direct-navigation')
    // A row already on screen needs no scroll, and a scroll request is one more
    // notification and render of the tree.
    if (!treeRowInView(model, path)) scrollTreeToPath(path, followBehavior.offset)
  }, [consumeInstantTreeFollowTarget, mirrorTreeSelection, model, scrollTreeToPath])
  const handleVisibleMultiFilePathChange = useCallback((path: string) => {
    if (!pathSet.has(path)) return
    // A report of another file counts as the reader moving on only while the
    // selected file is still in the review (once it has left, the list moved,
    // not the reader) and once the jump to it has settled.
    const { selectedPath: selected, reviewPathSet: reviewing } = selectionStateRef.current
    const scrolled = scrolledAwayRef.current
    if (selected != null && path !== selected && scrolled.path === selected && reviewing.has(selected)
      && performance.now() - scrolled.since > NAVIGATION_SETTLE_MS) {
      scrolled.away = true
    }
    visibleMultiFilePathRef.current = path
    const pending = pendingFollowRef.current
    if (pending != null) {
      pending.path = path
      return
    }
    const next = { path, frame: 0 }
    next.frame = window.requestAnimationFrame(() => {
      pendingFollowRef.current = null
      followVisiblePath(next.path)
    })
    pendingFollowRef.current = next
  }, [followVisiblePath, pathSet, visibleMultiFilePathRef])
  useEffect(() => () => {
    const pending = pendingFollowRef.current
    if (pending != null) window.cancelAnimationFrame(pending.frame)
    pendingFollowRef.current = null
  }, [])

  // ⌘P offers directories as rows; choosing one has to move the explorer to it,
  // which means opening every ancestor first — the tree cannot scroll to a row
  // that is not rendered.
  const revealPath = useCallback((path: string) => {
    for (const directoryPath of collectDirectoryPaths([path])) {
      const item = model.getItem(directoryPath)
      if (item != null && 'expand' in item) item.expand()
    }
    const item = model.getItem(path)
    if (item != null && 'expand' in item) item.expand()
    scrollTreeToPath(path, 'nearest')
  }, [model, scrollTreeToPath])

  useEffect(() => setExplorerRevealHandler(revealPath), [revealPath])

  return { model, explorerPaths, activateTreeRow, handleVisibleMultiFilePathChange }
}

const RepositoryWorkspace = memo(function RepositoryWorkspace({
  snapshot, selectedPath, comparison, loadingDiff, diffStyle, workspaceView,
  preferences, onAttachToAgent, onPreferencesChange, repositoryReview, reviewWorldSource,
  repositoryChange, onSelectPath,
  collisionPaths, initialReviewScrollTop, onReviewScrollPositionChange,
  onDiffStyleChange, onWorkspaceViewChange, onReloadReview,
  submittingPullRequestReview,
  pullRequestReviewMessage, onSubmitPullRequestReview, onComparisonSaved, onError,
  patchLoadError, reviewWorldId, sidebarVisible, onSidebarToggle, onBranchesOpen
}: RepositoryWorkspaceProps): React.JSX.Element {
  useLayoutEffect(() => {
    markRendererStartup('explorerCommitted')
    // A workspace whose viewer draws nothing (no changes, a load still running)
    // never reports a highlighted render; it is final enough by now.
    reportFirstScreenAfter(WORKSPACE_FIRST_SCREEN_MS)
  }, [])
  useEffect(markWorkspaceRender)
  const isFilePreview = workspaceView === 'file' && comparison?.mode === 'file'
  const reviewIdentity = repositoryReviewIdentity(repositoryReview)
  const reviewPaths = useReviewPaths(snapshot, repositoryReview)
  const {
    fileFilter,
    setFileFilter,
    composerExpanded: reviewComposerExpanded,
    setComposerExpanded: setReviewComposerExpanded,
    composerBody: reviewComposerBody,
    setComposerBody: setReviewComposerBody
  } = useReviewDraft(reviewIdentity)
  const treeSourcePaths = reviewWorldSource === 'desk' && repositoryReview == null
    ? snapshot.paths
    : reviewPaths
  // The field stays on the urgent value; the scan over every path (and the tree
  // rebuild behind it) runs on the deferred one, so typing is never behind it.
  const deferredFileFilter = useDeferredValue(fileFilter)
  // `.gitattributes` decides "generated" for the changed files it has answered for.
  const isGenerated = useGeneratedPathTest(snapshot.root)
  const visibleTreePaths = useMemo(
    () => applyReviewFileFilter(treeSourcePaths, deferredFileFilter, isGenerated),
    [deferredFileFilter, treeSourcePaths, isGenerated]
  )
  const visibleReviewPaths = useMemo(
    () => applyReviewFileFilter(reviewPaths, deferredFileFilter, isGenerated),
    [deferredFileFilter, reviewPaths, isGenerated]
  )
  const { threadsByPath, setThreadsByPath, viewedFiles, setViewedFiles, load: reviewLoad } =
    useRepositoryReviewSession({
      root: snapshot.root,
      reviewIdentity,
      reviewWorldId,
      reviewPaths,
      workspaceView,
      repositoryReview,
      repositoryChange,
      reviewWorldSource
    })
  const conversation = usePullRequestConversation(snapshot.root, repositoryReview, onError, reviewWorldId)
  const viewer = useViewerContext()
  const codeZoom = useCodeZoomGesture(preferences.codeFontSize, preferences.codeLineHeight)
  const hiddenLongEnoughToRelease = useViewerSuspension()
  const { markInstantTreeFollowTarget, consumeInstantTreeFollowTarget } = useInstantTreeFollow()
  const {
    advance: advanceMultiFileNavigation,
    navigationRevision: multiFileNavigationRevision,
    openSummary: openReviewSummary,
    rememberScroll: handleMultiFileScrollPositionChange,
    reviewCommand,
    scrollRevision: reviewScrollRevision,
    getInitialScrollTop: getInitialMultiFileScrollTop,
    handledNavigationRevisionRef,
    visiblePathRef: visibleMultiFilePathRef
  } = useReviewNavigation({
    paths: visibleReviewPaths,
    workspaceView,
    worldId: reviewWorldId,
    initialScrollTop: initialReviewScrollTop,
    markInstantTreeFollowTarget,
    onSelectPath,
    onWorkspaceViewChange,
    onScrollPositionChange: onReviewScrollPositionChange
  })
  const collisionPathsRef = useRef(collisionPaths)
  useLayoutEffect(() => {
    collisionPathsRef.current = collisionPaths
  }, [collisionPaths])
  const fileEditing = useFileEditing({
    root: snapshot.root,
    comparison,
    selectedPath,
    workspaceView,
    repositoryReview,
    autosaveOnBlur: preferences.autosaveOnBlur,
    onSelectPath,
    onComparisonChange: onComparisonSaved,
    onError
  })
  const { treePaths, treeStatuses, reviewComments, orphanedCommentCount } =
    useReviewTreeData(snapshot, repositoryReview, visibleTreePaths, threadsByPath, reviewWorldSource)
  const reviewPathSet = useMemo(() => new Set(reviewPaths), [reviewPaths])
  const visibleReviewLoadState = useMemo(() => {
    const items = retainReviewItems(reviewLoad.loadState.items, visibleReviewPaths)
    return items === reviewLoad.loadState.items
      ? reviewLoad.loadState
      : { ...reviewLoad.loadState, items }
  }, [reviewLoad.loadState, visibleReviewPaths])
  // Navigating to a file the filter hides clears the filter, so the file shows.
  // Only a new selection asks that: typing a query that happens to hide the
  // current file used to wipe the field mid-word.
  const filterCheckedSelectionRef = useRef<string | null>(null)
  useEffect(() => {
    if (selectedPath == null || filterCheckedSelectionRef.current === selectedPath) return
    if (!reviewPaths.includes(selectedPath)) return
    filterCheckedSelectionRef.current = selectedPath
    if (visibleReviewPaths.includes(selectedPath)) return
    setFileFilter(EMPTY_REVIEW_FILE_FILTER)
  }, [reviewPaths, selectedPath, setFileFilter, visibleReviewPaths])
  const fileExtension = selectedPath?.split('.').at(-1)?.toUpperCase()
  const viewerPreferences = useViewerPreferences(preferences, codeZoom)
  // Releasing the viewer would destroy the edit session and every unsaved draft
  // with it, so a dirty workspace keeps its memory.
  const viewerSuspended = hiddenLongEnoughToRelease
    && fileEditing.activeSession == null
    && fileEditing.controls.unsavedPaths.length === 0

  // The same state that keeps the viewer mounted also blocks hibernation:
  // releasing a review world would take the edit session and its drafts with it.
  const unsavedSession = fileEditing.activeSession != null
  const unsavedCount = fileEditing.controls.unsavedPaths.length
  useHibernationVeto(useCallback(() => {
    if (unsavedCount > 0) return `${unsavedCount} file${unsavedCount === 1 ? '' : 's'} have unsaved edits`
    if (unsavedSession) return 'a file edit session is open'
    return null
  }, [unsavedCount, unsavedSession]))

  // Unmounting the viewer only frees DOM; the workers and their AST caches are
  // the expensive part, so the provider tears the pool down too.
  const setViewerSuspended = viewer?.setViewerSuspended
  useEffect(() => {
    setViewerSuspended?.(viewerSuspended)
  }, [setViewerSuspended, viewerSuspended])

  const { comparison: surfaceComparison, loading: surfaceLoading } = useRetainedComparison(
    fileEditing.renderedComparison,
    selectedPath,
    loadingDiff,
    workspaceView
  )

  const { reviewSessionRevision, submitReview: submitPullRequestReview } =
    usePullRequestReviewSubmission(
      orphanedCommentCount,
      reviewComments,
      setThreadsByPath,
      onSubmitPullRequestReview,
      conversation.refresh
    )

  const { model, explorerPaths, activateTreeRow, handleVisibleMultiFilePathChange } =
    useRepositoryExplorer({
      snapshot,
      reviewWorldId,
      initialReviewScrollTop,
      reviewWorldSource,
      treePaths,
      treeStatuses,
      selectedPath,
      workspaceView,
      reviewPathSet,
      collisionPathsRef,
      markInstantTreeFollowTarget,
      consumeInstantTreeFollowTarget,
      onSelectPath,
      onWorkspaceViewChange,
      advanceMultiFileNavigation,
      visibleMultiFilePathRef
    })

  // The conversation poll reads the pull request's head commit for free, so a
  // push lands here within one tick rather than at the next explicit reopen.
  const adoptNewRevision = useCallback(async () => {
    if (repositoryReview?.kind !== 'github') return false
    return await onReloadReview(repositoryReview.pullRequest.url)
  }, [onReloadReview, repositoryReview])
  const newRevisionWatch = useNewRevisionWatch(
    conversation.conversation?.headOid,
    repositoryReview?.kind === 'github' ? repositoryReview.headOid : null,
    adoptNewRevision,
    // Scoped to the pull request it describes: this workspace outlives a tab
    // switch, so a head pending on one review would otherwise reload whichever
    // review happens to be in front when the reader finally goes still.
    { reviewIdentity: repositoryReview?.kind === 'github' ? repositoryReview.pullRequest.url : null }
  )
  const newRevision = useMemo<NewRevisionNotice | null>(
    () => newRevisionWatch.pendingHeadOid == null
      ? null
      : { headOid: newRevisionWatch.pendingHeadOid, onAdopt: newRevisionWatch.adopt },
    [newRevisionWatch.adopt, newRevisionWatch.pendingHeadOid]
  )

  const sidebarShortcut = formatKeybinding(preferences.keybindings.toggleSidebar)
  const reviewHeader = useRepositoryReviewHeader({
    comparison: fileEditing.renderedComparison,
    selectedPath,
    isGitRepository: snapshot.kind === 'git',
    isFilePreview,
    diffStyle,
    workspaceView,
    reviewFileCount: visibleReviewPaths.length,
    repositoryReview,
    reviewWorldSource,
    preferences,
    fileEdit: fileEditing.controls,
    submittingPullRequestReview,
    pullRequestReviewMessage,
    inlineCommentCount: reviewComments.length,
    orphanedCommentCount,
    newRevision,
    reviewComposerExpanded,
    reviewComposerBody,
    onReviewComposerExpandedChange: setReviewComposerExpanded,
    onReviewComposerBodyChange: setReviewComposerBody,
    onDiffStyleChange,
    onPreferencesChange,
    onOpenReviewSummary: openReviewSummary,
    onSubmitPullRequestReview: submitPullRequestReview,
    sidebarVisible,
    onSidebarToggle,
    sidebarShortcut
  })

  return (
    <>
      <Explorer filePaths={explorerPaths} model={model} theme={preferences.editorTheme}
        sidebarVisible={sidebarVisible} onSidebarToggle={onSidebarToggle} sidebarShortcut={sidebarShortcut}
        isGit={snapshot.kind === 'git'} branchName={snapshot.kind === 'git' ? snapshot.branch : null}
        reviewMode={treeSourcePaths !== snapshot.paths} isGenerated={isGenerated}
        onBranchesOpen={onBranchesOpen} onRowActivate={activateTreeRow}
        fileFilter={fileFilter} onFileFilterChange={setFileFilter}
        unfilteredFilePaths={treeSourcePaths} />
      <SidebarResizer />
      <RepositoryDiffPanel
        surfaceRef={codeZoom.surfaceRef}
        isFilePreview={isFilePreview}
        header={reviewHeader}
        conflict={fileEditing.conflict}
        onKeepDraft={fileEditing.keepDraft}
        onReloadFromDisk={fileEditing.reloadFromDisk}
        conversationUnavailable={repositoryReview?.kind === 'github' ? conversation.unavailableMessage : null}
        onRetryConversation={conversation.refresh}
        patchLoadError={patchLoadError}
        viewerSuspended={viewerSuspended}
        workspaceView={workspaceView}
        reviewWorldId={reviewWorldId}
        reviewRoot={snapshot.root}
        reviewSessionRevision={reviewSessionRevision}
        reviewPaths={visibleReviewPaths}
        diffStyle={diffStyle}
        viewerPreferences={viewerPreferences}
        repositoryReview={repositoryReview}
        reviewLoadState={visibleReviewLoadState}
        reviewLoading={reviewLoad.loading}
        reviewTargetPathCount={reviewLoad.targetPathCount}
        onLoadMoreReviewFiles={reviewLoad.loadMoreFiles}
        pullRequestConversation={conversation.conversation}
        reviewScrollRevision={reviewScrollRevision}
        selectedPath={selectedPath}
        multiFileNavigationRevision={multiFileNavigationRevision}
        handledNavigationRevisionRef={handledNavigationRevisionRef}
        getInitialScrollTop={getInitialMultiFileScrollTop}
        onScrollPositionChange={handleMultiFileScrollPositionChange}
        onVisiblePathChange={handleVisibleMultiFilePathChange}
        threadsByPath={threadsByPath}
        setThreadsByPath={setThreadsByPath}
        viewedFiles={viewedFiles}
        setViewedFiles={setViewedFiles}
        remoteThreadsByPath={conversation.threadsByPath}
        pendingRemoteThreadId={conversation.pendingThreadId}
        onReplyToRemoteThread={conversation.reply}
        onResolveRemoteThread={conversation.setResolved}
        onAttachToAgent={onAttachToAgent}
        reviewCommand={reviewCommand}
        surfaceComparison={surfaceComparison}
        surfaceLoading={surfaceLoading}
        editMode={fileEditing.controls.mode}
        documentView={selectedPath != null && isMarkdownPath(selectedPath)
          ? fileEditing.controls.documentView
          : 'source'}
        onStartEdit={fileEditing.controls.available && fileEditing.controls.mode === 'read'
          ? fileEditing.controls.onStart
          : undefined}
        onDraftFileChange={fileEditing.updateDraftFile}
        onEditorAttach={fileEditing.attachEditor}
        onEditorBlur={fileEditing.handleEditorBlur}
        showStatusBar={isFilePreview || fileEditing.activeSession != null}
        fileExtension={fileExtension}
        dirty={fileEditing.controls.dirty}
        getEditor={fileEditing.getEditor}
        onError={onError}
        workingDrafts={fileEditing.workingDrafts}
        autosaveOnBlur={preferences.autosaveOnBlur}
      />
    </>
  )
}, sameWorkspaceProps)

// `initialReviewScrollTop` is read only when the review world changes — a
// change that arrives with a new `reviewWorldId` anyway — but it moves after every scroll — so any render above (a
// watcher tick, each agent stream batch) re-rendered the whole workspace while
// the reader was scrolled anywhere but the top.
function sameWorkspaceProps(previous: RepositoryWorkspaceProps, next: RepositoryWorkspaceProps): boolean {
  const previousKeys = Object.keys(previous) as (keyof RepositoryWorkspaceProps)[]
  if (previousKeys.length !== Object.keys(next).length) return false
  return previousKeys.every((key) => key === 'initialReviewScrollTop' || Object.is(previous[key], next[key]))
}

export default RepositoryWorkspace
