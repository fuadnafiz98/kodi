import {
  Activity,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from 'react'
import {
  type CodeViewItem,
  type CodeViewLineSelection,
  type DiffLineAnnotation,
  type LineAnnotation
} from '@pierre/diffs'
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from '@pierre/diffs/react'

import type { ReviewAnnotationMetadata } from './ReviewComments'
import {
  MAX_RETAINED_WORLD_VIEWERS,
  retainWorldViewers,
  worldViewCache
} from './worldViewCache'

export const SCROLL_RESTORE_SETTLED_FRAMES = 3
export const SCROLL_RESTORE_TIMEOUT_MS = 800
const SCROLL_TAKEOVER_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const
const NOOP_SCROLL = (_scrollTop: number): void => undefined

export function observeScrollTakeover(container: HTMLElement | null, listener: () => void): () => void {
  for (const type of SCROLL_TAKEOVER_EVENTS) container?.addEventListener(type, listener, { passive: true })
  return () => {
    for (const type of SCROLL_TAKEOVER_EVENTS) container?.removeEventListener(type, listener)
  }
}

/**
 * Scrolls a viewer to an exact offset over several frames. Pierre's `position`
 * scroll lands the sticky header's height (44 px) short of what was asked,
 * unless the offset is clamped, while `getScrollTop` reports where the list
 * really is. A loop asking for the target every frame therefore never settled:
 * it re-scrolled every frame until its timeout and left the reader that much
 * higher, a little more each time a tab came back. This asks, reads where the
 * list landed, and asks again with the difference.
 */
export function createExactScroller(): (
  viewer: CodeViewHandle<ReviewAnnotationMetadata>,
  target: number,
  current: number | null
) => void {
  let offset = 0
  let lastRequest: number | null = null
  return (viewer, target, current) => {
    if (lastRequest != null && current != null) offset = lastRequest - current
    lastRequest = target + offset
    viewer.scrollTo({ type: 'position', position: lastRequest, behavior: 'instant' })
  }
}

export function getViewerScrollTop(viewer: CodeViewHandle<ReviewAnnotationMetadata> | null): number | null {
  return viewer?.getInstance()?.getScrollTop() ?? null
}

export function useRetainedWorldViewers(worldId: string | null | undefined): string[] {
  const [retained, setRetained] = useState<string[]>(() => worldId == null ? [] : [worldId])
  const next = worldId == null ? retained : retainWorldViewers(retained, worldId, MAX_RETAINED_WORLD_VIEWERS)
  if (next !== retained) setRetained(next)
  useEffect(() => () => {
    worldViewCache.retainMountedViewers([])
  }, [])
  return next
}

interface RetainedScrollRestoreOptions {
  active: boolean
  loading: boolean
  itemCount: number
  getInitialScrollTop(): number
  viewerRef: RefObject<CodeViewHandle<ReviewAnnotationMetadata> | null>
  containerRef: RefObject<HTMLElement | null>
  /** Receives the running restore's cancel, so a navigation can take over. */
  cancelRef?: RefObject<(() => void) | null>
}

/**
 * Puts a retained viewer back where its reader left it, on first load and on
 * every return to the front. Hiding an `<Activity>` detaches its host refs, and
 * Pierre's CodeView cleans its instance up when its node ref goes null, so a
 * world that comes back gets a new instance scrolled to the top. The position
 * it returns to is its own last scroll: `getInitialScrollTop` answers for
 * whichever world scrolled last. Returns the recorder for the viewer's scroll.
 */
export function useRetainedScrollRestore({
  active,
  loading,
  itemCount,
  getInitialScrollTop,
  viewerRef,
  containerRef,
  cancelRef
}: RetainedScrollRestoreOptions): (scrollTop: number) => void {
  const restoredScrollPositionRef = useRef(false)
  const restoreTargetRef = useRef<number | null>(null)
  const lastScrollTopRef = useRef<number | null>(null)

  const recordScrollTop = useCallback((scrollTop: number) => {
    lastScrollTopRef.current = scrollTop
  }, [])

  // A navigation owns the scroll from here: it stops a restore that is running
  // and one still waiting for the review to finish loading. The waiting one was
  // the case that slipped through — a review reloading as it came back put its
  // old offset back after the jump to the clicked file.
  const runningRestoreRef = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    if (!active || cancelRef == null) return
    const cancel = (): void => {
      restoredScrollPositionRef.current = true
      runningRestoreRef.current?.()
    }
    cancelRef.current = cancel
    return () => {
      if (cancelRef.current === cancel) cancelRef.current = null
    }
  }, [active, cancelRef])

  useLayoutEffect(() => {
    if (restoreTargetRef.current == null && itemCount > 0) {
      restoreTargetRef.current = getInitialScrollTop()
    }
  }, [getInitialScrollTop, itemCount])

  // The cleanup runs as the viewer comes back to the front. The hidden viewer's
  // scroll is not subscribed, so the last position recorded is the reader's.
  useLayoutEffect(() => {
    if (active) return
    return () => {
      restoreTargetRef.current = lastScrollTopRef.current ?? restoreTargetRef.current
      restoredScrollPositionRef.current = false
    }
  }, [active])

  // Whether there is anything to restore onto, not how much: a page landing
  // while the frames below are still settling re-ran the effect, its cleanup
  // stopped the restore, and the done flag kept it from starting again.
  const hasItems = itemCount > 0
  useEffect(() => {
    const restoreTarget = restoreTargetRef.current
    if (!active || restoredScrollPositionRef.current || loading || !hasItems) return
    restoredScrollPositionRef.current = true
    if (restoreTarget == null || restoreTarget <= 0) return
    let frame = 0
    let settledFrames = 0
    let cancelled = false
    const startedAt = performance.now()
    const cancel = (): void => {
      cancelled = true
    }
    runningRestoreRef.current = cancel
    const stopObservingScrollTakeover = observeScrollTakeover(containerRef.current, cancel)
    const scrollExactly = createExactScroller()
    const step = (): void => {
      if (cancelled) return
      const viewer = viewerRef.current
      if (viewer == null) return
      const current = getViewerScrollTop(viewer)
      if (current != null && Math.abs(current - restoreTarget) <= 1) {
        settledFrames += 1
        if (settledFrames >= SCROLL_RESTORE_SETTLED_FRAMES) return
      } else {
        settledFrames = 0
        scrollExactly(viewer, restoreTarget, current)
      }
      if (performance.now() - startedAt < SCROLL_RESTORE_TIMEOUT_MS) {
        frame = window.requestAnimationFrame(step)
      }
    }
    step()
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      stopObservingScrollTakeover()
      if (runningRestoreRef.current === cancel) runningRestoreRef.current = null
    }
  }, [active, containerRef, hasItems, loading, viewerRef])

  return recordScrollTop
}

export interface ReviewCodeViewSlots {
  header(): React.JSX.Element
  headerPrefix(item: CodeViewItem<ReviewAnnotationMetadata>): React.JSX.Element
  headerMetadata(item: CodeViewItem<ReviewAnnotationMetadata>): React.JSX.Element
  annotation(
    annotation: LineAnnotation<ReviewAnnotationMetadata> | DiffLineAnnotation<ReviewAnnotationMetadata>,
    item: CodeViewItem<ReviewAnnotationMetadata>
  ): React.JSX.Element
  footer?(): React.ReactNode
  gutterUtility(
    getHoveredLine: () => { lineNumber: number; side?: 'additions' | 'deletions' } | undefined,
    item: CodeViewItem<ReviewAnnotationMetadata>
  ): React.ReactNode
}

function codeViewSlotProps(slots: ReviewCodeViewSlots) {
  return {
    renderCodeViewHeader: slots.header,
    renderHeaderPrefix: slots.headerPrefix,
    renderHeaderMetadata: slots.headerMetadata,
    renderAnnotation: slots.annotation,
    renderGutterUtility: slots.gutterUtility,
    renderCodeViewFooter: slots.footer
  }
}

interface RetainedWorldCodeViewProps {
  worldId: string
  active: boolean
  items: CodeViewItem<ReviewAnnotationMetadata>[]
  selectedLines: CodeViewLineSelection | null
  codeViewOptions: CodeViewReactOptions<ReviewAnnotationMetadata>
  codeStyle: CSSProperties
  slots: ReviewCodeViewSlots
  onHighlightLines(selection: CodeViewLineSelection | null): void
  onScroll(scrollTop: number): void
  scrollContainerRef: RefObject<HTMLDivElement | null>
  cancelScrollRestoreRef?: RefObject<(() => void) | null>
  setViewerRef(viewer: CodeViewHandle<ReviewAnnotationMetadata> | null): void
  getInitialScrollTop(): number
  loading: boolean
}

export const RetainedWorldCodeView = memo(function RetainedWorldCodeView({
  worldId,
  active,
  items,
  selectedLines,
  codeViewOptions,
  codeStyle,
  slots,
  onHighlightLines,
  onScroll,
  scrollContainerRef,
  cancelScrollRestoreRef,
  setViewerRef,
  getInitialScrollTop,
  loading
}: RetainedWorldCodeViewProps): React.JSX.Element {
  const localViewerRef = useRef<CodeViewHandle<ReviewAnnotationMetadata> | null>(null)
  const localContainerRef = useRef<HTMLDivElement | null>(null)
  const frozenRef = useRef({
    items,
    selectedLines,
    codeViewOptions,
    codeStyle,
    slots,
    onHighlightLines,
    onScroll
  })
  const view = active
    ? {
        items,
        selectedLines,
        codeViewOptions,
        codeStyle,
        slots,
        onHighlightLines,
        onScroll
      }
    : frozenRef.current

  const assignViewer = useCallback((viewer: CodeViewHandle<ReviewAnnotationMetadata> | null) => {
    localViewerRef.current = viewer
    if (active) setViewerRef(viewer)
  }, [active, setViewerRef])

  useLayoutEffect(() => {
    if (!active) return
    frozenRef.current = {
      items,
      selectedLines,
      codeViewOptions,
      codeStyle,
      slots,
      onHighlightLines,
      onScroll
    }
  }, [
    active,
    codeStyle,
    codeViewOptions,
    items,
    onHighlightLines,
    onScroll,
    selectedLines,
    slots
  ])

  useLayoutEffect(() => {
    if (!active) return
    setViewerRef(localViewerRef.current)
    scrollContainerRef.current = localContainerRef.current
  }, [active, scrollContainerRef, setViewerRef])

  const recordScrollTop = useRetainedScrollRestore({
    active,
    loading,
    itemCount: view.items.length,
    getInitialScrollTop,
    viewerRef: localViewerRef,
    containerRef: localContainerRef,
    // Only the front viewer answers to navigation.
    cancelRef: active ? cancelScrollRestoreRef : undefined
  })
  const forwardScroll = view.onScroll
  const handleScroll = useCallback((scrollTop: number) => {
    recordScrollTop(scrollTop)
    forwardScroll(scrollTop)
  }, [forwardScroll, recordScrollTop])

  // Plan 024 rejected unbounded Activity because it multiplies the viewer. What
  // the last-N cap keeps is the React side: items, options and slots stay put,
  // so a cache-hit world switch skips reparsing and rederiving. Pierre's
  // instance does not survive the hide (see useRetainedScrollRestore), so a
  // hidden slot is not charged viewer bytes and its scroll is restored on return.
  // Plain hidden styling would keep the instance, but its resize observer would
  // then lay the list out against a zero-height viewport.
  return (
    <Activity mode={active ? 'visible' : 'hidden'} name={worldId}>
      <div className="multi-file-code-view-slot">
        <CodeView<ReviewAnnotationMetadata> ref={assignViewer} containerRef={localContainerRef}
          items={view.items} onScroll={active ? handleScroll : NOOP_SCROLL}
          options={view.codeViewOptions} selectedLines={view.selectedLines}
          onSelectedLinesChange={view.onHighlightLines}
          {...codeViewSlotProps(view.slots)}
          className="multi-file-code-view" style={view.codeStyle} />
      </div>
    </Activity>
  )
})
