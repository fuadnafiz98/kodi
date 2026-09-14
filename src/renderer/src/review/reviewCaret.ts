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

interface ReviewCaretBinding {
  root: ShadowRoot
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
  if (path.some((node) => node instanceof HTMLElement && (
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

export function syncReviewCaretLifecycle(node: HTMLElement, phase: string): void {
  if (phase === 'unmount') {
    const binding = bindings.get(node)
    if (binding != null && visibleCaret?.root === binding.root) hideReviewCaret()
    binding?.teardown()
    bindings.delete(node)
    return
  }
  const existingBinding = bindings.get(node)
  if (existingBinding != null) {
    // A diff update can replace or move the text under the fixed-position caret.
    if (phase === 'update' && visibleCaret?.root === existingBinding.root) hideReviewCaret()
    return
  }
  if (node.shadowRoot == null) return

  const root = node.shadowRoot
  const onClick = (event: Event): void => {
    const mouseEvent = event as MouseEvent
    if (mouseEvent.button !== 0 || mouseEvent.detail > 1) return
    const line = clickedCodeLine(event)
    const selection = window.getSelection()
    if (line == null || (selection != null && !selection.isCollapsed)) return
    const range = caretRangeFromPoint(root, mouseEvent.clientX, mouseEvent.clientY)
    if (range == null || !line.contains(range.startContainer)) return
    showReviewCaret(root, line, caretBounds(range, line))
  }

  root.addEventListener('click', onClick)
  bindings.set(node, {
    root,
    teardown: () => root.removeEventListener('click', onClick)
  })
}
