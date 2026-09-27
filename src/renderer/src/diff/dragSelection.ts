import type { SelectedLineRange } from '@pierre/diffs'

export const DRAG_SELECTION_CSS = `
  /* Tint through Pierre's mix variables so added/removed greens stay visible.
     A solid background !important is what turned the selection into mud. */
  [data-drag-range] {
    --diffs-computed-hovered-line-bg: color-mix(
      in srgb,
      var(--diffs-computed-diff-line-bg, transparent) 82%,
      var(--accent)
    );
    --diffs-line-bg: var(--diffs-computed-hovered-line-bg);
  }

  [data-gutter] [data-drag-range],
  [data-gutter] [data-selected-line] {
    position: relative;
  }

  [data-gutter] [data-drag-range]::after,
  [data-gutter] [data-selected-line]::after {
    content: "";
    position: absolute;
    z-index: 2;
    top: 0;
    right: 0;
    bottom: 0;
    width: 2px;
    background: var(--accent);
    pointer-events: none;
  }

`

interface DragLine {
  index: number
  lineNumber: number
  lineSide: 'additions' | 'deletions'
}

export interface DragLineGeometry extends DragLine {
  top: number
  bottom: number
}

interface DragLineCell extends DragLine {
  element: HTMLElement
}

interface DragLineBounds {
  top: number
  bottom: number
}

interface DragGuideState {
  code: HTMLElement
  start: DragLine
  current: DragLine
  /** Gutter cells in document order, which is also their top-to-bottom order. */
  cells: DragLineCell[]
  /** Bounds read so far, by position in `cells`. A scroll moves every row, so it empties this. */
  bounds: Array<DragLineBounds | undefined>
  elementsByIndex: Map<number, HTMLElement[]>
  renderedRange: { first: number; last: number } | null
  /** The viewer re-rendered the item, so `cells` may hold detached rows. */
  rowsStale: boolean
  moved: boolean
  pointerId: number
  captureTarget: HTMLElement
}

interface DragGuideBinding {
  onRangeSelected(range: SelectedLineRange): void
  invalidateGeometry(): void
  teardown(): void
}

const dragGuideBindings = new WeakMap<HTMLElement, DragGuideBinding>()

/** Pierre's own rule: the pane's side wins, and without a pane (unified, file
   view) the line's own type speaks — context reads as additions there. */
function lineSideFor(element: HTMLElement, paneSide: 'additions' | 'deletions' | null): 'additions' | 'deletions' {
  if (paneSide != null) return paneSide
  return element.getAttribute('data-line-type') === 'change-deletion' ? 'deletions' : 'additions'
}

/**
 * The rows a drag can land on, without reading any layout. Measuring happens
 * later and only where the pointer's binary search probes: a scroll moves every
 * row, and re-measuring them all made each pointermove of a scrolling drag one
 * layout read per rendered row. Gutter cells are laid out in document order, so
 * that order stands in for the sort by top this used to need.
 */
export function collectDragLines(code: HTMLElement): {
  cells: DragLineCell[]
  elementsByIndex: Map<number, HTMLElement[]>
} {
  const paneSide = code.hasAttribute('data-deletions')
    ? 'deletions' as const
    : code.hasAttribute('data-additions') ? 'additions' as const : null
  const cells: DragLineCell[] = []
  for (const element of code.querySelectorAll<HTMLElement>('[data-gutter] [data-column-number]')) {
    const index = Number(element.dataset.lineIndex?.split(',')[0])
    const lineNumber = Number(element.dataset.columnNumber)
    if (!Number.isFinite(index) || !Number.isFinite(lineNumber)) continue
    cells.push({ index, lineNumber, lineSide: lineSideFor(element, paneSide), element })
  }

  const elementsByIndex = new Map<number, HTMLElement[]>()
  for (const element of code.querySelectorAll<HTMLElement>('[data-line-index]')) {
    const index = Number(element.dataset.lineIndex?.split(',')[0])
    if (!Number.isFinite(index)) continue
    const elements = elementsByIndex.get(index)
    if (elements == null) elementsByIndex.set(index, [element])
    else elements.push(element)
  }
  return { cells, elementsByIndex }
}

/** The code column a utility-button press began in — a side pane in a split
   diff, the single column in a unified diff or file view. Slotted buttons live
   in the light DOM, where closest() stops at the shadow boundary; the event's
   composed path still carries the shadow-side ancestors. */
export function codeFromEventPath(path: readonly (EventTarget | null | undefined)[]): HTMLElement | null {
  return path.find((target): target is HTMLElement =>
    target instanceof HTMLElement && target.hasAttribute('data-code')
  ) ?? null
}

/**
 * The position of the row whose center is nearest `pointerY`, among `count` rows
 * ordered top to bottom. `boundsAt` is only asked for the rows the search probes,
 * about two per halving, so callers can read layout lazily.
 */
export function findClosestDragLinePosition(
  count: number,
  boundsAt: (position: number) => DragLineBounds,
  pointerY: number
): number | null {
  if (count === 0) return null
  const centerAt = (position: number): number => {
    const bounds = boundsAt(position)
    return bounds.top + (bounds.bottom - bounds.top) / 2
  }
  let low = 0
  let high = count
  while (low < high) {
    const middle = (low + high) >>> 1
    if (centerAt(middle) < pointerY) low = middle + 1
    else high = middle
  }
  if (low === 0) return 0
  if (low === count) return count - 1
  return pointerY - centerAt(low - 1) <= centerAt(low) - pointerY ? low - 1 : low
}

export function findClosestDragLine<T extends DragLineGeometry>(
  lines: readonly T[],
  pointerY: number
): T | null {
  const position = findClosestDragLinePosition(lines.length, (index) => lines[index]!, pointerY)
  return position == null ? null : lines[position]!
}

function closestDragCell(
  cells: readonly DragLineCell[],
  bounds: Array<DragLineBounds | undefined>,
  pointerY: number
): DragLineCell | null {
  const position = findClosestDragLinePosition(cells.length, (index) => {
    const cached = bounds[index]
    if (cached != null) return cached
    const rect = cells[index]!.element.getBoundingClientRect()
    const measured = { top: rect.top, bottom: rect.bottom }
    bounds[index] = measured
    return measured
  }, pointerY)
  return position == null ? null : cells[position]!
}

function renderDragGuide(drag: DragGuideState, endIndex: number): void {
  const startIndex = drag.start.index
  const firstIndex = Math.min(startIndex, endIndex)
  const lastIndex = Math.max(startIndex, endIndex)
  // Only rows inside the new range or the previous one can change, so the walk
  // covers those instead of every rendered row.
  const walkFirst = Math.min(firstIndex, drag.renderedRange?.first ?? firstIndex)
  const walkLast = Math.max(lastIndex, drag.renderedRange?.last ?? lastIndex)

  for (let index = walkFirst; index <= walkLast; index += 1) {
    const elements = drag.elementsByIndex.get(index)
    if (elements == null) continue
    const boundary = index < firstIndex || index > lastIndex
      ? null
      : firstIndex === lastIndex
        ? 'single'
        : index === firstIndex
          ? 'first'
          : index === lastIndex
            ? 'last'
            : ''
    const wasInRange = drag.renderedRange != null
      && index >= drag.renderedRange.first
      && index <= drag.renderedRange.last
    if (boundary == null && !wasInRange) continue
    for (const element of elements) {
      if (boundary == null) {
        if (element.hasAttribute('data-drag-range')) element.removeAttribute('data-drag-range')
      } else if (element.getAttribute('data-drag-range') !== boundary) {
        element.setAttribute('data-drag-range', boundary)
      }
    }
  }
  drag.renderedRange = { first: firstIndex, last: lastIndex }
}

function clearDragGuide(root: ShadowRoot): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-drag-range]')) {
    element.removeAttribute('data-drag-range')
  }
}

export function syncDragGuideLifecycle(
  node: HTMLElement,
  phase: string,
  onRangeSelected: (range: SelectedLineRange) => void
): void {
  if (phase === 'unmount') {
    dragGuideBindings.get(node)?.teardown()
    dragGuideBindings.delete(node)
    return
  }
  const existingBinding = dragGuideBindings.get(node)
  if (existingBinding != null) {
    existingBinding.onRangeSelected = onRangeSelected
    if (phase === 'update') existingBinding.invalidateGeometry()
    return
  }
  if (node.shadowRoot == null) return

  const root = node.shadowRoot
  let drag: DragGuideState | null = null
  let suppressClick = false
  const binding: DragGuideBinding = {
    onRangeSelected,
    invalidateGeometry: () => {
      if (drag != null) drag.rowsStale = true
    },
    teardown: () => undefined
  }

  const refreshRows = (current: DragGuideState): boolean => {
    const collected = collectDragLines(current.code)
    if (collected.cells.length === 0) return false
    current.cells = collected.cells
    current.bounds = []
    current.elementsByIndex = collected.elementsByIndex
    current.rowsStale = false
    return true
  }

  const onPointerDown = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    const path = pointerEvent.composedPath()
    const utilityButton = path.find(
      (target): target is HTMLElement => target instanceof HTMLElement && target.hasAttribute('data-utility-button')
    )
    if (utilityButton == null) return

    const code = codeFromEventPath(path)
    if (code == null) return
    const { cells, elementsByIndex } = collectDragLines(code)
    const bounds: Array<DragLineBounds | undefined> = []
    const start = closestDragCell(cells, bounds, pointerEvent.clientY)
    if (start == null) return

    drag = {
      code,
      start,
      current: start,
      cells,
      bounds,
      elementsByIndex,
      renderedRange: null,
      rowsStale: false,
      moved: false,
      pointerId: pointerEvent.pointerId,
      captureTarget: utilityButton
    }
    utilityButton.setPointerCapture?.(pointerEvent.pointerId)
    renderDragGuide(drag, start.index)
  }

  const onPointerMove = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (drag == null || pointerEvent.pointerId !== drag.pointerId) return
    if (drag.rowsStale && !refreshRows(drag)) return
    const current = closestDragCell(drag.cells, drag.bounds, pointerEvent.clientY)
    if (current == null) return

    pointerEvent.preventDefault()
    drag.current = current
    drag.moved ||= current.index !== drag.start.index
    renderDragGuide(drag, current.index)
  }

  const onPointerUp = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (drag == null || pointerEvent.pointerId !== drag.pointerId) return
    const completedDrag = drag
    drag = null
    if (completedDrag.captureTarget.hasPointerCapture?.(completedDrag.pointerId)) {
      completedDrag.captureTarget.releasePointerCapture(completedDrag.pointerId)
    }

    if (completedDrag.moved) {
      suppressClick = true
      event.preventDefault()
      event.stopImmediatePropagation()
      const [start, end] = completedDrag.start.lineNumber <= completedDrag.current.lineNumber
        ? [completedDrag.start, completedDrag.current]
        : [completedDrag.current, completedDrag.start]
      binding.onRangeSelected({
        start: start.lineNumber,
        end: end.lineNumber,
        side: start.lineSide,
        endSide: end.lineSide
      })
      window.setTimeout(() => { suppressClick = false }, 0)
    }

    window.requestAnimationFrame(() => clearDragGuide(root))
  }

  const onPointerCancel = (event: Event): void => {
    const pointerEvent = event as PointerEvent
    if (drag == null || pointerEvent.pointerId !== drag.pointerId) return
    drag = null
    window.requestAnimationFrame(() => clearDragGuide(root))
  }

  const onClick = (event: Event): void => {
    if (!suppressClick) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  const cancelActiveDrag = (): void => {
    if (drag == null) return
    if (drag.captureTarget.hasPointerCapture?.(drag.pointerId)) {
      drag.captureTarget.releasePointerCapture(drag.pointerId)
    }
    drag = null
    clearDragGuide(root)
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || drag == null) return
    event.preventDefault()
    event.stopImmediatePropagation()
    cancelActiveDrag()
  }

  const scrollContainer = node.closest<HTMLElement>('.multi-file-code-view, .diff-scroll')
  // A scroll leaves the rows in place and moves them all, so only the bounds
  // read so far go; the next move re-reads the few rows its search probes.
  const onScroll = (): void => {
    if (drag != null) drag.bounds = []
  }

  root.addEventListener('pointerdown', onPointerDown, true)
  root.addEventListener('pointermove', onPointerMove, true)
  root.addEventListener('pointerup', onPointerUp, true)
  root.addEventListener('pointercancel', onPointerCancel, true)
  root.addEventListener('click', onClick, true)
  window.addEventListener('keydown', onKeyDown, true)
  scrollContainer?.addEventListener('scroll', onScroll, { passive: true })

  binding.teardown = () => {
    root.removeEventListener('pointerdown', onPointerDown, true)
    root.removeEventListener('pointermove', onPointerMove, true)
    root.removeEventListener('pointerup', onPointerUp, true)
    root.removeEventListener('pointercancel', onPointerCancel, true)
    root.removeEventListener('click', onClick, true)
    window.removeEventListener('keydown', onKeyDown, true)
    scrollContainer?.removeEventListener('scroll', onScroll)
    cancelActiveDrag()
  }
  dragGuideBindings.set(node, binding)
}
