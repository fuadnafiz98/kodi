const DEFAULT_SPLIT_PERCENT = 50
const MIN_SPLIT_PERCENT = 25
const MAX_SPLIT_PERCENT = 75
const KEYBOARD_STEP = 2
const LARGE_KEYBOARD_STEP = 10

export const SPLIT_DIFF_RESIZE_CSS = `
  [data-diff-type="split"][data-overflow="scroll"] {
    grid-template-columns:
      minmax(0, var(--kodi-split-before, 50fr))
      minmax(0, var(--kodi-split-after, 50fr));
  }

  [data-diff-type="split"][data-overflow="wrap"],
  [data-dehydrated][data-diff-type="split"][data-overflow="scroll"] {
    grid-template-columns:
      var(--diffs-grid-number-column-width)
      minmax(0, var(--kodi-split-before, 50fr))
      var(--diffs-grid-number-column-width)
      minmax(0, var(--kodi-split-after, 50fr));
  }

  /* Anchors, because the handle has nowhere legal to live inside the diff: the
     viewer asserts the <pre> has exactly two code children and that each pane's
     gutter and content have matching child counts, and it throws out of line
     selection when either is off by one. So the handle sits beside the <pre> in
     the shadow root and is anchored to the new pane's line-number column, whose
     leading edge is the split boundary in both wrap and scroll mode. */
  [data-diff-type="split"] {
    position: relative;
    anchor-name: --kodi-split-pre;
  }

  [data-diff-type="split"] [data-code][data-additions] > [data-gutter] {
    anchor-name: --kodi-split-edge;
  }

  [data-split-resize-handle] {
    position: absolute;
    z-index: var(--z-sticky);
    top: anchor(--kodi-split-pre top);
    bottom: anchor(--kodi-split-pre bottom);
    left: calc(anchor(--kodi-split-edge left) - 6px);
    width: 12px;
    min-height: 24px;
    padding: 0;
    border: 0;
    outline: 0;
    background: transparent;
    cursor: col-resize;
    touch-action: none;
    user-select: none;
  }

  [data-split-resize-handle]::after {
    content: "";
    position: absolute;
    inset-block: 0;
    inset-inline-start: 5px;
    width: 1px;
    background: color-mix(in srgb, var(--diffs-fg) 16%, transparent);
  }

  [data-split-resize-handle]:hover::after,
  [data-split-resize-handle]:focus-visible::after,
  [data-split-resize-handle][data-dragging]::after {
    width: 2px;
    background: var(--diffs-modified-base);
  }

  [data-split-resize-handle]:focus-visible::before {
    content: "";
    position: absolute;
    inset-block: 4px;
    inset-inline-start: 1px;
    width: 10px;
    border: 1px solid var(--diffs-modified-base);
    border-radius: var(--corner-inline);
    corner-shape: squircle;
  }
`

interface SplitResizeBinding {
  syncHandle(percentage: number): void
  teardown(): void
}

const bindings = new WeakMap<HTMLElement, SplitResizeBinding>()
const splitPercentages = new WeakMap<HTMLElement, number>()

export function clampSplitPercentage(value: number): number {
  return Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, value))
}

export function splitPercentageFromPointer(clientX: number, left: number, width: number): number {
  if (!Number.isFinite(width) || width <= 0) return DEFAULT_SPLIT_PERCENT
  return clampSplitPercentage(((clientX - left) / width) * 100)
}

export function resistedSplitPercentage(value: number, width: number): number {
  return withResistance(value, MIN_SPLIT_PERCENT, MAX_SPLIT_PERCENT, width)
}

function findSurface(node: HTMLElement): HTMLElement {
  return node.closest<HTMLElement>('.diff-panel') ?? node.parentElement ?? node
}

function applySplitPercentage(surface: HTMLElement, value: number, resistanceWidth?: number): number {
  const percentage = clampSplitPercentage(value)
  const displayed = resistanceWidth == null ? percentage : resistedSplitPercentage(value, resistanceWidth)
  splitPercentages.set(surface, percentage)
  surface.style.setProperty('--kodi-split-before', `${displayed}fr`)
  surface.style.setProperty('--kodi-split-after', `${100 - displayed}fr`)
  surface.dispatchEvent(new CustomEvent<number>('kodi:split-resize', { detail: percentage }))
  return percentage
}

function createHandle(root: ShadowRoot, percentage: number): HTMLElement | null {
  if (root.querySelector('[data-diff-type="split"]') == null) return null

  const existing = root.querySelector<HTMLElement>('[data-split-resize-handle]')
  if (existing != null) {
    // A re-render can move the handle back inside the diff; the anchors only
    // resolve while it is a sibling of the <pre>.
    if (existing.parentNode !== root) root.append(existing)
    return existing
  }

  const handle = document.createElement('div')
  handle.dataset.splitResizeHandle = ''
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-label', 'Resize old and new code panes')
  handle.setAttribute('aria-orientation', 'vertical')
  handle.setAttribute('aria-valuemin', String(MIN_SPLIT_PERCENT))
  handle.setAttribute('aria-valuemax', String(MAX_SPLIT_PERCENT))
  handle.setAttribute('aria-valuenow', String(Math.round(percentage)))
  handle.setAttribute('title', 'Drag to resize · Double-click to reset')
  handle.tabIndex = 0
  root.append(handle)
  return handle
}

function eventHandle(event: Event): HTMLElement | null {
  return event.composedPath().find(
    (target): target is HTMLElement => target instanceof HTMLElement && target.hasAttribute('data-split-resize-handle')
  ) ?? null
}

export function syncSplitDiffResizeLifecycle(node: HTMLElement, phase: string): void {
  if (phase === 'unmount') {
    bindings.get(node)?.teardown()
    bindings.delete(node)
    return
  }

  const surface = findSurface(node)
  const percentage = splitPercentages.get(surface) ?? DEFAULT_SPLIT_PERCENT
  const root = node.shadowRoot
  if (root == null) return
  const existingBinding = bindings.get(node)
  if (existingBinding != null) {
    existingBinding.syncHandle(percentage)
    return
  }
  let activePointer: number | null = null
  let activeHandle: HTMLElement | null = null
  let handle = createHandle(root, percentage)
  let pendingFrame: number | null = null
  let pendingValue = percentage
  // Where the drag started, so the divider follows the pointer instead of
  // teleporting under it: pressing 8px off centre used to snap the split there.
  let dragOrigin: {
    clientX: number
    percentage: number
    left: number
    width: number
  } | null = null

  const pointerValue = (event: PointerEvent): number => {
    if (dragOrigin == null) return DEFAULT_SPLIT_PERCENT
    if (!Number.isFinite(dragOrigin.width) || dragOrigin.width <= 0) {
      return splitPercentageFromPointer(event.clientX, dragOrigin.left, dragOrigin.width)
    }
    const delta = ((event.clientX - dragOrigin.clientX) / dragOrigin.width) * 100
    return dragOrigin.percentage + delta
  }

  const queuePointerValue = (event: PointerEvent): void => {
    pendingValue = pointerValue(event)
    if (pendingFrame != null) return
    pendingFrame = window.requestAnimationFrame(() => {
      pendingFrame = null
      applySplitPercentage(surface, pendingValue, dragOrigin?.width)
    })
  }

  const onPointerDown = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    const handle = eventHandle(event)
    if (handle == null || (pointerEvent.button !== 0 && pointerEvent.pointerType !== 'touch')) return

    event.preventDefault()
    const bounds = node.getBoundingClientRect()
    activePointer = pointerEvent.pointerId
    activeHandle = handle
    dragOrigin = {
      clientX: pointerEvent.clientX,
      percentage: splitPercentages.get(surface) ?? DEFAULT_SPLIT_PERCENT,
      left: bounds.left,
      width: bounds.width
    }
    pendingValue = dragOrigin.percentage
    handle.dataset.dragging = ''
    handle.setPointerCapture?.(pointerEvent.pointerId)
  }

  const onPointerMove = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (activePointer !== pointerEvent.pointerId) return
    event.preventDefault()
    queuePointerValue(pointerEvent)
  }

  const finishPointer = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (activePointer !== pointerEvent.pointerId) return
    if (activeHandle?.hasPointerCapture?.(pointerEvent.pointerId)) {
      activeHandle.releasePointerCapture(pointerEvent.pointerId)
    }
    activeHandle?.removeAttribute('data-dragging')
    if (event.type !== 'pointercancel') pendingValue = pointerValue(pointerEvent)
    if (pendingFrame != null) window.cancelAnimationFrame(pendingFrame)
    pendingFrame = null
    applySplitPercentage(surface, pendingValue)
    activePointer = null
    activeHandle = null
    dragOrigin = null
  }

  const onDoubleClick = (event: Event): void => {
    if (eventHandle(event) == null) return
    event.preventDefault()
    applySplitPercentage(surface, DEFAULT_SPLIT_PERCENT)
  }

  const onKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent
    if (eventHandle(event) == null) return

    const current = splitPercentages.get(surface) ?? DEFAULT_SPLIT_PERCENT
    const step = keyboardEvent.shiftKey ? LARGE_KEYBOARD_STEP : KEYBOARD_STEP
    const next = keyboardEvent.key === 'ArrowLeft'
      ? current - step
      : keyboardEvent.key === 'ArrowRight'
        ? current + step
        : keyboardEvent.key === 'Home'
          ? MIN_SPLIT_PERCENT
          : keyboardEvent.key === 'End'
            ? MAX_SPLIT_PERCENT
            : keyboardEvent.key === 'Enter'
              ? DEFAULT_SPLIT_PERCENT
              : null
    if (next == null) return

    event.preventDefault()
    applySplitPercentage(surface, next)
  }

  const onSplitResize = (event: Event): void => {
    const nextPercentage = (event as CustomEvent<number>).detail
    handle?.setAttribute('aria-valuenow', String(Math.round(nextPercentage)))
  }

  root.addEventListener('pointerdown', onPointerDown, true)
  root.addEventListener('pointermove', onPointerMove, true)
  root.addEventListener('pointerup', finishPointer, true)
  root.addEventListener('pointercancel', finishPointer, true)
  root.addEventListener('dblclick', onDoubleClick, true)
  root.addEventListener('keydown', onKeyDown, true)
  surface.addEventListener('kodi:split-resize', onSplitResize)

  bindings.set(node, {
    syncHandle: (nextPercentage) => {
      handle = createHandle(root, nextPercentage)
      handle?.setAttribute('aria-valuenow', String(Math.round(nextPercentage)))
    },
    teardown: () => {
      if (pendingFrame != null) window.cancelAnimationFrame(pendingFrame)
      root.removeEventListener('pointerdown', onPointerDown, true)
      root.removeEventListener('pointermove', onPointerMove, true)
      root.removeEventListener('pointerup', finishPointer, true)
      root.removeEventListener('pointercancel', finishPointer, true)
      root.removeEventListener('dblclick', onDoubleClick, true)
      root.removeEventListener('keydown', onKeyDown, true)
      surface.removeEventListener('kodi:split-resize', onSplitResize)
    }
  })
}
import { withResistance } from './rubberband'
