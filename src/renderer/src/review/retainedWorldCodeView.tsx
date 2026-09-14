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

export interface ReviewCodeViewSlots {
  header(): React.JSX.Element
  headerPrefix(item: CodeViewItem<ReviewAnnotationMetadata>): React.JSX.Element
  headerMetadata(item: CodeViewItem<ReviewAnnotationMetadata>): React.JSX.Element
  annotation(
    annotation: LineAnnotation<ReviewAnnotationMetadata> | DiffLineAnnotation<ReviewAnnotationMetadata>,
    item: CodeViewItem<ReviewAnnotationMetadata>
  ): React.JSX.Element
  footer?(): React.ReactNode
}

function codeViewSlotProps(slots: ReviewCodeViewSlots) {
  return {
    renderCodeViewHeader: slots.header,
    renderHeaderPrefix: slots.headerPrefix,
    renderHeaderMetadata: slots.headerMetadata,
    renderAnnotation: slots.annotation,
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
  setViewerRef,
  getInitialScrollTop,
  loading
}: RetainedWorldCodeViewProps): React.JSX.Element {
  const localViewerRef = useRef<CodeViewHandle<ReviewAnnotationMetadata> | null>(null)
  const localContainerRef = useRef<HTMLDivElement | null>(null)
  const restoredScrollPositionRef = useRef(false)
  const restoreTargetRef = useRef<number | null>(null)
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
    if (restoreTargetRef.current == null && items.length > 0) {
      restoreTargetRef.current = getInitialScrollTop()
    }
  }, [getInitialScrollTop, items.length])

  useLayoutEffect(() => {
    if (!active) return
    setViewerRef(localViewerRef.current)
    scrollContainerRef.current = localContainerRef.current
  }, [active, scrollContainerRef, setViewerRef])

  useEffect(() => {
    const restoreTarget = restoreTargetRef.current
    if (restoredScrollPositionRef.current || loading || view.items.length === 0) return
    restoredScrollPositionRef.current = true
    if (restoreTarget == null || restoreTarget <= 0) return
    let frame = 0
    let settledFrames = 0
    let cancelled = false
    const startedAt = performance.now()
    const cancel = (): void => {
      cancelled = true
    }
    const stopObservingScrollTakeover = observeScrollTakeover(localContainerRef.current, cancel)
    const step = (): void => {
      if (cancelled) return
      const viewer = localViewerRef.current
      if (viewer == null) return
      const current = getViewerScrollTop(viewer)
      if (current != null && Math.abs(current - restoreTarget) <= 1) {
        settledFrames += 1
        if (settledFrames >= SCROLL_RESTORE_SETTLED_FRAMES) return
      } else {
        settledFrames = 0
        viewer.scrollTo({ type: 'position', position: restoreTarget, behavior: 'instant' })
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
    }
  }, [loading, view.items.length])

  // Plan 024 rejected unbounded Activity because it multiplies the viewer.
  // A last-N cap plus estimator viewer bytes is the keep-alive that skips
  // tearing down the outgoing Pierre list on a cache-hit world switch.
  return (
    <Activity mode={active ? 'visible' : 'hidden'} name={worldId}>
      <div className="multi-file-code-view-slot">
        <CodeView<ReviewAnnotationMetadata> ref={assignViewer} containerRef={localContainerRef}
          items={view.items} onScroll={active ? view.onScroll : NOOP_SCROLL}
          options={view.codeViewOptions} selectedLines={view.selectedLines}
          onSelectedLinesChange={view.onHighlightLines}
          {...codeViewSlotProps(view.slots)}
          className="multi-file-code-view" style={view.codeStyle} />
      </div>
    </Activity>
  )
})
