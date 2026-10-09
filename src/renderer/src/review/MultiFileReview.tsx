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
  type LineAnnotation,
  type SelectedLineRange
} from '@pierre/diffs'
import { type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react'
import { IconArrowUpRight, IconCheck, IconChevronSm, IconClockArrow, IconCodeSearch, IconEye, IconFileCode, IconRefresh, IconWarningOctogonFill } from '@pierre/icons'

import type { FileImagePreview, PullRequestConversation, RemoteReviewThread, RepositoryReview } from '../../../shared/contracts'
import { markdownPreviewSource } from './documentView'
import { GitHubMarkdownContent } from '../github/GitHubMarkdownContent'
import { ImageDiffPreview } from '../diff/ImageDiffPreview'
import type { DiffStyle } from '../app/AppView'
import { LIVE_CODE_FONT_SIZE_PROPERTY, LIVE_CODE_LINE_HEIGHT_PROPERTY } from '../diff/codeZoom'
import { noteReviewItemRender, schedulePartialDiffHydration } from './partialDiffHydration'
import { useReviewDiffLoader } from './useReviewDiffLoader'
import { noteFirstScreenRender } from '../app/firstScreen'
import { markRendererStartup } from '../app/startupMetrics'
import { reportCopiedPath, syncCopyFilePathLifecycle } from '../diff/copyFilePath'
import { syncDragGuideLifecycle } from '../diff/dragSelection'
import { syncSplitDiffResizeLifecycle } from '../diff/splitDiffResize'
import { isGutterDoubleClick, selectionCoversGutterLine } from '../diff/gutterCommentShortcut'
import { syncReviewCaretLifecycle } from './reviewCaret'
import { applyReviewEdits, preloadReviewEditing, useReviewEditing, type ReviewEditing } from './useReviewEditing'
import type { WorkingDrafts } from '../diff/useFileEditing'
import { useViewerContext } from '../editor/ViewerProviders'
import { CODE_FONTS, getEditorThemeType, INTERFACE_FONTS, type AppPreferences } from '../settings/preferences'
import {
  AnnotationFrame,
  consumeSelectionChromeKey,
  DraftComment,
  nextPendingSelection,
  ReviewThreadCard,
  SelectionActions,
  type ReviewAnnotationMetadata,
  type ReviewThread
} from './ReviewComments'
import type { AgentSelection } from '../agent/agentAttachments'
import type { ReviewSummaryEntry } from './ReviewSummary'
import { createLazyModule, useLazyModule } from '../app/lazyModule'
import { ReviewClockProvider } from './reviewClock'
import {
  deriveAnnotatedReviewItems,
  type AnnotatedReviewItemCache
} from './annotatedReviewItems'
import {
  applyImagePreviews,
  applyMarkdownPreviews,
  canPreviewMarkdownItem,
  findActiveReviewItemId,
  findNextUnreadReviewItemId,
  pathFromReviewItemId as pathFromItemId,
  reviewItemId as itemId,
  shouldPinCollapsedHeader,
  type MarkdownHydratedSource
} from './reviewItems'
import { animateReviewItemToggle } from './reviewCollapseMotion'
import type { ReviewLoadState } from './useReviewLoadState'
import {
  itemsForRetainedWorld,
  takeCachedAnnotatedDerivation,
  worldViewCache
} from './worldViewCache'
import {
  createExactScroller,
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
import { pendingReveal, takeReveal } from '../app/revealLocation'
import type { ReviewFindSource } from './reviewFindSource'
import type { ReviewCommand } from '../settings/keybindings'
import {
  dropChangedViewedFiles,
  markViewedFile,
  type ViewedFileSignatures
} from './viewedFileStorage'
import { MARKDOWN_REVIEW_PREVIEW_CSS, VIEWER_BASE_CSS } from '../diff/viewerCss'
import { buildViewedPathsKey, parseViewedPathsKey } from './viewedPaths'
import { usePullRequestReviewParts } from '../github/usePullRequestReviewParts'
import { createReviewCommentAnchor } from './reviewThreadAnchors'
import { copyCodeReference, copyReviewComment } from './codeReferenceClipboard'
import { GutterActions } from '../diff/GutterActions'
import { useStableHandler } from './useStableHandler'
import { openFileInEditor } from './editorTarget'
import { isGeneratedReviewPath, useReviewFileMarks } from './reviewFileMarks'
import { orderReviewItems, useGuideItemOrder, useReviewView } from './reviewGuideView'
import type { GuideViewerHandle } from '../reviewGuide/ReviewGuideView'
import './MultiFileReview.css'

const CODE_VIEW_CSS = `
  ${VIEWER_BASE_CSS}
  ${MARKDOWN_REVIEW_PREVIEW_CSS}

  ${/* The ZWSP line exists so Pierre has a row to hang the preview annotation on. */ ''}
  :has(.image-diff-preview, .markdown-review-preview) [data-line]:not(:has(.image-diff-preview, .markdown-review-preview)) {
    display: none;
  }
`

const EMPTY_IMAGE_PREVIEWS: ReadonlyMap<string, FileImagePreview> = new Map()
const EMPTY_MARKDOWN_PATHS: ReadonlySet<string> = new Set()
const EMPTY_MARKDOWN_SOURCES: ReadonlyMap<string, MarkdownHydratedSource> = new Map()

// Outside the component: a write to a global inside one makes the React
// Compiler skip the whole component's memoization.
function publishReviewFindSource(source: ReviewFindSource): () => void {
  const sources = window.__kodiReviewFind ??= new Set()
  sources.add(source)
  return () => { sources.delete(source) }
}

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
  /** The repository the review belongs to, for `.gitattributes`. */
  reviewRoot?: string | null
  diffStyle: DiffStyle
  preferences: AppPreferences
  repositoryReview?: RepositoryReview | null
  pullRequestConversation?: PullRequestConversation | null
  loadState: ReviewLoadState
  loading: boolean
  targetPathCount: number
  onLoadMore(): void
  scrollToReviewRevision: number
  navigationPath: string | null
  navigationRevision: number
  /** The last navigation acted on; owned by the workspace, which outlives this review. */
  handledNavigationRevisionRef: { current: number }
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
  onAttachToAgent(selection: AgentSelection, prompt?: string): void
  reviewCommand: { command: ReviewCommand; path: string; revision: number } | null
  worldId: string
  /** The working tree's drafts: present, the desk review edits files in place. */
  workingDrafts?: WorkingDrafts
  autosaveOnBlur?: boolean
  onError?(message: string | null): void
}

function ReviewEmptyOverlay({
  pathCount,
  itemCount,
  loading,
  failedCount,
  omittedCount,
  skippedCount,
}: {
  pathCount: number
  itemCount: number
  loading: boolean
  failedCount: number
  omittedCount: number
  skippedCount: number
}): React.JSX.Element | null {
  if (pathCount === 0) {
    return (
      <div className="diff-state">
        <IconCodeSearch />
        <strong>No files to review</strong>
        <span>This review has no changed files.</span>
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

function ReviewOpenInEditorButton({ path }: { path: string }): React.JSX.Element {
  return (
    <button type="button" data-review-open-editor="" aria-label={`Open ${path} in editor`} title="Open in editor (⇧⌘O)"
      onClick={(event) => {
        event.stopPropagation()
        void openFileInEditor(path, null).catch((error: unknown) => {
          showToast(error instanceof Error ? error.message : 'The file could not be opened in an editor.')
        })
      }}>
      <IconArrowUpRight />
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

const NOOP_ERROR = (): void => {}

// The list of a review's own comments only exists once there is a comment.
const reviewSummaryModule = createLazyModule(() => import('./ReviewSummary'))
// The Guide view loads the first time a review switches to it.
const reviewGuideModule = createLazyModule(() => import('../reviewGuide/ReviewGuideView'))

function preloadEditorQuietly(): void {
  // A failed fetch surfaces again, with its message, on the click that needs it.
  preloadReviewEditing().catch(() => {})
}

/** A file edited in the review, with something unsaved: its save and its way back. */
function ReviewEditState({ path, saving, onSave, onDiscard }: {
  path: string
  saving: boolean
  onSave(path: string): void
  onDiscard(path: string): void
}): React.JSX.Element {
  return (
    <span className="review-edit-state" data-review-edit-state="">
      <span className="review-edit-status" role="status">{saving ? 'Saving' : 'Unsaved'}</span>
      <button type="button" data-review-discard="" aria-label={`Discard changes to ${path}`} title="Discard changes · ⌘Z brings them back"
        disabled={saving} onClick={() => onDiscard(path)}>
        <IconClockArrow />
      </button>
      <button type="button" data-review-save="" aria-label={`Save ${path}`} title="Save ⌘S"
        disabled={saving} onClick={() => onSave(path)}>
        <IconCheck />Save
      </button>
    </span>
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

  const scrollExactly = createExactScroller()
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
      scrollExactly(viewer, target, current)
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

/**
 * What the background anchor re-holds on: the review's identity and how much of
 * it has arrived. The review object itself is rebuilt by registry updates that
 * change nothing on screen — a repository sync, a status or checks poll — and
 * each one restarted the anchor's frame loop.
 */
export function reviewScrollAnchorKey(review: RepositoryReview | null): string | null {
  if (review == null) return null
  const identity = review.kind === 'github' ? review.pullRequest.url : review.id
  const patchLength = review.patchLength ?? review.patch.length
  return `${identity}:${review.baseOid}:${review.headOid}:${review.files.length}:${review.omittedFiles.length}:${review.patchPages?.length ?? 0}:${patchLength}`
}

function useBackgroundScrollAnchor(
  worldId: string | null | undefined,
  conversation: PullRequestConversation | null,
  reviewKey: string | null,
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
  }, [conversation, reviewKey, scrollContainerRef, viewerRef, worldId])
}

function findActiveRenderedItemId(viewer: CodeViewInstance<ReviewAnnotationMetadata>): string | null {
  const positions = viewer.getRenderedItems().flatMap((item) => {
    const top = viewer.getTopForItem(item.id)
    return top == null ? [] : [{ id: item.id, top }]
  })
  return findActiveReviewItemId(viewer.getScrollTop(), positions)
}

interface AnnotatedReviewItemsOptions {
  /** The loaded items in the order the viewer shows them. */
  items: ReviewLoadState['items']
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
  items,
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
      applyImagePreviews(items, imagePreviews),
      markdownPreviewPaths,
      markdownSources
    ),
    [imagePreviews, items, markdownPreviewPaths, markdownSources]
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

export function useReviewCodeViewOptions({
  diffStyle,
  preferences,
  repositoryReview,
  editing,
  onSelectLines,
  onHideSelectionActions,
  onImagePreview
}: {
  diffStyle: DiffStyle
  preferences: AppPreferences
  repositoryReview: RepositoryReview | null
  /** In-place editing, when this review is the working tree. */
  editing?: Pick<ReviewEditing, 'handleRender' | 'place'> | null
  onSelectLines(selection: CodeViewLineSelection | null): void
  onHideSelectionActions(): void
  onImagePreview(path: string, image: FileImagePreview): void
}): CodeViewReactOptions<ReviewAnnotationMetadata> {
  const handleRender = editing?.handleRender
  const place = editing?.place
  const diffLoader = useReviewDiffLoader(repositoryReview, onImagePreview)
  // Only the fields the viewer reads. A new options object reaches every mounted
  // item, so keying on the whole preferences object rebuilt the review whenever
  // an unrelated setting — the accent, the terminal scrollback — moved.
  const { editorTheme, wordWrap, showLineNumbers, foldUnchanged, codeLineHeight } = preferences
  return useMemo(() => ({
    // No `theme`: the worker pool resolves it and re-renders every instance on a
    // switch, so passing it here only forced a second full rebuild of the DOM.
    themeType: getEditorThemeType(editorTheme), diffStyle, diffIndicators: 'bars', lineDiffType: 'word-alt',
    overflow: wordWrap ? 'wrap' : 'scroll', disableLineNumbers: !showLineNumbers,
    tokenizeMaxLineLength: 2_000, enableLineSelection: true, enableGutterUtility: true,
    onLineSelectionStart: () => onHideSelectionActions(),
    onLineSelectionEnd: (range, context) => onSelectLines(range == null ? null : { id: context.item.id, range }),
    onPostRender: (node, instance, phase, context) => {
      syncDragGuideLifecycle(node, phase, (range) => onSelectLines({ id: context.item.id, range }))
      syncSplitDiffResizeLifecycle(node, phase)
      syncCopyFilePathLifecycle(node, phase, reportCopiedPath)
      handleRender?.(node, instance, context.item, phase)
      syncReviewCaretLifecycle(node, phase, place == null
        ? undefined
        : (position) => place(context.item, instance, position))
      noteReviewItemRender(instance, phase, context.item.id)
      noteFirstScreenRender(instance, phase)
      schedulePartialDiffHydration(instance, phase, context.item, diffLoader)
    },
    lineHoverHighlight: 'number', hunkSeparators: 'line-info-basic', expandUnchanged: !foldUnchanged,
    collapsedContextThreshold: 4, stickyHeaders: true, layout: { paddingTop: 16, paddingBottom: 48, gap: 12 },
    itemMetrics: { lineHeight: codeLineHeight }, unsafeCSS: CODE_VIEW_CSS,
    ...(diffLoader == null ? {} : { loadDiffFiles: diffLoader.load })
  }), [codeLineHeight, diffLoader, diffStyle, editorTheme, foldUnchanged, handleRender, onHideSelectionActions,
    onSelectLines, place, showLineNumbers, wordWrap])
}

export function useReviewCodeStyle(preferences: AppPreferences): CSSProperties {
  const { codeFont, interfaceFont, codeFontSize, codeLineHeight } = preferences
  return useMemo(() => ({
    '--diffs-font-family': CODE_FONTS[codeFont].fontFamily,
    '--diffs-header-font-family': INTERFACE_FONTS[interfaceFont].fontFamily,
    '--diffs-font-size': `var(${LIVE_CODE_FONT_SIZE_PROPERTY}, ${codeFontSize}px)`,
    '--diffs-line-height': `var(${LIVE_CODE_LINE_HEIGHT_PROPERTY}, ${codeLineHeight}px)`,
    '--diffs-font-features': '"calt" 1, "liga" 1'
  }) as CSSProperties, [codeFont, codeFontSize, codeLineHeight, interfaceFont])
}

interface MultiFileViewerProps {
  worldId?: string | null
  paths: readonly string[]
  diffStyle: DiffStyle
  preferences: AppPreferences
  repositoryReview: RepositoryReview | null
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
  onAskAgentAboutThread(item: CodeViewItem<ReviewAnnotationMetadata>, path: string, thread: ReviewThread): void
  onCopySelection(): void
  onImagePreview(path: string, image: FileImagePreview): void
  scrollContainerRef: RefObject<HTMLDivElement | null>
  /** Stops the front viewer from putting back its old scroll (see useRetainedScrollRestore). */
  cancelScrollRestoreRef: RefObject<(() => void) | null>
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
  workingDrafts?: WorkingDrafts
  autosaveOnBlur: boolean
  onError(message: string | null): void
  /** The world shows its guide: the review is laid out around the Guide view. */
  guideView: boolean
  /** Section labels on the first file of each guide section. */
  guidePills: ReadonlyMap<string, string> | null
  generatedPaths: ReadonlySet<string> | null
  /** The loaded items in the order the viewer shows them. */
  orderedItems: ReviewLoadState['items']
}

type AnnotationSlotOptions = Pick<MultiFileViewerProps,
  'onCommentOnSelection' | 'onAskAgentAboutSelection' | 'onAskAgentAboutThread' | 'onCopySelection' | 'saveComment' | 'onReplyToRemoteThread'
  | 'onResolveRemoteThread' | 'reattachingThread' | 'cancelComment' | 'pendingRemoteThreadId' | 'updateThread'
  | 'selectedLines' | 'onSelectLines' | 'onBeginComment'
> & { pullRequestParts: ReturnType<typeof usePullRequestReviewParts> }

/** What the viewer draws inside a file: comment threads, the draft, the selection bar, the gutter `+`. */
function useReviewAnnotationSlots({
  onCommentOnSelection,
  onAskAgentAboutSelection,
  onAskAgentAboutThread,
  onCopySelection,
  saveComment,
  onReplyToRemoteThread,
  onResolveRemoteThread,
  reattachingThread,
  pullRequestParts,
  cancelComment,
  pendingRemoteThreadId,
  updateThread,
  selectedLines,
  onSelectLines,
  onBeginComment
}: AnnotationSlotOptions) {
  const previousGutterActivationRef = useRef<{
    selection: CodeViewLineSelection
    timestamp: number
  } | null>(null)
  // These only read the pending selection, the draft and the loaded items when
  // they run. Passed through as they are, every selection, draft and streamed
  // page handed the annotation renderer a new identity, and Pierre rebuilds the
  // portal of every rendered item on that — thread cards included.
  const commentOnSelection = useStableHandler(onCommentOnSelection)
  const askAgentAboutSelection = useStableHandler(onAskAgentAboutSelection)
  const askAgentAboutThread = useStableHandler(onAskAgentAboutThread)
  const copySelection = useStableHandler(onCopySelection)
  const saveDraftComment = useStableHandler(saveComment)
  const replyToRemoteThread = useStableHandler(onReplyToRemoteThread)
  const resolveRemoteThread = useStableHandler(onResolveRemoteThread)
  const reattaching = reattachingThread != null
  const renderReviewAnnotation = useCallback((
    annotation: LineAnnotation<ReviewAnnotationMetadata> | DiffLineAnnotation<ReviewAnnotationMetadata>,
    item: CodeViewItem<ReviewAnnotationMetadata>
  ): React.JSX.Element => {
    const path = pathFromItemId(item.id)
    const metadata = annotation.metadata
    // The selection bar floats over the next line, so it gets no frame: an
    // unpadded row collapses to zero height and the diff does not move.
    if (metadata.kind === 'selection') {
      return <SelectionActions range={metadata.range}
        commentLabel={reattaching ? 'Reattach' : 'Comment'}
        onComment={commentOnSelection} onAskAgent={askAgentAboutSelection}
        onCopy={copySelection} />
    }
    if (metadata.kind === 'image') return <AnnotationFrame><ImageDiffPreview image={metadata.image} /></AnnotationFrame>
    if (metadata.kind === 'markdown') {
      return <AnnotationFrame><MarkdownReviewPreview source={metadata.source} partial={metadata.partial} /></AnnotationFrame>
    }
    if (metadata.kind === 'draft') {
      return <AnnotationFrame><DraftComment range={metadata.range} onCancel={cancelComment} onSave={saveDraftComment} /></AnnotationFrame>
    }
    if (metadata.kind === 'remote') {
      // Remote threads only exist once the conversation has arrived, which is
      // after the parts that draw them.
      if (pullRequestParts == null) return <></>
      return <AnnotationFrame><pullRequestParts.RemoteReviewThreadCard thread={metadata.thread}
        pending={pendingRemoteThreadId === metadata.thread.id}
        onReply={replyToRemoteThread} onToggleResolved={resolveRemoteThread} /></AnnotationFrame>
    }
    const { thread } = metadata
    return <AnnotationFrame><ReviewThreadCard thread={thread}
      onCopy={() => void copyReviewComment(path, thread)}
      onDelete={() => updateThread(path, thread.id, () => null)}
      onEdit={(body) => updateThread(path, thread.id, (current) => ({ ...current, body }))}
      onReply={(body) => updateThread(path, thread.id, (current) => ({ ...current, replies: [...current.replies, { id: crypto.randomUUID(), body }] }))}
      onToggleResolved={() => updateThread(path, thread.id, (current) => ({ ...current, resolved: !current.resolved }))}
      onAskAgent={() => askAgentAboutThread(item, path, thread)} /></AnnotationFrame>
  }, [askAgentAboutSelection, askAgentAboutThread, cancelComment, commentOnSelection, copySelection, pendingRemoteThreadId,
    pullRequestParts, reattaching, replyToRemoteThread, resolveRemoteThread, saveDraftComment, updateThread])
  // What the viewer's gutter click used to do: one `+` press selects the line,
  // two inside the interval open the composer. Custom utility content replaces
  // the callback, so the button runs it itself. It reads the live selection only
  // when pressed; closing over it changed the gutter renderer on every line of a
  // drag, and with it the portal of every rendered item.
  const commentOnGutterLine = useStableHandler((itemId: string, range: SelectedLineRange) => {
    const selection = { id: itemId, range }
    // A press inside the selection the reader already made comments on that
    // selection — not on the one line the button happened to be parked on.
    const hovered = range.start
    if (selectedLines != null
      && selectionCoversGutterLine(selectedLines, itemId, hovered, range.side ?? range.endSide)) {
      previousGutterActivationRef.current = null
      queueMicrotask(() => onBeginComment(selectedLines))
      return
    }
    const timestamp = performance.now()
    const opensComment = isGutterDoubleClick(previousGutterActivationRef.current, selection, timestamp)
    previousGutterActivationRef.current = opensComment ? null : { selection, timestamp }
    onSelectLines(selection)
    // CodeView reports selection-end after this callback. Starting the draft
    // on the next microtask lets that report finish before the action bar is cleared.
    if (opensComment) queueMicrotask(() => onBeginComment(selection))
  })
  const renderGutterUtility = useCallback((
    getHoveredLine: () => { lineNumber: number; side?: 'additions' | 'deletions' } | undefined,
    item: CodeViewItem<ReviewAnnotationMetadata>
  ) => (
    <GutterActions onComment={() => {
      const hovered = getHoveredLine()
      if (hovered == null) return
      commentOnGutterLine(item.id, {
        start: hovered.lineNumber,
        end: hovered.lineNumber,
        ...(hovered.side != null ? { side: hovered.side } : {})
      })
    }} />
  ), [commentOnGutterLine])
  return { renderReviewAnnotation, renderGutterUtility }
}

const MultiFileViewer = memo(function MultiFileViewer({
  worldId = null,
  paths,
  diffStyle,
  preferences,
  repositoryReview,
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
  onAskAgentAboutThread,
  onCopySelection,
  onImagePreview,
  scrollContainerRef,
  cancelScrollRestoreRef,
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
  onDropAll,
  workingDrafts,
  autosaveOnBlur,
  onError,
  guideView,
  guidePills,
  generatedPaths,
  orderedItems
}: MultiFileViewerProps): React.JSX.Element {
  const [showBackToTop, setShowBackToTop] = useState(false)
  const backToTopVisibleRef = useRef(false)
  const visiblePathRef = useRef<string | null>(null)
  const visiblePathTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const collapseFollowFrameRef = useRef(0)
  const deferredConversation = useDeferredValue(pullRequestConversation)
  const isPullRequestReview = repositoryReview?.kind === 'github'
  const pullRequestParts = usePullRequestReviewParts(isPullRequestReview)
  const editing = useReviewEditing({
    enabled: repositoryReview == null,
    paths,
    loading,
    workingDrafts,
    autosaveOnBlur,
    baseEditorOptions: useViewerContext()?.editorOptions,
    viewerRef,
    onError
  })
  const editedItems = useMemo(() => applyReviewEdits(annotatedItems, editing.edits), [annotatedItems, editing.edits])
  const editable = editing.editorOptions != null
  useBackgroundScrollAnchor(
    worldId,
    deferredConversation,
    reviewScrollAnchorKey(repositoryReview),
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
  const summary = useLazyModule(reviewSummaryModule, summaryEntries.length > 0)
  const summaryItemFor = useCallback((path: string) => viewerRef.current?.getItem(itemId(path)), [viewerRef])
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
      {pullRequestParts == null ? null : (
        <pullRequestParts.PullRequestContext conversation={deferredConversation} pullRequest={isPullRequestReview} />
      )}
      {summary == null ? null : (
        <summary.ReviewSummary entries={summaryEntries}
          reattachingThreadId={reattachingThread?.threadId ?? null}
          onBeginReattach={beginSummaryReattach} onCancelReattach={onCancelReattach}
          onDrop={dropSummaryThread} onDropAll={onDropAll} itemFor={summaryItemFor} />
      )}
    </>,
    [beginSummaryReattach, deferredConversation, dropSummaryThread, isPullRequestReview, onCancelReattach,
      onDropAll, pullRequestParts, reattachingThread, summary, summaryEntries, summaryItemFor]
  )
  const handleToggleItemCollapsed = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    window.cancelAnimationFrame(collapseFollowFrameRef.current)
    collapseFollowFrameRef.current = 0

    const viewer = viewerRef.current?.getInstance()
    const collapsing = !collapsedItemIds.has(item.id)
    const pinHeader = collapsing && viewer != null
      && shouldPinCollapsedHeader(viewer.getTopForItem(item.id), viewer.getScrollTop())

    toggleItemCollapsed(item)
    if (viewer == null) return

    // The first frame lands the new layout (and holds the header in place); the
    // second animates the settled DOM.
    collapseFollowFrameRef.current = window.requestAnimationFrame(() => {
      if (pinHeader) {
        viewerRef.current?.scrollTo({ type: 'item', id: item.id, align: 'start', behavior: 'instant' })
      }
      collapseFollowFrameRef.current = window.requestAnimationFrame(() => {
        collapseFollowFrameRef.current = 0
        animateReviewItemToggle(viewer, item.id, collapsing)
      })
    })
  }, [collapsedItemIds, toggleItemCollapsed, viewerRef])
  const renderHeaderPrefix = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    const pill = guidePills?.get(item.id)
    return <>
      <ReviewFileCollapseButton
        item={item}
        expanded={!collapsedItemIds.has(item.id)}
        onToggle={handleToggleItemCollapsed}
      />
      {pill == null ? null : <span data-review-guide-pill="">{pill}</span>}
      {isGeneratedReviewPath(pathFromItemId(item.id), generatedPaths)
        ? <span data-review-generated="" title="Generated: collapsed by default">Generated</span>
        : null}
    </>
  }, [collapsedItemIds, generatedPaths, guidePills, handleToggleItemCollapsed])
  // Viewed belongs in the header's metadata slot on the trailing edge. Rendered
  // in the prefix slot it shared a narrow box with the collapse button and
  // wrapped onto a second line under the chevron.
  const edits = editing.edits
  const saveEdit = editing.save
  const discardEdit = editing.discard
  const renderHeaderMetadata = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>) => {
    const path = pathFromItemId(item.id)
    const edit = edits.get(path)
    return (
      <>
        {edit != null && (edit.dirty || edit.saving) ? (
          <ReviewEditState path={path} saving={edit.saving} onSave={saveEdit} onDiscard={discardEdit} />
        ) : null}
        {previewableMarkdownPaths.has(path) ? (
          <ReviewMarkdownPreviewToggle
            path={path}
            previewing={markdownPreviewPaths.has(path)}
            onToggle={onToggleMarkdownPreview}
          />
        ) : null}
        <ReviewOpenInEditorButton path={path} />
        <ReviewViewedToggle path={path} viewed={viewedPaths.has(path)} onToggle={onToggleViewed} />
      </>
    )
  }, [discardEdit, edits, markdownPreviewPaths, onToggleMarkdownPreview, onToggleViewed, previewableMarkdownPaths,
    saveEdit, viewedPaths])
  const { renderReviewAnnotation, renderGutterUtility } = useReviewAnnotationSlots({
    onCommentOnSelection, onAskAgentAboutSelection, onAskAgentAboutThread, onCopySelection, saveComment, onReplyToRemoteThread,
    onResolveRemoteThread, reattachingThread, pullRequestParts, cancelComment, pendingRemoteThreadId, updateThread,
    selectedLines, onSelectLines, onBeginComment
  })
  const remainingPathCount = paths.length - targetPathCount
  const codeViewSlots = useMemo<ReviewCodeViewSlots>(() => ({
    header: renderReviewSummary,
    headerPrefix: renderHeaderPrefix,
    headerMetadata: renderHeaderMetadata,
    annotation: renderReviewAnnotation,
    gutterUtility: renderGutterUtility,
    footer: remainingPathCount > 0
      ? () => <ReviewLoadMoreSentinel loading={loading} onLoadMore={onLoadMore} />
      : undefined
  }), [loading, onLoadMore, remainingPathCount, renderGutterUtility, renderHeaderMetadata,
    renderHeaderPrefix, renderReviewAnnotation, renderReviewSummary])
  const codeStyle = useReviewCodeStyle(preferences)
  const codeViewOptions = useReviewCodeViewOptions({
    diffStyle,
    preferences,
    repositoryReview,
    editing: editable ? editing : null,
    onSelectLines,
    onHideSelectionActions,
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

  const guide = useLazyModule(reviewGuideModule, guideView)
  const retainedWorldIds = useRetainedWorldViewers(worldId)
  const viewerSlots = retainedWorldIds.flatMap((id) => {
    const items = itemsForRetainedWorld(
      id,
      worldId,
      editedItems,
      worldViewCache.get(id)?.annotated?.items
    )
    return items == null ? [] : [{ id, items }]
  })
  const activeHasItems = paths.length > 0 && loadState.items.length > 0
  // A hidden slot keeps its React state but not its Pierre instance, so only the
  // visible one is charged as a viewer.
  worldViewCache.retainMountedViewers(
    worldId != null && activeHasItems && viewerSlots.some((slot) => slot.id === worldId) ? [worldId] : []
  )

  const emptyOverlay = (
    <ReviewEmptyOverlay
      pathCount={paths.length}
      itemCount={loadState.items.length}
      loading={loading}
      failedCount={loadState.failedCount}
      omittedCount={loadState.omittedFiles.length}
      skippedCount={loadState.skippedCount}
    />
  )
  if (emptyOverlay != null && viewerSlots.length === 0) return emptyOverlay

  // The guide sits beside the same viewer element; only the container's layout
  // changes, so the retained viewer and its measured heights survive the switch.
  const guideActive = guideView && guide != null && worldId != null
  return <div className="multi-file-review" data-review-guide={guideActive ? '' : undefined}>
    {guideActive ? (
      <guide.ReviewGuideView worldId={worldId} viewerRef={viewerRef as unknown as RefObject<GuideViewerHandle | null>}
        items={orderedItems} viewedPaths={viewedPaths} repositoryReview={repositoryReview} fileCount={paths.length} />
    ) : null}
    {emptyOverlay}
    {/* The editor module is ~1 MB of script: fetched as the pointer arrives
        over a review it could edit, it is parsed by the time the click lands. */}
    <div className="multi-file-code-view-host" onPointerEnter={editable ? preloadEditorQuietly : undefined}>
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
          cancelScrollRestoreRef={cancelScrollRestoreRef}
          setViewerRef={setViewerRef}
          getInitialScrollTop={getInitialScrollTop}
          loading={loading}
          editorOptions={editing.editorOptions}
          onItemEditChange={editable ? editing.onItemEditChange : undefined}
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
  onAttachToAgent(selection: AgentSelection, prompt?: string): void
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
  const askAgentAboutThread = useCallback((item: CodeViewItem<ReviewAnnotationMetadata>, path: string, thread: ReviewThread) => {
    const selection = agentSelectionForReviewItem(item, path, thread.range)
    if (selection == null) {
      showToast('This comment’s lines are no longer in the diff')
      return
    }
    onAttachToAgent(selection, `About this comment: ${thread.body}`)
  }, [onAttachToAgent])
  // Copy leaves the selection up — it is the grab, not the destination, and the
  // reader may still want the comment or chat action on the same lines.
  const copySelection = useCallback(() => {
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
    void copyCodeReference(
      { path, first: selection.startLine, last: selection.endLine, side: selection.side },
      selection.selectedText
    )
  }, [items, pendingSelection])

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
    askAgentAboutSelection,
    askAgentAboutThread,
    copySelection
  }
}

/**
 * Moves the review to the file a navigation asked for once that file is loaded,
 * and to the top when the summary is opened.
 */
function useReviewNavigationJump({
  viewerRef,
  cancelScrollRestoreRef,
  handledNavigationRevisionRef,
  navigationPath,
  navigationRevision,
  paths,
  loadedPaths,
  scrollToReviewRevision
}: {
  viewerRef: RefObject<CodeViewHandle<ReviewAnnotationMetadata> | null>
  cancelScrollRestoreRef: RefObject<(() => void) | null>
  handledNavigationRevisionRef: { current: number }
  navigationPath: string | null
  navigationRevision: number
  paths: readonly string[]
  /** Only a dependency: a page landing is when a pending navigation can run. */
  loadedPaths: ReviewLoadState['loadedPaths']
  scrollToReviewRevision: number
}): void {
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
    // A viewer coming back to the front — the reader was in the single-file view
    // and clicked a file of the review — puts its old position back over several
    // frames, and that won over the jump: the review reopened where it was left,
    // not on the file.
    cancelScrollRestoreRef.current?.()
    const reveal = pendingReveal(navigationPath)
    if (reveal != null) {
      takeReveal(reveal)
      viewer?.scrollTo({ type: 'line', id, lineNumber: reveal.line, side: 'additions', align: 'center', behavior: 'instant' })
      viewer?.setSelectedLines({ id, range: { start: reveal.line, end: reveal.line, side: 'additions' } })
      return
    }
    viewer?.scrollTo({
      type: 'item',
      id,
      align: 'start',
      behavior: 'smooth-auto'
    })
  }, [cancelScrollRestoreRef, handledNavigationRevisionRef, loadedPaths, navigationPath, navigationRevision,
    paths, viewerRef])

  useEffect(() => {
    if (scrollToReviewRevision === 0) return
    scrollToReviewTop(viewerRef.current)
  }, [scrollToReviewRevision, viewerRef])
}

function useMarkdownPreviewLanding(
  markdownPreviewPinRef: RefObject<ReviewScrollAnchor | null>,
  viewerRef: RefObject<CodeViewHandle<ReviewAnnotationMetadata> | null>,
  markdownPreviewPaths: ReadonlySet<string>,
  markdownSources: ReadonlyMap<string, MarkdownHydratedSource>
): void {
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
    const scrollExactly = createExactScroller()
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
          scrollExactly(viewer, target, current)
        }
      }
      if (performance.now() - startedAt < SCROLL_RESTORE_TIMEOUT_MS) {
        frame = window.requestAnimationFrame(step)
      }
    }
    step()
    return () => window.cancelAnimationFrame(frame)
  }, [markdownPreviewPaths, markdownPreviewPinRef, markdownSources, viewerRef])
}

const MultiFileReview = memo(function MultiFileReview({
  paths,
  reviewRoot = null,
  diffStyle,
  preferences,
  repositoryReview = null,
  pullRequestConversation = null,
  loadState,
  loading,
  targetPathCount,
  onLoadMore,
  scrollToReviewRevision,
  navigationPath,
  navigationRevision,
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
  worldId,
  workingDrafts,
  autosaveOnBlur = false,
  onError = NOOP_ERROR
}: MultiFileReviewProps): React.JSX.Element {
  useLayoutEffect(() => markRendererStartup('viewerCommitted'), [])
  const [imagePreviews, setImagePreviews] = useState(EMPTY_IMAGE_PREVIEWS)
  const [markdownPreviewPaths, setMarkdownPreviewPaths] = useState<ReadonlySet<string>>(EMPTY_MARKDOWN_PATHS)
  const [markdownSources, setMarkdownSources] = useState<ReadonlyMap<string, MarkdownHydratedSource>>(EMPTY_MARKDOWN_SOURCES)
  const viewerRef = useRef<CodeViewHandle<ReviewAnnotationMetadata> | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const cancelScrollRestoreRef = useRef<(() => void) | null>(null)
  const viewedAdvanceFrameRef = useRef(0)
  const markdownPreviewPinRef = useRef<ReviewScrollAnchor | null>(null)
  const stablePaths = paths
  const generatedPaths = useReviewFileMarks(worldId, reviewRoot, paths, repositoryReview?.headOid ?? null)
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
    worldId,
    generatedPaths
  })
  const {
    pendingSelection,
    handleSelectLines,
    hideSelectionActions,
    beginCommentAtSelection,
    commentOnSelection,
    startReattach,
    stopReattach,
    askAgentAboutSelection,
    askAgentAboutThread,
    copySelection
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
  const guideView = useReviewView(worldId) === 'guide'
  const guideOrder = useGuideItemOrder(worldId)
  const orderedItems = useMemo(
    () => orderReviewItems(loadState.items, guideOrder) as ReviewLoadState['items'],
    [guideOrder, loadState.items]
  )
  // ⌘F searches every file of the review, not only the rows the viewer drew.
  const findRevision = repositoryReview?.headOid ?? null
  useEffect(() => publishReviewFindSource({
    viewer: () => viewerRef.current?.getInstance() as CodeViewInstance<unknown> | undefined,
    items: () => orderedItems,
    expand: (id) => setCollapsedById(id, false),
    scope: () => reviewRoot == null ? null : { root: reviewRoot, revision: findRevision }
  }), [findRevision, orderedItems, reviewRoot, setCollapsedById])
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

  useReviewNavigationJump({
    viewerRef,
    cancelScrollRestoreRef,
    handledNavigationRevisionRef,
    navigationPath,
    navigationRevision,
    paths,
    loadedPaths: loadState.loadedPaths,
    scrollToReviewRevision
  })

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

  useMarkdownPreviewLanding(markdownPreviewPinRef, viewerRef, markdownPreviewPaths, markdownSources)

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
          orderedItems,
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
  }, [itemsByPath, orderedItems, setCollapsedById, setViewedFiles, viewedPaths])

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
    items: orderedItems,
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
      loadState={loadState} loading={loading}
      targetPathCount={targetPathCount} onLoadMore={onLoadMore}
      selectedLines={selectedLines} annotatedItems={annotatedItems} threadsByPath={threadsByPath}
      collapsedItemIds={collapsedItemIds} viewedPaths={viewedPaths}
      onToggleViewed={toggleViewed} scrollContainerRef={scrollContainerRef}
      cancelScrollRestoreRef={cancelScrollRestoreRef}
      previewableMarkdownPaths={previewableMarkdownPaths} markdownPreviewPaths={markdownPreviewPaths}
      onToggleMarkdownPreview={toggleMarkdownPreview}
      viewerRef={viewerRef}
      remoteThreadsByPath={remoteThreadsByPath} pendingRemoteThreadId={pendingRemoteThreadId}
      onReplyToRemoteThread={onReplyToRemoteThread} onResolveRemoteThread={onResolveRemoteThread}
      pendingSelection={pendingSelection} onSelectLines={handleSelectLines}
      onHighlightLines={handleSelectedLinesChange} onHideSelectionActions={hideSelectionActions}
      onCommentOnSelection={commentOnSelection} onBeginComment={beginCommentAtSelection}
      onAskAgentAboutSelection={askAgentAboutSelection} onAskAgentAboutThread={askAgentAboutThread} onCopySelection={copySelection}
      onImagePreview={handleImagePreview}
      onScrollPositionChange={onScrollPositionChange} onVisiblePathChange={onVisiblePathChange} setViewerRef={setViewerRef}
      getInitialScrollTop={getInitialScrollTop}
      toggleItemCollapsed={toggleItemCollapsed} cancelComment={cancelComment} saveComment={saveComment}
      updateThread={updateThread} reattachingThread={reattachingThread}
      onBeginReattach={startReattach} onCancelReattach={stopReattach}
      onDropAll={dropAllReviewThreads}
      workingDrafts={workingDrafts} autosaveOnBlur={autosaveOnBlur} onError={onError}
      guideView={guideView} guidePills={guideOrder?.pills ?? null} generatedPaths={generatedPaths} orderedItems={orderedItems}
    />
  </ReviewClockProvider>
})

export default MultiFileReview
