import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type Ref, type SetStateAction } from 'react'
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
import { ReviewStatusBar } from '../review/ReviewStatusBar'
import { ReviewFinishBar } from '../review/ReviewFinishBar'
import { ConversationErrorBar } from '../agent/ConversationErrorBar'
import { EditConflictBar } from './WorkspaceNoticeBars'
import { useViewerChunkPreload } from './useViewerChunkPreload'
import { reviewToolbarComparison, reviewToolbarTitle } from '../review/reviewHeaderModel'
import type { ReviewCheckpoint } from '../review/reviewCheckpoints'
import type { ReviewAnnotationMetadata, ReviewThread } from '../review/ReviewComments'
import { createPullRequestReviewComments } from '../github/pullRequestReviewComments'
import type { AgentSelection } from '../agent/agentAttachments'
import { usePullRequestConversation } from '../github/usePullRequestConversation'
import { useReviewSession } from '../review/useReviewSession'
import { useReviewLoadState, type ReviewLoadState } from '../review/useReviewLoadState'
import { useHibernationVeto } from './useHibernation'
import { useViewerSuspension } from './useViewerSuspension'
import { formatKeybinding, type ReviewCommand } from '../settings/keybindings'
import { useReviewShortcuts } from '../review/useReviewShortcuts'
import {
  getDirectoryPaths,
  getTreeFollowBehavior,
  orderPathsForTree,
  treeContentSyncMode,
  type AppliedTreeContent
} from '../explorer/treeExpansion'
import { FindBar } from '../review/FindBar'
import { WorkspaceCodeSkeleton } from './WorkspaceSkeleton'
import { setExplorerRevealHandler } from '../explorer/explorerReveal'
import { markWorkspaceRender } from '../perf/workspaceRenderMetric'
import { useCodeZoomGesture } from '../diff/useCodeZoomGesture'
import { useFileEditing } from '../diff/useFileEditing'
import { EditorStatusBar } from '../editor/EditorStatusBar'
import { useViewerContext } from '../editor/ViewerProviders'
import { retainReviewItems } from '../review/reviewItems'
import { applyReviewFileFilter, EMPTY_REVIEW_FILE_FILTER } from '../review/reviewFileFilter'
import { useReviewDraft } from '../review/useReviewDraft'
import { reviewPathsForSnapshot, workspaceViewForTreePath } from '../explorer/workspaceMode'
import { copyWorkingFileContents } from '../diff/copyFilePath'
import {
  getLoadedDiffSurface,
  getLoadedMultiFileReview,
  subscribeDiffSurface,
  subscribeMultiFileReview
} from './workspaceBoot'
import { markRendererStartup } from './startupMetrics'

type TreeFileStatus = Exclude<RepositoryFileStatus, 'conflicted'>

function selectOnlyTreePath(model: FileTreeModel, path: string): void {
  const selectedPaths = model.getSelectedPaths()
  if (selectedPaths.length === 1 && selectedPaths[0] === path) return
  for (const selectedPath of selectedPaths) {
    if (selectedPath !== path) model.getItem(selectedPath)?.deselect()
  }
  if (!selectedPaths.includes(path)) model.getItem(path)?.select()
}

// The file tree has no conflicted state, so conflicts ride along as modified there.
function toTreeStatus(status: RepositoryFileStatus): TreeFileStatus {
  return status === 'conflicted' ? 'modified' : status
}

const TREE_STYLES = `
  :host {
    /* @pierre/trees reads its row font from these overrides inside the shadow
       root; --font-mono follows the code-font preference on :root. */
    --trees-font-family-override: var(--font-mono);
    --trees-font-size-override: 12px;
  }

  /* Named rather than a bare \`*\`: the document rule cannot cross the shadow
     boundary, and these are the only corners the tree rounds. The row's own
     ::before is the focus ring, so it has to match the row it traces. */
  button,
  [data-type="item"],
  [data-type="item"]::before,
  [data-file-tree-search-input],
  [data-type="context-menu-trigger"],
  [data-type="context-menu-anchor"] > slot,
  ::-webkit-scrollbar-thumb {
    corner-shape: squircle;
  }

  button {
    touch-action: manipulation;
    transition: scale 110ms var(--ease-out), background-color 100ms var(--ease-out);
  }

  button:active:not(:disabled) {
    scale: 0.96;
    transition-duration: 0s, 100ms;
  }

  /* A full-width, unselected row answers a press with a tint; a ratio scale
     would squash it by 20px and read as the row being crushed. */
  [data-type="item"]:active:not([data-item-selected="true"]) {
    scale: 1;
    background: var(--accent-soft);
  }

  [data-type="item"] {
    border-radius: var(--corner-compact);
  }

  /* A stationary pointer must not paint every virtualized row that passes under
     it during wheel or trackpad scrolling. The selected row stays visible. */
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

  /* The tree marks pointer-focused rows with data-item-focused, which makes its
     focus outline jump between rows on every click. Keep the outline for
     keyboard navigation, where it communicates focus, and let pointer clicks
     use the stable selection fill. Pseudo-elements skip the selector list
     above, so the ring declares its curve next to the suppression. */
  [data-type="item"]::before {
    corner-shape: squircle;
  }

  [data-type="item"][data-item-focused="true"]:not(:focus-visible)::before {
    content: none;
  }

  [data-file-tree-search-input] {
    height: var(--control-height) !important;
    border: 1px solid var(--border-strong) !important;
    border-radius: var(--corner-control) !important;
    padding: 0 8px !important;
    background: var(--surface-input) !important;
    color: var(--text) !important;
    font-size: var(--text-md) !important;
    box-shadow: none !important;
  }

  [data-file-tree-search-input]::placeholder {
    color: var(--faint);
  }

  [data-file-tree-search-input]:focus {
    outline: 0;
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong)) !important;
    box-shadow: var(--focus-glow) !important;
  }

  [data-file-tree-search-container] {
    padding: 8px var(--gutter-sidebar);
  }

  [data-file-tree-search-container][data-open="false"] {
    display: none;
  }

  /* The menu itself is portaled onto .app-shell so the sidebar cannot clip it
     and light-theme tokens still apply. Only the row trigger lives here. */
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
  onAttachToAgent(selection: AgentSelection): void
  onPreferencesChange(preferences: AppPreferences): void
  repositoryReview: RepositoryReview | null
  sinceRemovedPaths: readonly string[]
  sinceUncertainPaths: readonly string[]
  reviewWorldSource: 'desk' | 'patch' | 'since'
  reviewCheckpoint: ReviewCheckpoint | null
  checkpointChangedFileCount: number
  checkpointRemovedFileCount: number
  reviewReady: boolean
  repositoryChange: RepositoryChangeEvent | null
  collisionPaths: ReadonlySet<string>
  initialReviewScrollTop: number
  onReviewScrollPositionChange(scrollTop: number): void
  onSelectPath(path: string): void
  onDiffStyleChange(style: DiffStyle): void
  onWorkspaceViewChange(view: WorkspaceView): void
  onClosePullRequestReview(): void
  onSetReviewCheckpoint(): void
  onOpenSinceReview(): void
  submittingPullRequestReview: boolean
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
  reviewWorldSource: 'desk' | 'patch' | 'since'
  reviewCheckpoint: ReviewCheckpoint | null
  checkpointChangedFileCount: number
  checkpointRemovedFileCount: number
  reviewReady: boolean
  wordWrap: boolean
  foldUnchanged: boolean
  fileEdit: FileEditControls
  submittingPullRequestReview: boolean
  pullRequestReviewMessage: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  reviewComposerExpanded: boolean
  reviewComposerBody: string
  onReviewComposerExpandedChange(expanded: boolean): void
  onReviewComposerBodyChange(body: string): void
  onClosePullRequestReview(): void
  onSetReviewCheckpoint(): void
  onOpenSinceReview(): void
  onDiffStyleChange(style: DiffStyle): void
  onWordWrapToggle(): void
  onFoldUnchangedToggle(): void
  onOpenReviewSummary(): void
  onSubmitPullRequestReview(event: PullRequestReviewEvent, body: string): Promise<boolean>
  sidebarVisible: boolean
  onSidebarToggle(): void
  sidebarShortcut: string
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
  reviewCheckpoint,
  checkpointChangedFileCount,
  checkpointRemovedFileCount,
  reviewReady,
  wordWrap,
  foldUnchanged,
  fileEdit,
  submittingPullRequestReview,
  pullRequestReviewMessage,
  inlineCommentCount,
  orphanedCommentCount,
  reviewComposerExpanded,
  reviewComposerBody,
  onReviewComposerExpandedChange,
  onReviewComposerBodyChange,
  onClosePullRequestReview,
  onSetReviewCheckpoint,
  onOpenSinceReview,
  onDiffStyleChange,
  onWordWrapToggle,
  onFoldUnchangedToggle,
  onOpenReviewSummary,
  onSubmitPullRequestReview,
  sidebarVisible,
  onSidebarToggle,
  sidebarShortcut
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
        onCloseExternalReview={repositoryReview == null ? undefined : onClosePullRequestReview}
        onDiffStyleChange={onDiffStyleChange}
        onWordWrapToggle={onWordWrapToggle}
        onFoldUnchangedToggle={onFoldUnchangedToggle}
        sidebarVisible={sidebarVisible}
        onSidebarToggle={onSidebarToggle}
        sidebarShortcut={sidebarShortcut}
      />
      <ReviewStatusBar
        review={repositoryReview}
        reviewWorldSource={reviewWorldSource}
        submitting={submittingPullRequestReview}
        message={pullRequestReviewMessage}
        inlineCommentCount={inlineCommentCount}
        orphanedCommentCount={orphanedCommentCount}
        checkpointBar={repositoryReview?.kind === 'github' && reviewWorldSource === 'patch' ? {
          checkpoint: reviewCheckpoint,
          changedFileCount: checkpointChangedFileCount,
          removedFileCount: checkpointRemovedFileCount,
          reviewReady,
          onSetCheckpoint: onSetReviewCheckpoint,
          onOpenSince: onOpenSinceReview
        } : undefined}
        expanded={reviewComposerExpanded}
        body={reviewComposerBody}
        onExpandedChange={onReviewComposerExpandedChange}
        onBodyChange={onReviewComposerBodyChange}
        onOpen={onOpenReviewSummary}
        onSubmit={onSubmitPullRequestReview}
      />
    </>
  )
}

function useReviewPaths(
  snapshot: RepositorySnapshot,
  repositoryReview: RepositoryReview | null
): string[] {
  const unorderedReviewPaths = useMemo(
    () => reviewPathsForSnapshot(snapshot, repositoryReview),
    [repositoryReview, snapshot]
  )
  return useMemo(() => orderPathsForTree(unorderedReviewPaths), [unorderedReviewPaths])
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
    appliedTreeContentRef.current = { root, paths: treePaths, statuses: treeStatuses }
    if (mode !== 'status') model.resetPaths(treePaths)
    model.setGitStatus(treeStatuses)
    if (mode === 'status') {
      for (const directoryPath of changedDirectoryPaths) {
        const item = model.getItem(directoryPath)
        if (item != null && 'expand' in item) item.expand()
      }
      return
    }
    if (isGitRepository) {
      if (mode === 'reset') {
        for (const directoryPath of [...directoryPaths].reverse()) {
          const item = model.getItem(directoryPath)
          if (item != null && 'collapse' in item) item.collapse()
        }
      }
      for (const directoryPath of changedDirectoryPaths) {
        const item = model.getItem(directoryPath)
        if (item != null && 'expand' in item) item.expand()
      }
      return
    }
    for (const directoryPath of directoryPaths) {
      if (directoryPath.includes('/')) continue
      const item = model.getItem(directoryPath)
      if (item != null && 'expand' in item) item.expand()
    }
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
  reviewSessionRevision: number
  reviewPaths: readonly string[]
  diffStyle: DiffStyle
  viewerPreferences: AppPreferences
  repositoryReview: RepositoryReview | null
  reviewLoadState: ReviewLoadState
  reviewLoading: boolean
  reviewTargetPathCount: number
  onLoadMoreReviewFiles(): void
  sinceRemovedPaths: readonly string[]
  sinceUncertainPaths: readonly string[]
  pullRequestConversation: ReturnType<typeof usePullRequestConversation>['conversation']
  reviewScrollRevision: number
  selectedPath: string | null
  multiFileNavigationRevision: number
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
  onAttachToAgent(selection: AgentSelection): void
  reviewCommand: { command: ReviewCommand; path: string; revision: number } | null
  surfaceComparison: FileComparison | null
  surfaceLoading: boolean
  editMode: 'edit' | 'preview' | 'read'
  documentView: FileEditControls['documentView']
  onDraftFileChange(file: FileContents): void
  onEditorAttach(editor: Editor<ReviewAnnotationMetadata>): void
  onEditorBlur(): void
  showStatusBar: boolean
  fileExtension: string | undefined
  dirty: boolean
  getEditor(): Editor<ReviewAnnotationMetadata> | null
  onError(message: string | null): void
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
  reviewCheckpoint,
  checkpointChangedFileCount,
  checkpointRemovedFileCount,
  reviewReady,
  preferences,
  fileEdit,
  submittingPullRequestReview,
  pullRequestReviewMessage,
  inlineCommentCount,
  orphanedCommentCount,
  reviewComposerExpanded,
  reviewComposerBody,
  onReviewComposerExpandedChange,
  onReviewComposerBodyChange,
  onClosePullRequestReview,
  onSetReviewCheckpoint,
  onOpenSinceReview,
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
  reviewWorldSource: 'desk' | 'patch' | 'since'
  reviewCheckpoint: ReviewCheckpoint | null
  checkpointChangedFileCount: number
  checkpointRemovedFileCount: number
  reviewReady: boolean
  preferences: AppPreferences
  fileEdit: FileEditControls
  submittingPullRequestReview: boolean
  pullRequestReviewMessage: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  reviewComposerExpanded: boolean
  reviewComposerBody: string
  onReviewComposerExpandedChange(expanded: boolean): void
  onReviewComposerBodyChange(body: string): void
  onClosePullRequestReview(): void
  onSetReviewCheckpoint(): void
  onOpenSinceReview(): void
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
    reviewCheckpoint,
    checkpointChangedFileCount,
    checkpointRemovedFileCount,
    reviewReady,
    wordWrap: preferences.wordWrap,
    foldUnchanged: preferences.foldUnchanged,
    fileEdit,
    submittingPullRequestReview,
    pullRequestReviewMessage,
    inlineCommentCount,
    orphanedCommentCount,
    reviewComposerExpanded,
    reviewComposerBody,
    onReviewComposerExpandedChange,
    onReviewComposerBodyChange,
    onClosePullRequestReview,
    onSetReviewCheckpoint,
    onOpenSinceReview,
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
    isFilePreview,
    reviewComposerBody,
    reviewComposerExpanded,
    onReviewComposerBodyChange,
    onReviewComposerExpandedChange,
    isGitRepository,
    onClosePullRequestReview,
    onSetReviewCheckpoint,
    onOpenSinceReview,
    onDiffStyleChange,
    onOpenReviewSummary,
    onSubmitPullRequestReview,
    preferences.foldUnchanged,
    preferences.wordWrap,
    pullRequestReviewMessage,
    repositoryReview,
    reviewWorldSource,
    reviewCheckpoint,
    checkpointChangedFileCount,
    checkpointRemovedFileCount,
    reviewReady,
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
  reviewSessionRevision,
  reviewPaths,
  diffStyle,
  viewerPreferences,
  repositoryReview,
  reviewLoadState,
  reviewLoading,
  reviewTargetPathCount,
  onLoadMoreReviewFiles,
  sinceRemovedPaths,
  sinceUncertainPaths,
  pullRequestConversation,
  reviewScrollRevision,
  selectedPath,
  multiFileNavigationRevision,
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
  onDraftFileChange,
  onEditorAttach,
  onEditorBlur,
  showStatusBar,
  fileExtension,
  dirty,
  getEditor,
  onError
}: RepositoryDiffPanelProps): React.JSX.Element {
  const DiffSurface = useSyncExternalStore(
    subscribeDiffSurface,
    getLoadedDiffSurface,
    getLoadedDiffSurface
  )
  const MultiFileReview = useSyncExternalStore(
    subscribeMultiFileReview,
    getLoadedMultiFileReview,
    getLoadedMultiFileReview
  )

  useViewerChunkPreload(workspaceView, onError)

  return (
    <section ref={surfaceRef} className={`diff-panel ${isFilePreview ? 'file-preview-mode' : ''}`} id="repository-diff">
      <RepositoryReviewHeader {...header} />
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
              paths={reviewPaths}
              diffStyle={diffStyle}
              preferences={viewerPreferences}
              repositoryReview={repositoryReview}
              loadState={reviewLoadState}
              loading={reviewLoading}
              targetPathCount={reviewTargetPathCount}
              onLoadMore={onLoadMoreReviewFiles}
              sinceRemovedPaths={sinceRemovedPaths}
              sinceUncertainPaths={sinceUncertainPaths}
              pullRequestConversation={pullRequestConversation}
              scrollToReviewRevision={reviewScrollRevision}
              navigationPath={selectedPath}
              navigationRevision={multiFileNavigationRevision}
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
              getEditor={getEditor}
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
        onOpen={header.onOpenReviewSummary}
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
  submit: RepositoryWorkspaceProps['onSubmitPullRequestReview']
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
    }
    return submitted
  }, [orphanedCommentCount, reviewComments, setThreadsByPath, submit])
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
    worldId: reviewWorldId
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
  initialScrollTop,
  markInstantTreeFollowTarget,
  onSelectPath,
  onWorkspaceViewChange,
  onScrollPositionChange
}: {
  paths: readonly string[]
  workspaceView: WorkspaceView
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
  const scrollTopRef = useRef(initialScrollTop)
  const advance = useCallback(() => setNavigationRevision((revision) => revision + 1), [])
  const openSummary = useCallback(() => {
    scrollTopRef.current = 0
    onWorkspaceViewChange('multi')
    setScrollRevision((revision) => revision + 1)
  }, [onWorkspaceViewChange])
  const rememberScroll = useCallback((scrollTop: number) => {
    scrollTopRef.current = scrollTop
    onScrollPositionChange(scrollTop)
  }, [onScrollPositionChange])
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
    navigationRevision,
    openSummary,
    rememberScroll,
    reviewCommand,
    scrollRevision,
    scrollTopRef,
    visiblePathRef
  }
}

function useRepositoryExplorer({
  snapshot,
  reviewWorldSource,
  treePaths,
  treeStatuses,
  selectedPath,
  workspaceView,
  reviewPathSet,
  hasFileSession,
  collisionPathsRef,
  markInstantTreeFollowTarget,
  consumeInstantTreeFollowTarget,
  onSelectPath,
  onWorkspaceViewChange,
  advanceMultiFileNavigation,
  visibleMultiFilePathRef
}: {
  snapshot: RepositorySnapshot
  reviewWorldSource: RepositoryWorkspaceProps['reviewWorldSource']
  treePaths: readonly string[]
  treeStatuses: readonly { path: string; status: TreeFileStatus }[]
  selectedPath: string | null
  workspaceView: WorkspaceView
  reviewPathSet: ReadonlySet<string>
  hasFileSession: boolean
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
  const changedDirectoryPaths = useMemo(() => {
    const changed = collectDirectoryPaths(explorerStatuses.map((status) => status.path))
    return directoryPaths.filter((directoryPath) => changed.has(directoryPath))
  }, [directoryPaths, explorerStatuses])
  const activateTreeRow = useCallback((path: string) => {
    if (!pathSet.has(path)) return
    markInstantTreeFollowTarget(path)
    onSelectPath(path)
    const nextView = workspaceViewForTreePath(workspaceView, reviewPathSet.has(path), hasFileSession)
    if (nextView !== workspaceView) onWorkspaceViewChange(nextView)
    if (nextView === 'multi') advanceMultiFileNavigation()
  }, [advanceMultiFileNavigation, hasFileSession, markInstantTreeFollowTarget, onSelectPath,
    onWorkspaceViewChange, pathSet, reviewPathSet, workspaceView])

  const navigatedSelectionRef = useRef(selectedPath)
  useEffect(() => {
    const previous = navigatedSelectionRef.current
    navigatedSelectionRef.current = selectedPath
    if (selectedPath == null || selectedPath === previous) return
    if (workspaceView !== 'multi') return
    if (!reviewPathSet.has(selectedPath)) {
      onWorkspaceViewChange('file')
      return
    }
    if (selectedPath === visibleMultiFilePathRef.current) return
    if (!pathSet.has(selectedPath)) return
    markInstantTreeFollowTarget(selectedPath)
    advanceMultiFileNavigation()
  }, [advanceMultiFileNavigation, markInstantTreeFollowTarget, onWorkspaceViewChange, pathSet,
    reviewPathSet, selectedPath, visibleMultiFilePathRef, workspaceView])

  const handleTreeSelection = useCallback((paths: readonly string[]) => {
    const path = paths.at(-1)
    if (path == null || path === visibleMultiFilePathRef.current) return
    activateTreeRow(path)
  }, [activateTreeRow, visibleMultiFilePathRef])

  const treeSelectionRef = useRef(handleTreeSelection)
  useEffect(() => {
    treeSelectionRef.current = handleTreeSelection
  }, [handleTreeSelection])

  const { model } = useFileTree({
    id: 'repository-tree',
    paths: [],
    initialExpansion: snapshot.kind === 'git' ? 0 : 1,
    flattenEmptyDirectories: true,
    itemHeight: 27,
    overscan: 12,
    stickyFolders: true,
    search: true,
    icons: { set: 'complete', colored: true },
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

  useTreeContentSync(model, snapshot.root, snapshot.kind === 'git', explorerPaths, explorerStatuses,
    directoryPaths, changedDirectoryPaths)

  useLayoutEffect(() => {
    if (selectedPath == null) return
    selectOnlyTreePath(model, selectedPath)
    scrollTreeToPath(selectedPath, 'nearest')
  }, [explorerPaths, model, scrollTreeToPath, selectedPath])

  const handleVisibleMultiFilePathChange = useCallback((path: string) => {
    if (!pathSet.has(path)) return
    visibleMultiFilePathRef.current = path
    for (const directoryPath of collectDirectoryPaths([path])) {
      const item = model.getItem(directoryPath)
      if (item != null && 'expand' in item) item.expand()
    }
    selectOnlyTreePath(model, path)
    const instantTarget = consumeInstantTreeFollowTarget(path)
    const followBehavior = getTreeFollowBehavior(instantTarget == null ? 'review-scroll' : 'direct-navigation')
    scrollTreeToPath(path, followBehavior.offset)
  }, [consumeInstantTreeFollowTarget, model, pathSet, scrollTreeToPath, visibleMultiFilePathRef])

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
  reviewCheckpoint, checkpointChangedFileCount, checkpointRemovedFileCount, reviewReady,
  sinceRemovedPaths, sinceUncertainPaths,
  repositoryChange, onSelectPath,
  collisionPaths, initialReviewScrollTop, onReviewScrollPositionChange,
  onDiffStyleChange, onWorkspaceViewChange, onClosePullRequestReview, onSetReviewCheckpoint,
  onOpenSinceReview, submittingPullRequestReview,
  pullRequestReviewMessage, onSubmitPullRequestReview, onComparisonSaved, onError,
  patchLoadError, reviewWorldId, sidebarVisible, onSidebarToggle, onBranchesOpen
}: RepositoryWorkspaceProps): React.JSX.Element {
  useLayoutEffect(() => markRendererStartup('explorerCommitted'), [])
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
  const visibleTreePaths = useMemo(
    () => applyReviewFileFilter(treeSourcePaths, fileFilter),
    [fileFilter, treeSourcePaths]
  )
  const visibleReviewPaths = useMemo(
    () => applyReviewFileFilter(reviewPaths, fileFilter),
    [fileFilter, reviewPaths]
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
    scrollTopRef: multiFileScrollTopRef,
    visiblePathRef: visibleMultiFilePathRef
  } = useReviewNavigation({
    paths: visibleReviewPaths,
    workspaceView,
    initialScrollTop: initialReviewScrollTop,
    markInstantTreeFollowTarget,
    onSelectPath,
    onWorkspaceViewChange,
    onScrollPositionChange: onReviewScrollPositionChange
  })
  const getInitialMultiFileScrollTop = useCallback(
    () => multiFileScrollTopRef.current,
    [multiFileScrollTopRef]
  )
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
    onWorkspaceViewChange,
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
  useEffect(() => {
    if (selectedPath == null) return
    if (visibleReviewPaths.includes(selectedPath) || !reviewPaths.includes(selectedPath)) return
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
      onSubmitPullRequestReview
    )

  const { model, explorerPaths, activateTreeRow, handleVisibleMultiFilePathChange } =
    useRepositoryExplorer({
      snapshot,
      reviewWorldSource,
      treePaths,
      treeStatuses,
      selectedPath,
      workspaceView,
      reviewPathSet,
      hasFileSession: fileEditing.hasSession,
      collisionPathsRef,
      markInstantTreeFollowTarget,
      consumeInstantTreeFollowTarget,
      onSelectPath,
      onWorkspaceViewChange,
      advanceMultiFileNavigation,
      visibleMultiFilePathRef
    })

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
    reviewCheckpoint,
    checkpointChangedFileCount,
    checkpointRemovedFileCount,
    reviewReady,
    preferences,
    fileEdit: fileEditing.controls,
    submittingPullRequestReview,
    pullRequestReviewMessage,
    inlineCommentCount: reviewComments.length,
    orphanedCommentCount,
    reviewComposerExpanded,
    reviewComposerBody,
    onReviewComposerExpandedChange: setReviewComposerExpanded,
    onReviewComposerBodyChange: setReviewComposerBody,
    onClosePullRequestReview,
    onSetReviewCheckpoint,
    onOpenSinceReview,
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
        onBranchesOpen={onBranchesOpen} onRowActivate={activateTreeRow}
        fileFilter={fileFilter} onFileFilterChange={setFileFilter}
        unfilteredFileCount={treeSourcePaths.length} />
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
        reviewSessionRevision={reviewSessionRevision}
        reviewPaths={visibleReviewPaths}
        diffStyle={diffStyle}
        viewerPreferences={viewerPreferences}
        repositoryReview={repositoryReview}
        reviewLoadState={visibleReviewLoadState}
        reviewLoading={reviewLoad.loading}
        reviewTargetPathCount={reviewLoad.targetPathCount}
        onLoadMoreReviewFiles={reviewLoad.loadMoreFiles}
        sinceRemovedPaths={sinceRemovedPaths}
        sinceUncertainPaths={sinceUncertainPaths}
        pullRequestConversation={conversation.conversation}
        reviewScrollRevision={reviewScrollRevision}
        selectedPath={selectedPath}
        multiFileNavigationRevision={multiFileNavigationRevision}
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
        editMode={fileEditing.activeSession?.mode ?? 'read'}
        documentView={selectedPath != null && isMarkdownPath(selectedPath)
          ? fileEditing.controls.documentView
          : 'source'}
        onDraftFileChange={fileEditing.updateDraftFile}
        onEditorAttach={fileEditing.attachEditor}
        onEditorBlur={fileEditing.handleEditorBlur}
        showStatusBar={isFilePreview || fileEditing.activeSession != null}
        fileExtension={fileExtension}
        dirty={fileEditing.controls.dirty}
        getEditor={fileEditing.getEditor}
        onError={onError}
      />
    </>
  )
})

export default RepositoryWorkspace
