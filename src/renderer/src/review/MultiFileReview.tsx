import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import {
  type CodeView as CodeViewInstance,
  type CodeViewItem,
  type CodeViewLineSelection,
  type DiffLineAnnotation,
  type LineAnnotation
} from '@pierre/diffs'
import { type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react'
import { IconCheck, IconChevronSm, IconCodeSearch, IconEye, IconFileCode, IconRefresh, IconWarningOctogonFill } from '@pierre/icons'

import type { FileImagePreview, PullRequestConversation, RemoteReviewThread, RepositoryReview } from '../../../shared/contracts'
import { markdownPreviewSource } from './documentView'
import { GitHubMarkdownContent } from '../github/GitHubMarkdownContent'
import { ImageDiffPreview } from '../diff/ImageDiffPreview'
import type { DiffStyle } from '../app/AppView'
import { LIVE_CODE_FONT_SIZE_PROPERTY, LIVE_CODE_LINE_HEIGHT_PROPERTY } from '../diff/codeZoom'
import { markReviewFileHydrated } from './reviewMetrics'
import { markRendererStartup } from '../app/startupMetrics'
import { reportCopiedPath, syncCopyFilePathLifecycle } from '../diff/copyFilePath'
import { syncDragGuideLifecycle } from '../diff/dragSelection'
import { syncSplitDiffResizeLifecycle } from '../diff/splitDiffResize'
import { isGutterDoubleClick } from '../diff/gutterCommentShortcut'
import { syncReviewCaretLifecycle } from './reviewCaret'
import { CODE_FONTS, getEditorThemeType, INTERFACE_FONTS, type AppPreferences } from '../settings/preferences'
import {
  consumeSelectionChromeKey,
  DraftComment,
  nextPendingSelection,
  ReviewThreadCard,
  SelectionActions,
  type ReviewAnnotationMetadata,
  type ReviewThread
} from './ReviewComments'
import type { AgentSelection } from '../agent/agentAttachments'
import { ReviewSummary, type ReviewSummaryEntry } from './ReviewSummary'
import { RemoteReviewThreadCard } from '../github/RemoteReviewThreads'
import { ReviewClockProvider } from './reviewClock'
import {
  deriveAnnotatedReviewItems,
  type AnnotatedReviewItemCache
} from './annotatedReviewItems'
import {
  applyImagePreviews,
  applyMarkdownPreviews,
  canPreviewMarkdownItem,
  findCollapseFollowItemId,
  findActiveReviewItemId,
  findNextUnreadReviewItemId,
  pathFromReviewItemId as pathFromItemId,
  reviewItemId as itemId,
  type MarkdownHydratedSource
} from './reviewItems'
import type { ReviewLoadState } from './useReviewLoadState'
import {
  itemsForRetainedWorld,
  takeCachedAnnotatedDerivation,
  worldViewCache
} from './worldViewCache'
import {
  observeScrollTakeover,
  RetainedWorldCodeView,
  SCROLL_RESTORE_SETTLED_FRAMES,
  SCROLL_RESTORE_TIMEOUT_MS,
  useRetainedWorldViewers,
  type ReviewCodeViewSlots
} from './retainedWorldCodeView'
import {
  useReviewThreads,
  type DraftReviewComment,
  type ReattachingReviewThread,
  type UpdateReviewThread
} from './useReviewThreads'
import { BackToTopButton, BACK_TO_TOP_THRESHOLD } from '../diff/BackToTopButton'
import { showToast } from '../app/toast'
import type { ReviewCommand } from '../settings/keybindings'
import {
  dropChangedViewedFiles,
  markViewedFile,
  type ViewedFileSignatures
} from './viewedFileStorage'
import { MARKDOWN_REVIEW_PREVIEW_CSS, VIEWER_BASE_CSS } from '../diff/viewerCss'
import { buildViewedPathsKey, parseViewedPathsKey } from './viewedPaths'
import { PullRequestContext } from '../github/PullRequestContext'
import { createReviewCommentAnchor } from './reviewThreadAnchors'
import './MultiFileReview.css'

const CODE_VIEW_CSS = `
  ${VIEWER_BASE_CSS}
  ${MARKDOWN_REVIEW_PREVIEW_CSS}

  /* The ZWSP line exists so Pierre has a row to hang the preview annotation on. */
  :has(.image-diff-preview, .markdown-review-preview) [data-line]:not(:has(.image-diff-preview, .markdown-review-preview)) {
    display: none;
  }
`

const EMPTY_IMAGE_PREVIEWS: ReadonlyMap<string, FileImagePreview> = new Map()
const EMPTY_MARKDOWN_PATHS: ReadonlySet<string> = new Set()
const EMPTY_MARKDOWN_SOURCES: ReadonlyMap<string, MarkdownHydratedSource> = new Map()

function retainImagePreviews(
  current: ReadonlyMap<string, FileImagePreview>,
  paths: readonly string[]
): ReadonlyMap<string, FileImagePreview> {
  if (current.size === 0) return current
  const visible = new Set(paths)
  let changed = false
  const next = new Map<string, FileImagePreview>()
  for (const [path, image] of current) {
    if (!visible.has(path)) {
      changed = true
      continue
    }
    next.set(path, image)
  }
  return changed ? next : current
}

const ACTIVE_PATH_SETTLE_MS = 80

export function agentSelectionForReviewItem(
  item: CodeViewItem<unknown>,
  path: string,
  range: CodeViewLineSelection['range']
): AgentSelection | null {
  const startSide = range.side ?? range.endSide ?? 'additions'
  const endSide = range.endSide ?? startSide
  if (startSide !== endSide) return null
  const anchor = createReviewCommentAnchor(item, range)
  if (anchor == null || anchor.selectedText === '') return null
  return {
    path,
    startLine: Math.min(range.start, range.end),
    endLine: Math.max(range.start, range.end),
    side: anchor.side,
    selectedText: anchor.selectedText,
    blobOid: anchor.blobOid
  }
}

export interface MultiFileReviewProps {
  paths: readonly string[]
  diffStyle: DiffStyle
  preferences: AppPreferences
  repositoryReview?: RepositoryReview | null
  sinceRemovedPaths: readonly string[]
  sinceUncertainPaths: readonly string[]
  pullRequestConversation?: PullRequestConversation | null
  loadState: ReviewLoadState
  loading: boolean
  targetPathCount: number
  onLoadMore(): void
  scrollToReviewRevision: number
  navigationPath: string | null
  navigationRevision: number
  getInitialScrollTop(): number
  onScrollPositionChange(scrollTop: number): void
  onVisiblePathChange(path: string): void
  threadsByPath: Record<string, ReviewThread[]>
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>
  viewedFiles: ViewedFileSignatures
  setViewedFiles: Dispatch<SetStateAction<ViewedFileSignatures>>
  remoteThreadsByPath: ReadonlyMap<string, RemoteReviewThread[]>
  pendingRemoteThreadId: string | null
  onReplyToRemoteThread(threadId: string, body: string): void
  onResolveRemoteThread(threadId: string, resolved: boolean): void
  onAttachToAgent(selection: AgentSelection): void
  reviewCommand: { command: ReviewCommand; path: string; revision: number } | null
  worldId: string
}

function SinceNotice({
  removedPaths,
  uncertainPaths
}: {
  removedPaths: readonly string[]
  uncertainPaths: readonly string[]
}): React.JSX.Element | null {
  if (removedPaths.length === 0 && uncertainPaths.length === 0) return null
  return (
    <aside className="since-notice" aria-label="Since checkpoint details">
      <IconWarningOctogonFill />
      <div>
        {removedPaths.length > 0 ? (
          <details>
            <summary>{removedPaths.length} {removedPaths.length === 1 ? 'path is' : 'paths are'} no longer in the pull request</summary>
            <ul>{removedPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          </details>
        ) : null}
        {uncertainPaths.length > 0 ? (
          <details>
            <summary>{uncertainPaths.length} {uncertainPaths.length === 1 ? 'path uses' : 'paths use'} a conservative fallback signature</summary>
            <p>Kodi includes these paths because equal line counts cannot prove identical content.</p>
            <ul>{uncertainPaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul>
          </details>
        ) : null}
      </div>
    </aside>
  )
}

function ReviewEmptyOverlay({
  pathCount,
  itemCount,
  loading,
  failedCount,
  omittedCount,
  skippedCount,
  removedPaths,
  uncertainPaths
}: {
  pathCount: number
  itemCount: number
  loading: boolean
  failedCount: number
  omittedCount: number
  skippedCount: number
  removedPaths: readonly string[]
  uncertainPaths: readonly string[]
}): React.JSX.Element | null {
  if (pathCount === 0) {
    return (
      <div className="since-empty-state">
        <SinceNotice removedPaths={removedPaths} uncertainPaths={uncertainPaths} />
        <div className="diff-state">
          <IconCodeSearch />
          <strong>No current diffs to review</strong>
          <span>The changed paths are no longer part of this pull request.</span>
        </div>
      </div>
    )
  }
  if (itemCount === 0 && loading) {
    return (
      <div className="diff-state pending">
        <IconRefresh className="spin" />
        <span>Loading repository review…</span>
      </div>
    )
  }
  if (itemCount === 0) {
    return (
      <div className="diff-state">
        <IconWarningOctogonFill />
        <strong>No diffs to display</strong>
        <span>{
          failedCount > 0
            ? 'The changed files could not be loaded.'
            : omittedCount + skippedCount > 0
              ? 'Every changed file is too large or binary to open here.'
              : 'The review loaded, but its patch could not be parsed.'
        }</span>
      </div>
    )
  }
  return null
}

// Pagination without chrome: this sits at the end of the virtualized scroll
// content, and once it drifts inside the lookahead margin the next page is
// requested. Re-arming when `loading` clears or `onLoadMore` re-binds keeps
// pages coming while the margin still covers the end.
function ReviewLoadMoreSentinel({
  loading,
  onLoadMore
}: {
  loading: boolean
  onLoadMore(): void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = ref.current
    if (node == null || loading) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMore()
    }, { rootMargin: '640px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [loading, onLoadMore])
  return <div ref={ref} className="review-load-sentinel" aria-hidden="true" />
}

function ReviewFileCollapseButton({
  item,
  expanded,
  onToggle
}: {
  item: CodeViewItem<ReviewAnnotationMetadata>
  expanded: boolean
  onToggle(item: CodeViewItem<ReviewAnnotationMetadata>): void
}): React.JSX.Element {
  const path = pathFromItemId(item.id)
  return (
    <button type="button" data-review-collapse-button
      aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${path}`}
      title={`${expanded ? 'Collapse' : 'Expand'} file`} onClick={(event) => {
        event.stopPropagation()
        onToggle(item)
      }}>
      <IconChevronSm data-collapse-chevron aria-hidden="true" />
    </button>
  )
}

function ReviewMarkdownPreviewToggle({
  path,
  previewing,
  onToggle
}: {
  path: string
  previewing: boolean
  onToggle(path: string): void
}): React.JSX.Element {
  return (
    <button type="button" data-review-markdown-toggle data-state={previewing ? 'preview' : 'diff'}
      aria-pressed={previewing}
      aria-label={previewing ? `Show the diff for ${path}` : `Preview ${path} as rendered markdown`}
      title={previewing ? 'Show diff' : 'Preview markdown'}
      onClick={(event) => {
        event.stopPropagation()
        onToggle(path)
      }}>
      {previewing ? <IconFileCode /> : <IconEye />}
    </button>
  )
}

function MarkdownReviewPreview({
  source,
  partial
}: {
  source: string
  partial: boolean
}): React.JSX.Element {
  return (
    <div className="markdown-review-preview">
      {partial ? (
        <p className="markdown-review-partial">The diff only contains the changed sections of this file.</p>
      ) : null}
      <GitHubMarkdownContent source={source} className="markdown-review-body" hrefMode="local" />
    </div>
  )
}

function ReviewViewedToggle({
  path,
  viewed,
  onToggle
}: {
  path: string
  viewed: boolean
  onToggle(path: string): void
}): React.JSX.Element {
  return (
    <label data-review-viewed-toggle data-state={viewed ? 'checked' : 'unchecked'}
      title={viewed ? 'Mark as not viewed' : 'Mark as viewed'}
      onClick={(event) => event.stopPropagation()}>
      <input type="checkbox" checked={viewed} aria-label={`Mark ${path} as viewed`}
        onChange={() => onToggle(path)} />
      <span data-review-viewed-checkbox aria-hidden="true"><IconCheck /></span>
      <span>Viewed</span>
    </label>
  )
}

function scrollToReviewTop(viewer: CodeViewHandle<ReviewAnnotationMetadata> | null): void {
  viewer?.scrollTo({ type: 'position', position: 0, behavior: 'smooth-auto' })
}

interface ReviewScrollAnchor {
  itemId: string
  viewportOffset: number
}

export function reviewScrollAnchorTarget(anchor: ReviewScrollAnchor, itemTop: number): number {
  return Math.max(0, itemTop - anchor.viewportOffset)
}

/**
 * Where to land after a file swaps between its diff and its rendered markdown:
 * the top of that same file.
 *
 * Holding the old scroll offset is the wrong instinct here, and measurably so —
 * the rendered preview is roughly half the height of the two-column diff it
 * replaces, so the old offset points past the end of the file and the scroller
 * clamps, dumping the reader on the next file. Line 300 of a diff has no
 * counterpart in rendered prose anyway. The file you just clicked is the only
 * position that still means something.
 */
export function markdownPreviewScrollAnchor(
  itemId: string | null | undefined
): ReviewScrollAnchor | null {
  return itemId == null ? null : { itemId, viewportOffset: 0 }
}

function captureReviewScrollAnchor(
  viewer: CodeViewInstance<ReviewAnnotationMetadata> | undefined
): ReviewScrollAnchor | null {
  if (viewer == null) return null
  const itemId = findActiveRenderedItemId(viewer)
  if (itemId == null) return null
  const itemTop = viewer.getTopForItem(itemId)
  if (itemTop == null) return null
  return { itemId, viewportOffset: itemTop - viewer.getScrollTop() }
}

/**
 * Hold `anchor`'s item at its captured viewport offset while the rows around it
 * settle, and stop the moment the reader scrolls: heights arrive over several
 * frames, so one correction is not enough and fighting a real scroll is worse
 * than not correcting at all. Returns the cleanup for the frame loop.
 */
function restoreReviewScrollAnchor(
  anchor: ReviewScrollAnchor | null,
  viewerRef: RefObject<CodeViewHandle<ReviewAnnotationMetadata> | null>,
  scrollContainerRef: RefObject<HTMLDivElement | null>
): () => void {
  let frame = 0
  let settledFrames = 0
  let cancelled = false
  const startedAt = performance.now()
  const cancel = (): void => {
    cancelled = true
  }
  const stopObservingScrollTakeover = anchor == null
    ? () => {}
    : observeScrollTakeover(scrollContainerRef.current, cancel)

  const restore = (): void => {
    if (cancelled || anchor == null) return
    const viewer = viewerRef.current
    const instance = viewer?.getInstance()
    const itemTop = instance?.getTopForItem(anchor.itemId)
    const current = instance?.getScrollTop()
    if (viewer == null || itemTop == null || current == null) return
    const target = reviewScrollAnchorTarget(anchor, itemTop)
    if (Math.abs(current - target) <= 1) {
      settledFrames += 1
      if (settledFrames >= SCROLL_RESTORE_SETTLED_FRAMES) return
    } else {
      settledFrames = 0
      viewer.scrollTo({ type: 'position', position: target, behavior: 'instant' })
    }
    if (performance.now() - startedAt < SCROLL_RESTORE_TIMEOUT_MS) {
      frame = window.requestAnimationFrame(restore)
    }
  }
  restore()

  return () => {
    cancelled = true
    window.cancelAnimationFrame(frame)
    stopObservingScrollTakeover()
  }
}

function useBackgroundScrollAnchor(
  worldId: string | null | undefined,
  conversation: PullRequestConversation | null,
  review: RepositoryReview | null,
  scrollContainerRef: RefObject<HTMLDivElement | null>,
  viewerRef: RefObject<CodeViewHandle<ReviewAnnotationMetadata> | null>
): void {
  const anchorRef = useRef<ReviewScrollAnchor | null>(null)
  const anchoredWorldIdRef = useRef(worldId)

  // Conversation polling and streamed pages can update CodeView while the
  // reader is idle. Keep the same file at the same viewport offset.
  useLayoutEffect(() => {
    if (anchoredWorldIdRef.current !== worldId) {
      anchoredWorldIdRef.current = worldId
      anchorRef.current = null
      return
    }
    const anchor = anchorRef.current
    anchorRef.current = null
    const stop = restoreReviewScrollAnchor(anchor, viewerRef, scrollContainerRef)

    return () => {
      stop()
      // Cleanup must capture the latest imperative viewer, not the handle from effect setup.
      // oxlint-disable-next-line react/exhaustive-deps
      anchorRef.current = captureReviewScrollAnchor(viewerRef.current?.getInstance())
    }
  }, [conversation, review, scrollContainerRef, viewerRef, worldId])
}

function findActiveRenderedItemId(viewer: CodeViewInstance<ReviewAnnotationMetadata>): string | null {
  const positions = viewer.getRenderedItems().flatMap((item) => {
    const top = viewer.getTopForItem(item.id)
    return top == null ? [] : [{ id: item.id, top }]
  })
  return findActiveReviewItemId(viewer.getScrollTop(), positions)
}

interface AnnotatedReviewItemsOptions {
  loadState: ReviewLoadState
  imagePreviews: ReadonlyMap<string, FileImagePreview>
  markdownPreviewPaths: ReadonlySet<string>
  markdownSources: ReadonlyMap<string, MarkdownHydratedSource>
  threadsByPath: Record<string, ReviewThread[]>
  remoteThreadsByPath: ReadonlyMap<string, RemoteReviewThread[]>
  draftComment: DraftReviewComment | null
  pendingSelection: { id: string; range: CodeViewLineSelection['range'] } | null
  collapsedItemIds: ReadonlySet<string>
  annotationVersions: Readonly<Record<string, number>>
  worldId?: string | null
}

function useAnnotatedReviewItems({
  loadState,
  imagePreviews,
  markdownPreviewPaths,
  markdownSources,
  threadsByPath,
  remoteThreadsByPath,
  draftComment,
  pendingSelection,
  collapsedItemIds,
  annotationVersions,
  worldId = null
}: AnnotatedReviewItemsOptions): CodeViewItem<ReviewAnnotationMetadata>[] {
  const committedCacheRef = useRef<AnnotatedReviewItemCache>(new Map())
  const committedItemsRef = useRef<CodeViewItem<ReviewAnnotationMetadata>[] | undefined>(undefined)
  const annotatedWorldIdRef = useRef(worldId)
  const reviewItems = useMemo(
    () => applyMarkdownPreviews(
      applyImagePreviews(loadState.items, imagePreviews),
      markdownPreviewPaths,
      markdownSources
    ),
    [imagePreviews, loadState.items, markdownPreviewPaths, markdownSources]
  )
  const derivation = useMemo(() => {
    const seeded = worldId != null && annotatedWorldIdRef.current !== worldId
      ? worldViewCache.get(worldId)?.annotated
      : null
    const cached = takeCachedAnnotatedDerivation(seeded, reviewItems)
    if (cached != null) return cached
    return deriveAnnotatedReviewItems({
      items: reviewItems,
      threadsByPath,
      remoteThreadsByPath,
      draftComment,
      pendingSelection,
      collapsedItemIds,
      annotationVersions,
      previousCache: committedCacheRef.current,
      previousItems: committedItemsRef.current
    })
  }, [
    annotationVersions,
    collapsedItemIds,
    draftComment,
    pendingSelection,
    remoteThreadsByPath,
    reviewItems,
    threadsByPath,
    worldId
  ])

  useLayoutEffect(() => {
    annotatedWorldIdRef.current = worldId
    committedCacheRef.current = derivation.cache
    committedItemsRef.current = derivation.items
    if (worldId != null) {
      worldViewCache.rememberAnnotated(worldId, {
        baseItems: reviewItems,
        items: derivation.items,
        cache: derivation.cache
      })
    }
  }, [derivation.cache, derivation.items, reviewItems, worldId])

  return derivation.items
}

function useReviewCodeViewOptions({
  diffStyle,
  preferences,
  repositoryReview,
  previousGutterActivationRef,
  onSelectLines,
  onHideSelectionActions,
  onBeginComment,
  onImagePreview
}: {
  diffStyle: DiffStyle
  preferences: AppPreferences
  repositoryReview: RepositoryReview | null
  previousGutterActivationRef: RefObject<{
    selection: CodeViewLineSelection
    timestamp: number
  } | null>
  onSelectLines(selection: CodeViewLineSelection | null): void
  onHideSelectionActions(): void
  onBeginComment(selection: CodeViewLineSelection): void
  onImagePreview(path: string, image: FileImagePreview): void
}): CodeViewReactOptions<ReviewAnnotationMetadata> {
  return useMemo(() => ({
    // No `theme`: the worker pool resolves it and re-renders every instance on a
    // switch, so passing it here only forced a second full rebuild of the DOM.
    themeType: getEditorThemeType(preferences.editorTheme), diffStyle, diffIndicators: 'bars', lineDiffType: 'word-alt',
    overflow: preferences.wordWrap ? 'wrap' : 'scroll', disableLineNumbers: !preferences.showLineNumbers,
    tokenizeMaxLineLength: 2_000, enableLineSelection: true, enableGutterUtility: true,
    onLineSelectionStart: () => onHideSelectionActions(),
    onLineSelectionEnd: (range, context) => onSelectLines(range == null ? null : { id: context.item.id, range }),
    onGutterUtilityClick: (range, context) => {
      const selection = { id: context.item.id, range }
      const timestamp = performance.now()
      const opensComment = isGutterDoubleClick(previousGutterActivationRef.current, selection, timestamp)
      previousGutterActivationRef.current = opensComment ? null : { selection, timestamp }
      onSelectLines(selection)
      // CodeView reports selection-end after this callback. Starting the draft
      // on the next microtask lets that report finish before the action bar is cleared.
      if (opensComment) queueMicrotask(() => onBeginComment(selection))
    },
    onPostRender: (node, _instance, phase, context) => {
      syncDragGuideLifecycle(node, phase, (range) => onSelectLines({ id: context.item.id, range }))
      syncSplitDiffResizeLifecycle(node, phase)
      syncCopyFilePathLifecycle(node, phase, reportCopiedPath)
      syncReviewCaretLifecycle(node, phase)
    },
    lineHoverHighlight: 'number', hunkSeparators: 'line-info-basic', expandUnchanged: !preferences.foldUnchanged,
    collapsedContextThreshold: 4, stickyHeaders: true, layout: { paddingTop: 16, paddingBottom: 48, gap: 12 },
    itemMetrics: { lineHeight: preferences.codeLineHeight }, unsafeCSS: CODE_VIEW_CSS,
    ...(repositoryReview == null && window.repository != null ? { loadDiffFiles: async (fileDiff) => {
      const comparison = await window.repository!.getComparison(fileDiff.name)
      markReviewFileHydrated(fileDiff.name)
      if (comparison.image != null && (comparison.image.old != null || comparison.image.new != null)) {
        onImagePreview(fileDiff.name, comparison.image)
      }
      return { oldFile: comparison.oldFile, newFile: comparison.newFile } as Awaited<ReturnType<NonNullable<CodeViewReactOptions<ReviewAnnotationMetadata>['loadDiffFiles']>>>
    }} : {})
  }), [diffStyle, onBeginComment, onHideSelectionActions, onImagePreview, onSelectLines, preferences,
    previousGutterActivationRef, repositoryReview])
}

interface MultiFileViewerProps {
  worldId?: string | null
  paths: readonly string[]
  diffStyle: DiffStyle
  preferences: AppPreferences
  repositoryReview: RepositoryReview | null
  sinceRemovedPaths: readonly string[]
  sinceUncertainPaths: readonly string[]
  pullRequestConversation: PullRequestConversation | null
  loadState: ReviewLoadState
  loading: boolean
  targetPathCount: number
  onLoadMore(): void
  selectedLines: CodeViewLineSelection | null
  annotatedItems: CodeViewItem<ReviewAnnotationMetadata>[]
  threadsByPath: Record<string, ReviewThread[]>
  collapsedItemIds: ReadonlySet<string>
  viewedPaths: ReadonlySet<string>
  previewableMarkdownPaths: ReadonlySet<string>
  markdownPreviewPaths: ReadonlySet<string>
  onToggleMarkdownPreview(path: string): void
  onToggleViewed(path: string): void
  remoteThreadsByPath: ReadonlyMap<string, RemoteReviewThread[]>
  pendingRemoteThreadId: string | null
  onReplyToRemoteThread(threadId: string, body: string): void
  onResolveRemoteThread(threadId: string, resolved: boolean): void
  pendingSelection: { id: string; range: CodeViewLineSelection['range'] } | null
  onSelectLines(selection: CodeViewLineSelection | null): void
  onHighlightLines(selection: CodeViewLineSelection | null): void
  onHideSelectionActions(): void
  onCommentOnSelection(): void
  onBeginComment(selection: CodeViewLineSelection): void
  onAskAgentAboutSelection(): void
  onImagePreview(path: string, image: FileImagePreview): void
  scrollContainerRef: RefObject<HTMLDivElement | null>
  viewerRef: React.RefObject<CodeViewHandle<ReviewAnnotationMetadata> | null>
  onScrollPositionChange(scrollTop: number): void
  onVisiblePathChange(path: string): void
  setViewerRef(viewer: CodeViewHandle<ReviewAnnotationMetadata> | null): void
  getInitialScrollTop(): number
  toggleItemCollapsed(item: CodeViewItem<ReviewAnnotationMetadata>): void
  cancelComment(): void
  saveComment(body: string): void
  updateThread: UpdateReviewThread
  reattachingThread: ReattachingReviewThread | null
  onBeginReattach(path: string, threadId: string): void
  onCancelReattach(): void
  onDropAll(): void
}

const MultiFileViewer = memo(function MultiFileViewer({
  worldId = null,
  paths,
  diffStyle,
  preferences,
  repositoryReview,
  sinceRemovedPaths,
  sinceUncertainPaths,
  pullRequestConversation,
  loadState,
  loading,
  targetPathCount,
  onLoadMore,
  selectedLines,
  annotatedItems,
  threadsByPath,
  collapsedItemIds,
  viewedPaths,
  previewableMarkdownPaths,
  markdownPreviewPaths,
  onToggleMarkdownPreview,
  onToggleViewed,
  pendingRemoteThreadId,
  onReplyToRemoteThread,
  onResolveRemoteThread,
  onSelectLines,
  onHighlightLines,
  onHideSelectionActions,
  onCommentOnSelection,
  onBeginComment,
  onAskAgentAboutSelection,
  onImagePreview,
  scrollContainerRef,
  viewerRef,
  onScrollPositionChange,
  onVisiblePathChange,
  setViewerRef,
  getInitialScrollTop,
  toggleItemCollapsed,
  cancelComment,
  saveComment,
  updateThread,
  reattachingThread,
  onBeginReattach,
  onCancelReattach,
  onDropAll
}: MultiFileViewerProps): React.JSX.Element {
  const [showBackToTop, setShowBackToTop] = useState(false)
  const backToTopVisibleRef = useRef(false)
  const visiblePathRef = useRef<string | null>(null)
  const visiblePathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const collapseFollowFrameRef = useRef(0)
  const previousGutterActivationRef = useRef<{
    selection: CodeViewLineSelection
    timestamp: number
  } | null>(null)
  const deferredConversation = useDeferredValue(pullRequestConversation)
  useBackgroundScrollAnchor(
    worldId,
    deferredConversation,
    repositoryReview,
    scrollContainerRef,
    viewerRef
  )

  useEffect(() => () => {
    if (visiblePathTimerRef.current != null) clearTimeout(visiblePathTimerRef.current)
    window.cancelAnimationFrame(collapseFollowFrameRef.current)
  }, [])
  const summaryEntries = useMemo<ReviewSummaryEntry[]>(() =>
    Object.entries(threadsByPath).flatMap(([path, threads]) =>
      threads.map((thread) => ({ path, thread }))
    ), [threadsByPath])
  const beginSummaryReattach = useCallback((entry: ReviewSummaryEntry) => {
    onBeginReattach(entry.path, entry.thread.id)
    const id = itemId(entry.path)
    if (viewerRef.current?.getItem(id) != null) {
      viewerRef.current.scrollTo({ type: 'item', id, align: 'start', behavior: 'smooth-auto' })
    }
    showToast('Select replacement lines, then choose Reattach')
  }, [onBeginReattach, viewerRef])
  const dropSummaryThread = useCallback((entry: ReviewSummaryEntry) => {
    updateThread(entry.path, entry.thread.id, () => null)
    if (reattachingThread?.threadId === entry.thread.id) onCancelReattach()
  }, [onCancelReattach, reattachingThread, updateThread])
  const renderReviewSummary = useCallback(
    () => <>
      <SinceNotice removedPaths={sinceRemovedPaths} uncertainPaths={sinceUncertainPaths} />
      <PullRequestContext conversation={deferredConversation} />
      <ReviewSummary entries={summaryEntries}
        reattachingThreadId={reattachingThread?.threadId ?? null}
        onBeginReattach={beginSummaryReattach} onCancelReattach={onCancelReattach}
        onDrop={dropSummaryThread} onDropAll={onDropAll} />
    </>,
    [beginSummaryReattach, deferredConversation, dropSummaryThread, onCancelReattach,
      onDropAll, reattachingThread, sinceRemovedPaths, sinceUncertainPaths, summaryEntries]
  )
  const handleToggleItemCollapsed = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    window.cancelAnimationFrame(collapseFollowFrameRef.current)
    collapseFollowFrameRef.current = 0

    const viewer = viewerRef.current?.getInstance()
    const followItemId = collapsedItemIds.has(item.id) || viewer == null
      ? null
      : findCollapseFollowItemId(findActiveRenderedItemId(viewer), item.id, annotatedItems)

    toggleItemCollapsed(item)
    if (followItemId == null) return

    collapseFollowFrameRef.current = window.requestAnimationFrame(() => {
      collapseFollowFrameRef.current = 0
      viewerRef.current?.scrollTo({
        type: 'item',
        id: followItemId,
        align: 'start',
        behavior: 'instant'
      })
    })
  }, [annotatedItems, collapsedItemIds, toggleItemCollapsed, viewerRef])
  const renderHeaderPrefix = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => (
    <ReviewFileCollapseButton
      item={item}
      expanded={!collapsedItemIds.has(item.id)}
      onToggle={handleToggleItemCollapsed}
    />
  ), [collapsedItemIds, handleToggleItemCollapsed])
  // Viewed belongs in the header's metadata slot on the trailing edge. Rendered
  // in the prefix slot it shared a narrow box with the collapse button and
  // wrapped onto a second line under the chevron.
  const renderHeaderMetadata = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    const path = pathFromItemId(item.id)
    return (
      <>
        {previewableMarkdownPaths.has(path) ? (
          <ReviewMarkdownPreviewToggle
            path={path}
            previewing={markdownPreviewPaths.has(path)}
            onToggle={onToggleMarkdownPreview}
          />
        ) : null}
        <ReviewViewedToggle path={path} viewed={viewedPaths.has(path)} onToggle={onToggleViewed} />
      </>
    )
  }, [markdownPreviewPaths, onToggleMarkdownPreview, onToggleViewed, previewableMarkdownPaths, viewedPaths])
  const renderReviewAnnotation = useCallback((
    annotation: LineAnnotation<ReviewAnnotationMetadata> | DiffLineAnnotation<ReviewAnnotationMetadata>,
    item: CodeViewItem<ReviewAnnotationMetadata>
  ): React.JSX.Element => {
    const path = pathFromItemId(item.id)
    const metadata = annotation.metadata
    if (metadata.kind === 'image') return <ImageDiffPreview image={metadata.image} />
    if (metadata.kind === 'markdown') {
      return <MarkdownReviewPreview source={metadata.source} partial={metadata.partial} />
    }
    if (metadata.kind === 'selection') {
      return <SelectionActions range={metadata.range}
        commentLabel={reattachingThread == null ? 'Comment' : 'Reattach'}
        onComment={onCommentOnSelection} onAskAgent={onAskAgentAboutSelection} />
    }
    if (metadata.kind === 'draft') return <DraftComment range={metadata.range} onCancel={cancelComment} onSave={saveComment} />
    if (metadata.kind === 'remote') {
      return <RemoteReviewThreadCard thread={metadata.thread}
        pending={pendingRemoteThreadId === metadata.thread.id}
        onReply={onReplyToRemoteThread} onToggleResolved={onResolveRemoteThread} />
    }
    const { thread } = metadata
    return <ReviewThreadCard thread={thread}
      onDelete={() => updateThread(path, thread.id, () => null)}
      onEdit={(body) => updateThread(path, thread.id, (current) => ({ ...current, body }))}
      onReply={(body) => updateThread(path, thread.id, (current) => ({ ...current, replies: [...current.replies, { id: crypto.randomUUID(), body }] }))}
      onToggleResolved={() => updateThread(path, thread.id, (current) => ({ ...current, resolved: !current.resolved }))} />
  }, [cancelComment, onAskAgentAboutSelection, onCommentOnSelection, onReplyToRemoteThread,
    onResolveRemoteThread, pendingRemoteThreadId, reattachingThread,
    saveComment, updateThread])
  const remainingPathCount = paths.length - targetPathCount
  const codeViewSlots = useMemo<ReviewCodeViewSlots>(() => ({
    header: renderReviewSummary,
    headerPrefix: renderHeaderPrefix,
    headerMetadata: renderHeaderMetadata,
    annotation: renderReviewAnnotation,
    footer: remainingPathCount > 0
      ? () => <ReviewLoadMoreSentinel loading={loading} onLoadMore={onLoadMore} />
      : undefined
  }), [loading, onLoadMore, remainingPathCount, renderHeaderMetadata, renderHeaderPrefix,
    renderReviewAnnotation, renderReviewSummary])
  const codeStyle = useMemo(() => ({
    '--diffs-font-family': CODE_FONTS[preferences.codeFont].fontFamily,
    '--diffs-header-font-family': INTERFACE_FONTS[preferences.interfaceFont].fontFamily,
    '--diffs-font-size': `var(${LIVE_CODE_FONT_SIZE_PROPERTY}, ${preferences.codeFontSize}px)`,
    '--diffs-line-height': `var(${LIVE_CODE_LINE_HEIGHT_PROPERTY}, ${preferences.codeLineHeight}px)`,
    '--diffs-font-features': '"calt" 1, "liga" 1'
  }) as CSSProperties, [preferences])
  const codeViewOptions = useReviewCodeViewOptions({
    diffStyle,
    preferences,
    repositoryReview,
    previousGutterActivationRef,
    onSelectLines,
    onHideSelectionActions,
    onBeginComment,
    onImagePreview
  })
  const handleScroll = useCallback((scrollTop: number) => {
    onScrollPositionChange(scrollTop)
    const backToTopVisible = scrollTop > BACK_TO_TOP_THRESHOLD
    if (backToTopVisible !== backToTopVisibleRef.current) {
      backToTopVisibleRef.current = backToTopVisible
      setShowBackToTop(backToTopVisible)
    }
    // The rendered-item snapshot allocates an array plus an object per item in the
    // render window, and the viewer calls this once per frame. Restarting this
    // timer makes it a trailing debounce: a fast fling produces one tree update
    // after it settles instead of making the sidebar selection jump every 80 ms.
    if (visiblePathTimerRef.current != null) clearTimeout(visiblePathTimerRef.current)
    visiblePathTimerRef.current = setTimeout(() => {
      visiblePathTimerRef.current = null
      const instance = viewerRef.current?.getInstance()
      if (instance == null) return
      const activeId = findActiveRenderedItemId(instance)
      const activePath = activeId == null ? null : pathFromItemId(activeId)
      if (activePath == null || activePath === visiblePathRef.current) return
      visiblePathRef.current = activePath
      onVisiblePathChange(activePath)
    }, ACTIVE_PATH_SETTLE_MS)
  }, [onScrollPositionChange, onVisiblePathChange, viewerRef])

  const retainedWorldIds = useRetainedWorldViewers(worldId)
  const viewerSlots = retainedWorldIds.flatMap((id) => {
    const items = itemsForRetainedWorld(
      id,
      worldId,
      annotatedItems,
      worldViewCache.get(id)?.annotated?.items
    )
    return items == null ? [] : [{ id, items }]
  })
  worldViewCache.retainMountedViewers(viewerSlots.map((slot) => slot.id))

  const activeHasItems = paths.length > 0 && loadState.items.length > 0
  const emptyOverlay = (
    <ReviewEmptyOverlay
      pathCount={paths.length}
      itemCount={loadState.items.length}
      loading={loading}
      failedCount={loadState.failedCount}
      omittedCount={loadState.omittedFiles.length}
      skippedCount={loadState.skippedCount}
      removedPaths={sinceRemovedPaths}
      uncertainPaths={sinceUncertainPaths}
    />
  )
  if (emptyOverlay != null && viewerSlots.length === 0) return emptyOverlay

  return <div className="multi-file-review">
    {emptyOverlay}
    <div className="multi-file-code-view-host">
      {viewerSlots.map((slot) => (
        <RetainedWorldCodeView
          key={slot.id}
          worldId={slot.id}
          active={slot.id === worldId && activeHasItems}
          items={slot.items}
          selectedLines={selectedLines}
          codeViewOptions={codeViewOptions}
          codeStyle={codeStyle}
          slots={codeViewSlots}
          onHighlightLines={onHighlightLines}
          onScroll={handleScroll}
          scrollContainerRef={scrollContainerRef}
          setViewerRef={setViewerRef}
          getInitialScrollTop={getInitialScrollTop}
          loading={loading}
        />
      ))}
    </div>
    <BackToTopButton visible={showBackToTop} onClick={() => scrollToReviewTop(viewerRef.current)} />
  </div>
})

interface ReviewSelectionOptions {
  items: readonly CodeViewItem<ReviewAnnotationMetadata>[]
  reattachingThread: ReattachingReviewThread | null
  beginComment(selection: CodeViewLineSelection): void
  beginReattach(path: string, threadId: string): void
  cancelReattach(): void
  handleSelectedLinesChange(selection: CodeViewLineSelection | null): void
  reattachToSelection(selection: CodeViewLineSelection): boolean
  onAttachToAgent(selection: AgentSelection): void
}

function useReviewSelectionActions({
  items,
  worldId,
  reattachingThread,
  beginComment,
  beginReattach,
  cancelReattach,
  handleSelectedLinesChange,
  reattachToSelection,
  onAttachToAgent
}: ReviewSelectionOptions & { worldId: string }) {
  // A finished selection offers actions first; commenting is one possible
  // outcome rather than the selection's automatic next state.
  const [pendingSelection, setPendingSelection] = useState<{
    id: string
    range: CodeViewLineSelection['range']
  } | null>(null)
  const [selectionWorldId, setSelectionWorldId] = useState(worldId)
  if (selectionWorldId !== worldId) {
    setSelectionWorldId(worldId)
    setPendingSelection(null)
  }
  const handleSelectLines = useCallback((selection: CodeViewLineSelection | null) => {
    setPendingSelection((pending) => nextPendingSelection('end', selection, pending))
    handleSelectedLinesChange(selection)
  }, [handleSelectedLinesChange])
  const hideSelectionActions = useCallback(() => {
    setPendingSelection((pending) => nextPendingSelection('start', null, pending))
  }, [])
  const beginCommentAtSelection = useCallback((selection: CodeViewLineSelection) => {
    if (reattachingThread != null) {
      if (reattachToSelection(selection)) {
        setPendingSelection(null)
        showToast('Comment reattached')
      } else {
        showToast('Those lines cannot anchor this comment')
      }
      return
    }
    beginComment(selection)
    setPendingSelection(null)
  }, [beginComment, reattachToSelection, reattachingThread])
  const commentOnSelection = useCallback(() => {
    if (pendingSelection != null) beginCommentAtSelection(pendingSelection)
  }, [beginCommentAtSelection, pendingSelection])
  const startReattach = useCallback((path: string, threadId: string) => {
    setPendingSelection(null)
    beginReattach(path, threadId)
  }, [beginReattach])
  const stopReattach = useCallback(() => {
    setPendingSelection(null)
    cancelReattach()
  }, [cancelReattach])
  const askAgentAboutSelection = useCallback(() => {
    if (pendingSelection == null) return
    const item = items.find((candidate) => candidate.id === pendingSelection.id)
    const path = pathFromItemId(pendingSelection.id)
    const selection = item == null
      ? null
      : agentSelectionForReviewItem(item, path, pendingSelection.range)
    if (selection == null) {
      showToast('Select lines from one side of the diff')
      return
    }
    onAttachToAgent(selection)
    handleSelectLines(null)
  }, [handleSelectLines, items, onAttachToAgent, pendingSelection])

  // ⌘I and Escape use the same current selection as the visible action bar.
  const askAgentRef = useRef(askAgentAboutSelection)
  const dismissSelectionRef = useRef(() => handleSelectLines(null))
  useEffect(() => {
    askAgentRef.current = askAgentAboutSelection
  }, [askAgentAboutSelection])
  useEffect(() => {
    dismissSelectionRef.current = () => handleSelectLines(null)
  }, [handleSelectLines])
  const hasPendingSelection = pendingSelection != null
  useEffect(() => {
    if (!hasPendingSelection) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      consumeSelectionChromeKey(event, {
        onDismiss: () => dismissSelectionRef.current(),
        onAskAgent: () => askAgentRef.current()
      })
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [hasPendingSelection])

  return {
    pendingSelection,
    handleSelectLines,
    hideSelectionActions,
    beginCommentAtSelection,
    commentOnSelection,
    startReattach,
    stopReattach,
    askAgentAboutSelection
  }
}

const MultiFileReview = memo(function MultiFileReview({
  paths,
  diffStyle,
  preferences,
  repositoryReview = null,
  sinceRemovedPaths,
  sinceUncertainPaths,
  pullRequestConversation = null,
  loadState,
  loading,
  targetPathCount,
  onLoadMore,
  scrollToReviewRevision,
  navigationPath,
  navigationRevision,
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
  worldId
}: MultiFileReviewProps): React.JSX.Element {
  useLayoutEffect(() => markRendererStartup('viewerCommitted'), [])
  const [imagePreviews, setImagePreviews] = useState(EMPTY_IMAGE_PREVIEWS)
  const [markdownPreviewPaths, setMarkdownPreviewPaths] = useState<ReadonlySet<string>>(EMPTY_MARKDOWN_PATHS)
  const [markdownSources, setMarkdownSources] = useState<ReadonlyMap<string, MarkdownHydratedSource>>(EMPTY_MARKDOWN_SOURCES)
  const viewerRef = useRef<CodeViewHandle<ReviewAnnotationMetadata> | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const viewedAdvanceFrameRef = useRef(0)
  const markdownPreviewPinRef = useRef<ReviewScrollAnchor | null>(null)
  const handledNavigationRevisionRef = useRef(navigationRevision)
  const stablePaths = paths
  const {
    selectedLines,
    draftComment,
    annotationVersions,
    collapsedItemIds,
    toggleItemCollapsed,
    toggleCollapsedById,
    setCollapsedById,
    beginComment,
    handleSelectedLinesChange,
    saveComment,
    cancelComment,
    reattachingThread,
    beginReattach,
    cancelReattach,
    reattachToSelection,
    updateThread,
    bumpPathVersions
  } = useReviewThreads({
    items: loadState.items,
    threadsByPath,
    setThreadsByPath,
    worldId
  })
  const {
    pendingSelection,
    handleSelectLines,
    hideSelectionActions,
    beginCommentAtSelection,
    commentOnSelection,
    startReattach,
    stopReattach,
    askAgentAboutSelection
  } = useReviewSelectionActions({
    items: loadState.items,
    worldId,
    reattachingThread,
    beginComment,
    beginReattach,
    cancelReattach,
    handleSelectedLinesChange,
    reattachToSelection,
    onAttachToAgent
  })
  const setViewerRef = useCallback((viewer: CodeViewHandle<ReviewAnnotationMetadata> | null) => {
    viewerRef.current = viewer
  }, [])
  const handleImagePreview = useCallback((path: string, image: FileImagePreview) => {
    setImagePreviews((current) => {
      const existing = current.get(path)
      if (existing != null && existing.old === image.old && existing.new === image.new) return current
      const next = new Map(current)
      next.set(path, image)
      return next
    })
  }, [])
  const visibleImagePreviews = retainImagePreviews(imagePreviews, paths)
  if (visibleImagePreviews !== imagePreviews) setImagePreviews(visibleImagePreviews)

  useEffect(() => {
    if (navigationRevision === handledNavigationRevisionRef.current || navigationPath == null) return
    const viewer = viewerRef.current
    const id = itemId(navigationPath)
    const item = viewer?.getItem(id)
    if (item == null) {
      // A file that belongs to the review but has not loaded yet will navigate on
      // a later pass, so leave the request pending. A file outside the comparison
      // never will — say so, because a ⌘P result that does nothing reads as broken.
      if (paths.includes(navigationPath)) return
      handledNavigationRevisionRef.current = navigationRevision
      showToast(`${navigationPath.split('/').at(-1) ?? navigationPath} has no changes in this review`)
      return
    }
    handledNavigationRevisionRef.current = navigationRevision
    viewer?.scrollTo({
      type: 'item',
      id,
      align: 'start',
      behavior: 'smooth-auto'
    })
  }, [loadState.loadedPaths, navigationPath, navigationRevision, paths])

  useEffect(() => {
    if (scrollToReviewRevision === 0) return
    scrollToReviewTop(viewerRef.current)
  }, [scrollToReviewRevision])

  const itemsByPath = useMemo(() => {
    const byPath = new Map<string, CodeViewItem<ReviewAnnotationMetadata>>()
    for (const item of loadState.items) byPath.set(pathFromItemId(item.id), item)
    return byPath
  }, [loadState.items])

  const previewableMarkdownPaths = useMemo(() => {
    const next = new Set<string>()
    for (const item of loadState.items) {
      if (canPreviewMarkdownItem(item)) next.add(pathFromItemId(item.id))
    }
    return next
  }, [loadState.items])

  const toggleMarkdownPreview = useCallback((path: string) => {
    if (!previewableMarkdownPaths.has(path)) {
      // Only reachable from the keyboard — the header button only renders on
      // previewable files.
      showToast('Only markdown files can be previewed')
      return
    }
    markdownPreviewPinRef.current = markdownPreviewScrollAnchor(itemsByPath.get(path)?.id)
    const enabling = !markdownPreviewPaths.has(path)
    setMarkdownPreviewPaths((current) => {
      const next = new Set(current)
      if (enabling) next.add(path)
      else next.delete(path)
      return next
    })
    if (!enabling || markdownSources.has(path)) return
    // A patch-parsed modification only carries its changed lines. When the
    // review is the working tree, the complete file is one comparison away; a
    // pull request review has no local tree to ask, so its partial lines stand.
    const item = itemsByPath.get(path)
    if (item?.type !== 'diff' || !item.fileDiff.isPartial) return
    if (item.fileDiff.type === 'new' || item.fileDiff.type === 'deleted') return
    if (repositoryReview != null || window.repository == null) return
    const cacheKey = item.fileDiff.cacheKey
    void window.repository.getComparison(path).then((comparison) => {
      const source = markdownPreviewSource(comparison)
      if (source == null) return
      setMarkdownSources((current) => {
        const next = new Map(current)
        next.set(path, { cacheKey, source })
        return next
      })
    }).catch(() => {})
  }, [itemsByPath, markdownPreviewPaths, markdownSources, previewableMarkdownPaths, repositoryReview])

  // Land on the toggled file. Deliberately not `restoreReviewScrollAnchor`: that
  // one aborts on `pointerdown`, which is the very click that starts this, and
  // it gives up for good if the viewer has not published an instance on the
  // first tick. Both are right for a background refresh the reader did not ask
  // for, and both are wrong for a scroll the reader just requested.
  useLayoutEffect(() => {
    const pin = markdownPreviewPinRef.current
    markdownPreviewPinRef.current = null
    if (pin == null) return
    let frame = 0
    let settledFrames = 0
    const startedAt = performance.now()
    const step = (): void => {
      const viewer = viewerRef.current
      const instance = viewer?.getInstance()
      const itemTop = instance?.getTopForItem(pin.itemId)
      const current = instance?.getScrollTop()
      // A null here means the viewer has not settled yet, so wait for it rather
      // than treating it as nothing to do.
      if (viewer != null && itemTop != null && current != null) {
        const target = reviewScrollAnchorTarget(pin, itemTop)
        if (Math.abs(current - target) <= 1) {
          settledFrames += 1
          if (settledFrames >= SCROLL_RESTORE_SETTLED_FRAMES) return
        } else {
          settledFrames = 0
          viewer.scrollTo({ type: 'position', position: target, behavior: 'instant' })
        }
      }
      if (performance.now() - startedAt < SCROLL_RESTORE_TIMEOUT_MS) {
        frame = window.requestAnimationFrame(step)
      }
    }
    step()
    return () => window.cancelAnimationFrame(frame)
  }, [markdownPreviewPaths, markdownSources])

  // Stale entries are filtered out rather than deleted, so a file whose contents
  // changed reads as unviewed without writing to state during render.
  const viewedPathsKey = useMemo(
    () => buildViewedPathsKey(itemsByPath, viewedFiles),
    [itemsByPath, viewedFiles]
  )
  // Rebuilding the Set per load page changed `renderHeaderMetadata`'s identity, and
  // CodeView memoizes its header portals on exactly that. Keying on the contents
  // means the headers re-render when the viewed set moves and not before.
  const viewedPaths = useMemo(() => parseViewedPathsKey(viewedPathsKey), [viewedPathsKey])

  const toggleViewed = useCallback((path: string) => {
    window.cancelAnimationFrame(viewedAdvanceFrameRef.current)
    viewedAdvanceFrameRef.current = 0

    const item = itemsByPath.get(path)
    if (item == null) return
    const viewed = viewedPaths.has(path)
    const viewer = viewerRef.current?.getInstance()
    const followItemId = viewed || viewer == null
      ? null
      : findNextUnreadReviewItemId(
          findActiveRenderedItemId(viewer),
          item.id,
          loadState.items,
          viewedPaths
        )

    setViewedFiles((current) => viewed
      ? dropChangedViewedFiles(current, [path])
      : markViewedFile(current, item))
    setCollapsedById(itemId(path), !viewed)
    if (followItemId == null) return

    viewedAdvanceFrameRef.current = window.requestAnimationFrame(() => {
      viewedAdvanceFrameRef.current = 0
      viewerRef.current?.scrollTo({
        type: 'item',
        id: followItemId,
        align: 'start',
        behavior: 'instant'
      })
    })
  }, [itemsByPath, loadState.items, setCollapsedById, setViewedFiles, viewedPaths])

  useEffect(() => () => {
    window.cancelAnimationFrame(viewedAdvanceFrameRef.current)
  }, [])

  const handledReviewCommandRef = useRef(reviewCommand?.revision ?? 0)
  useEffect(() => {
    if (reviewCommand == null || reviewCommand.revision === handledReviewCommandRef.current) return
    handledReviewCommandRef.current = reviewCommand.revision
    if (reviewCommand.command === 'toggleReviewViewed') toggleViewed(reviewCommand.path)
    else if (reviewCommand.command === 'toggleReviewCollapsed') toggleCollapsedById(itemId(reviewCommand.path))
    else if (reviewCommand.command === 'toggleReviewMarkdownPreview') toggleMarkdownPreview(reviewCommand.path)
  }, [reviewCommand, toggleCollapsedById, toggleMarkdownPreview, toggleViewed])

  const dropAllReviewThreads = useCallback(() => {
    const annotatedPaths = Object.keys(threadsByPath)
    if (annotatedPaths.length === 0) return
    setThreadsByPath({})
    bumpPathVersions(annotatedPaths)
    stopReattach()
  }, [bumpPathVersions, setThreadsByPath, stopReattach, threadsByPath])

  const annotatedItems = useAnnotatedReviewItems({
    loadState,
    imagePreviews: visibleImagePreviews,
    markdownPreviewPaths,
    markdownSources,
    threadsByPath,
    remoteThreadsByPath,
    draftComment,
    pendingSelection,
    collapsedItemIds,
    annotationVersions,
    worldId
  })

  return <ReviewClockProvider>
    <MultiFileViewer
      worldId={worldId}
      paths={stablePaths} diffStyle={diffStyle} preferences={preferences}
      repositoryReview={repositoryReview} pullRequestConversation={pullRequestConversation}
      sinceRemovedPaths={sinceRemovedPaths} sinceUncertainPaths={sinceUncertainPaths}
      loadState={loadState} loading={loading}
      targetPathCount={targetPathCount} onLoadMore={onLoadMore}
      selectedLines={selectedLines} annotatedItems={annotatedItems} threadsByPath={threadsByPath}
      collapsedItemIds={collapsedItemIds} viewedPaths={viewedPaths}
      onToggleViewed={toggleViewed} scrollContainerRef={scrollContainerRef}
      previewableMarkdownPaths={previewableMarkdownPaths} markdownPreviewPaths={markdownPreviewPaths}
      onToggleMarkdownPreview={toggleMarkdownPreview}
      viewerRef={viewerRef}
      remoteThreadsByPath={remoteThreadsByPath} pendingRemoteThreadId={pendingRemoteThreadId}
      onReplyToRemoteThread={onReplyToRemoteThread} onResolveRemoteThread={onResolveRemoteThread}
      pendingSelection={pendingSelection} onSelectLines={handleSelectLines}
      onHighlightLines={handleSelectedLinesChange} onHideSelectionActions={hideSelectionActions}
      onCommentOnSelection={commentOnSelection} onBeginComment={beginCommentAtSelection}
      onAskAgentAboutSelection={askAgentAboutSelection}
      onImagePreview={handleImagePreview}
      onScrollPositionChange={onScrollPositionChange} onVisiblePathChange={onVisiblePathChange} setViewerRef={setViewerRef}
      getInitialScrollTop={getInitialScrollTop}
      toggleItemCollapsed={toggleItemCollapsed} cancelComment={cancelComment} saveComment={saveComment}
      updateThread={updateThread} reattachingThread={reattachingThread}
      onBeginReattach={startReattach} onCancelReattach={stopReattach}
      onDropAll={dropAllReviewThreads}
    />
  </ReviewClockProvider>
})

export default MultiFileReview
