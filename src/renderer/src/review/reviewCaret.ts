import type { EditCaretPosition } from '../app/AppView'

export const REVIEW_CARET_CSS = `
  [data-content] [data-line-index]:not([data-separator]):not(:has([data-separator])) {
    cursor: text;
  }

  [data-review-caret] {
    width: 1px;
    position: absolute;
    z-index: 20;
    border-radius: 1px;
    corner-shape: squircle;
    background: var(--diffs-fg);
    pointer-events: none;
    animation: review-caret-blink 1.06s steps(1, end) infinite;
  }

  @keyframes review-caret-blink {
    50% { opacity: 0; }
  }

  @media (prefers-reduced-motion: reduce) {
    [data-review-caret] { animation: none; }
  }
`

/** Told where a click put the caret, when the line belongs to the working file. */
export type PlaceEditCaret = (position: EditCaretPosition) => void

interface ReviewCaretBinding {
  root: ShadowRoot
  /** The latest callback: bindings outlive renders, so it is refreshed on each one. */
  onPlace: PlaceEditCaret | undefined
  teardown(): void
}

interface VisibleCaret {
  element: HTMLElement
  root: ShadowRoot
  teardown(): void
}

const bindings = new WeakMap<HTMLElement, ReviewCaretBinding>()
let visibleCaret: VisibleCaret | null = null

function hideReviewCaret(): void {
  if (visibleCaret == null) return
  visibleCaret.teardown()
  visibleCaret.element.remove()
  visibleCaret = null
}

function caretRangeFromPoint(root: ShadowRoot, x: number, y: number): Range | null {
  const position = document.caretPositionFromPoint(x, y, { shadowRoots: [root] })
  if (position != null && position.offsetNode.getRootNode() === root) {
    const range = document.createRange()
    range.setStart(position.offsetNode, position.offset)
    range.collapse(true)
    return range
  }

  const range = document.caretRangeFromPoint(x, y)
  return range?.startContainer.getRootNode() === root ? range : null
}

function caretBounds(range: Range, line: HTMLElement): DOMRect {
  const bounds = range.getBoundingClientRect()
  if (bounds.height > 0) return bounds

  const lineBounds = line.getBoundingClientRect()
  return new DOMRect(bounds.x || lineBounds.left, lineBounds.top, 0, lineBounds.height)
}

function showReviewCaret(root: ShadowRoot, line: HTMLElement, bounds: DOMRect): void {
  hideReviewCaret()
  const lineBounds = line.getBoundingClientRect()
  const element = document.createElement('span')
  element.dataset.reviewCaret = 'true'
  element.setAttribute('aria-hidden', 'true')
  element.style.left = `${Math.round(bounds.x - lineBounds.left)}px`
  element.style.top = `${Math.round(bounds.y - lineBounds.top)}px`
  element.style.height = `${Math.max(1, Math.round(bounds.height))}px`
  line.append(element)

  const hide = (): void => hideReviewCaret()
  window.addEventListener('pointerdown', hide, true)
  window.addEventListener('keydown', hide, true)
  window.addEventListener('scroll', hide, true)
  window.addEventListener('resize', hide)
  window.addEventListener('blur', hide)
  visibleCaret = {
    element,
    root,
    teardown: () => {
      window.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('keydown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      window.removeEventListener('blur', hide)
    }
  }
}

function clickedCodeLine(event: Event): HTMLElement | null {
  const path = event.composedPath()
  // An attached editor draws and places its own caret.
  if (path.some((node) => node instanceof HTMLElement && (
    node.isContentEditable ||
    node.hasAttribute('data-gutter') ||
    node.hasAttribute('data-separator') ||
    node.hasAttribute('data-annotation-content') ||
    node.matches('button, input, textarea, select')
  ))) return null

  const inContent = path.some(
    (node) => node instanceof HTMLElement && node.hasAttribute('data-content')
  )
  if (!inContent) return null
  return path.find(
    (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute('data-line-index')
  ) ?? null
}

/**
 * The working-file position under a caret, or null for a line of the old file.
 * A split diff's deletions column numbers its context lines by the old file and
 * carries the new number as the alternate; everywhere else the line is the new
 * file's own.
 */
export function editCaretPosition(line: HTMLElement, range: Range): EditCaretPosition | null {
  if (line.dataset.lineType === 'change-deletion') return null
  const deletionsColumn = line.closest('code')?.hasAttribute('data-deletions') === true
  const lineNumber = Number(deletionsColumn ? line.dataset.altLine : line.dataset.line)
  if (!Number.isInteger(lineNumber) || lineNumber < 1) return null
  const prefix = document.createRange()
  prefix.setStart(line, 0)
  prefix.setEnd(range.startContainer, range.startOffset)
  return { lineNumber, character: prefix.toString().length }
}

export function syncReviewCaretLifecycle(node: HTMLElement, phase: string, onPlace?: PlaceEditCaret): void {
  if (phase === 'unmount') {
    const binding = bindings.get(node)
    if (binding != null && visibleCaret?.root === binding.root) hideReviewCaret()
    binding?.teardown()
    bindings.delete(node)
    return
  }
  const existingBinding = bindings.get(node)
  if (existingBinding != null) {
    existingBinding.onPlace = onPlace
    // A diff update can replace or move the text under the fixed-position caret.
    if (phase === 'update' && visibleCaret?.root === existingBinding.root) hideReviewCaret()
    return
  }
  if (node.shadowRoot == null) return

  const root = node.shadowRoot
  const binding: ReviewCaretBinding = {
    root,
    onPlace,
    teardown: () => root.removeEventListener('click', onClick)
  }
  const onClick = (event: Event): void => {
    const mouseEvent = event as MouseEvent
    if (mouseEvent.button !== 0 || mouseEvent.detail > 1) return
    const line = clickedCodeLine(event)
    const selection = window.getSelection()
    if (line == null || (selection != null && !selection.isCollapsed)) return
    const range = caretRangeFromPoint(root, mouseEvent.clientX, mouseEvent.clientY)
    if (range == null || !line.contains(range.startContainer)) return
    showReviewCaret(root, line, caretBounds(range, line))
    if (binding.onPlace == null) return
    const position = editCaretPosition(line, range)
    if (position != null) binding.onPlace(position)
  }

  root.addEventListener('click', onClick)
  bindings.set(node, binding)
}
