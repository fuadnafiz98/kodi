import './definitionNavigation.css'

import type { DefinitionCandidate } from '../../../shared/contracts'
import type { DefinitionNavigation, DefinitionOpeners } from './definitionTrigger'

/**
 * ⌘ over code underlines the identifier under the pointer; ⌘-click lists where
 * it is likely declared (ripgrep in main, see `definitionSearch.ts`). The
 * underline and the popover are elements of their own above the review, never
 * inside the viewer's rows: a span wrapped around a token would be the
 * viewer's DOM changing under its editor and its drag selection.
 */

const WORD = /[$\p{ID_Continue}]/u

export interface IdentifierHit {
  identifier: string
  /** The identifier's characters on screen. */
  range: Range
  path: string | null
}

interface CodeLine {
  line: HTMLElement
  root: ShadowRoot | Document
}

/** Read during the event's dispatch: `composedPath()` is empty afterwards. */
function codeLineAt(event: MouseEvent): CodeLine | null {
  const path = event.composedPath()
  if (path.some((node) => node instanceof HTMLElement && (
    node.isContentEditable ||
    node.hasAttribute('data-gutter') ||
    node.hasAttribute('data-annotation-content') ||
    node.matches('button, input, textarea, select, a')
  ))) return null
  if (!path.some((node) => node instanceof HTMLElement && node.hasAttribute('data-content'))) return null
  const line = path.find((node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute('data-line-index'))
  if (line == null) return null
  return { line, root: line.getRootNode() as ShadowRoot | Document }
}

function caretAt(root: ShadowRoot | Document, x: number, y: number): { node: Node; offset: number } | null {
  const position = document.caretPositionFromPoint(x, y, 'host' in root ? { shadowRoots: [root] } : undefined)
  if (position != null) return { node: position.offsetNode, offset: position.offset }
  const range = document.caretRangeFromPoint(x, y)
  return range == null ? null : { node: range.startContainer, offset: range.startOffset }
}

function textNodes(line: HTMLElement): Text[] {
  const nodes: Text[] = []
  const visit = (node: Node): void => {
    if (node.nodeType === 3) nodes.push(node as Text)
    else for (const child of node.childNodes) visit(child)
  }
  visit(line)
  return nodes
}

function pointAt(nodes: readonly Text[], offset: number): { node: Text; offset: number } | null {
  let start = 0
  for (const node of nodes) {
    const end = start + node.data.length
    if (offset <= end) return { node, offset: offset - start }
    start = end
  }
  return null
}

/** The word around `offset` in `text`, or null on punctuation, space or a number. */
export function identifierAround(text: string, offset: number): { start: number; end: number } | null {
  let start = offset
  let end = offset
  while (start > 0 && WORD.test(text.charAt(start - 1))) start -= 1
  while (end < text.length && WORD.test(text.charAt(end))) end += 1
  if (start === end || /^\d/.test(text.charAt(start))) return null
  return { start, end }
}

function filePathFor(line: HTMLElement, root: ShadowRoot | Document, fallback: string | null): string | null {
  const title = root.querySelector('[data-title]')?.textContent?.trim()
  if (title != null && title !== '') return title
  return line.closest('[data-item-path]')?.getAttribute('data-item-path') ?? fallback
}

export function identifierAt(event: MouseEvent, fallbackPath: string | null): IdentifierHit | null {
  const found = codeLineAt(event)
  return found == null ? null : identifierInLine(found, event.clientX, event.clientY, fallbackPath)
}

function identifierInLine(found: CodeLine, x: number, y: number, fallbackPath: string | null): IdentifierHit | null {
  if (!found.line.isConnected) return null
  const caret = caretAt(found.root, x, y)
  if (caret == null || !found.line.contains(caret.node)) return null
  const nodes = textNodes(found.line)
  let offset = 0
  for (const node of nodes) {
    if (node === caret.node) {
      offset += caret.offset
      break
    }
    offset += node.data.length
  }
  const text = nodes.map((node) => node.data).join('')
  const word = identifierAround(text, offset)
  if (word == null) return null
  const start = pointAt(nodes, word.start)
  const end = pointAt(nodes, word.end)
  if (start == null || end == null) return null
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset)
  // The caret lands at the nearest character even past the line's end.
  const bounds = range.getBoundingClientRect()
  if (x < bounds.left - 2 || x > bounds.right + 2) return null
  return { identifier: text.slice(word.start, word.end), range, path: filePathFor(found.line, found.root, fallbackPath) }
}

function hasTextSelection(): boolean {
  const selection = document.getSelection()
  return selection != null && !selection.isCollapsed && selection.toString() !== ''
}

const KIND_LABEL: Record<DefinitionCandidate['kind'], string> = {
  function: 'function',
  class: 'class',
  interface: 'interface',
  type: 'type',
  variable: 'variable'
}

export function createDefinitionNavigation(openersOf: () => DefinitionOpeners | null): DefinitionNavigation {
  let metaDown = false
  let pointer: { x: number; y: number; line: CodeLine | null } | null = null
  let frame = 0
  let popover: HTMLElement | null = null
  let request = 0

  const underline = document.createElement('div')
  underline.className = 'definition-underline'
  underline.setAttribute('aria-hidden', 'true')

  const hideUnderline = (): void => {
    underline.remove()
  }

  const paint = (): void => {
    frame = 0
    if (!metaDown || pointer?.line == null || hasTextSelection()) {
      hideUnderline()
      return
    }
    const hit = identifierInLine(pointer.line, pointer.x, pointer.y, null)
    if (hit == null) {
      hideUnderline()
      return
    }
    const bounds = hit.range.getBoundingClientRect()
    underline.style.left = `${bounds.left}px`
    underline.style.top = `${bounds.bottom - 1}px`
    underline.style.width = `${bounds.width}px`
    if (underline.parentNode == null) document.body.append(underline)
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (!event.metaKey) {
      metaChanged(false)
      return
    }
    pointer = { x: event.clientX, y: event.clientY, line: codeLineAt(event) }
    if (frame === 0) frame = requestAnimationFrame(paint)
  }

  const closePopover = (): void => {
    request += 1
    popover?.remove()
    popover = null
    window.removeEventListener('pointerdown', onOutside, true)
    window.removeEventListener('keydown', onPopoverKey, true)
  }

  const onOutside = (event: PointerEvent): void => {
    if (popover != null && event.composedPath().includes(popover)) return
    closePopover()
  }

  const rows = (): HTMLButtonElement[] => popover == null ? [] : [...popover.querySelectorAll<HTMLButtonElement>('[data-definition-jump]')]

  const onPopoverKey = (event: KeyboardEvent): void => {
    if (popover == null) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closePopover()
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const list = rows()
    if (list.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'ArrowDown' ? (index + 1) % list.length : (index - 1 + list.length) % list.length
    list[next]?.focus()
  }

  const showPopover = (hit: IdentifierHit): void => {
    closePopover()
    const ticket = ++request
    const bounds = hit.range.getBoundingClientRect()
    const element = document.createElement('div')
    element.className = 'definition-popover'
    element.setAttribute('role', 'dialog')
    element.setAttribute('aria-label', `Definitions of ${hit.identifier}`)
    element.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - 428))}px`
    const below = bounds.bottom + 4
    if (below + 240 > window.innerHeight && bounds.top > 260) element.style.bottom = `${window.innerHeight - bounds.top + 4}px`
    else element.style.top = `${below}px`
    const status = document.createElement('p')
    status.className = 'definition-popover-status'
    status.textContent = `Finding ${hit.identifier}…`
    element.append(status)
    document.body.append(element)
    popover = element
    window.addEventListener('pointerdown', onOutside, true)
    window.addEventListener('keydown', onPopoverKey, true)

    const repository = window.repository
    if (repository == null || hit.path == null) {
      status.textContent = 'Open a file in a repository first.'
      return
    }
    repository.findDefinitions(hit.identifier, hit.path).then((candidates) => {
      if (ticket !== request || popover !== element) return
      if (candidates.length === 0) {
        status.textContent = `No definition of ${hit.identifier} found.`
        return
      }
      status.remove()
      const head = document.createElement('div')
      head.className = 'definition-popover-head'
      const name = document.createElement('code')
      name.textContent = hit.identifier
      head.append(name, ` · ${candidates.length} ${candidates.length === 1 ? 'definition' : 'definitions'}`)
      element.append(head)
      const list = document.createElement('ul')
      for (const candidate of candidates) list.append(candidateRow(candidate))
      element.append(list)
      rows()[0]?.focus()
    }, () => {
      if (ticket === request && popover === element) status.textContent = 'The search failed.'
    })
  }

  const candidateRow = (candidate: DefinitionCandidate): HTMLLIElement => {
    const item = document.createElement('li')
    const jump = document.createElement('button')
    jump.type = 'button'
    jump.dataset.definitionJump = `${candidate.path}:${candidate.line}`
    const location = document.createElement('span')
    location.className = 'definition-location'
    const slash = candidate.path.lastIndexOf('/')
    const file = document.createElement('strong')
    file.textContent = candidate.path.slice(slash + 1)
    const where = document.createElement('span')
    where.textContent = `${slash === -1 ? '' : `${candidate.path.slice(0, slash)}/`}`
    const line = document.createElement('span')
    line.className = 'definition-line'
    line.textContent = `:${candidate.line}`
    location.append(where, file, line)
    const kind = document.createElement('span')
    kind.className = 'definition-kind'
    kind.textContent = KIND_LABEL[candidate.kind]
    const preview = document.createElement('code')
    preview.textContent = candidate.preview
    jump.append(location, kind, preview)
    jump.addEventListener('click', () => {
      closePopover()
      openersOf()?.openFile(candidate.path, candidate.line)
    })
    const editor = document.createElement('button')
    editor.type = 'button'
    editor.className = 'definition-editor'
    editor.textContent = 'Open in editor'
    editor.title = 'Open in your editor'
    editor.setAttribute('aria-label', `Open ${candidate.path}:${candidate.line} in editor`)
    editor.addEventListener('click', () => {
      closePopover()
      openersOf()?.openInEditor(candidate.path, candidate.line)
    })
    item.append(jump, editor)
    return item
  }

  let clickGuard: ((click: MouseEvent) => void) | null = null
  let clickGuardTimer = 0
  const releaseClickGuard = (): void => {
    if (clickGuard != null) window.removeEventListener('click', clickGuard, true)
    clickGuard = null
    clearTimeout(clickGuardTimer)
  }
  const swallowClick = (pressedAt: number): void => {
    releaseClickGuard()
    clickGuard = (click: MouseEvent): void => {
      releaseClickGuard()
      if (click.timeStamp - pressedAt > 1_000) return
      if (popover != null && click.composedPath().includes(popover)) return
      click.preventDefault()
      click.stopPropagation()
    }
    window.addEventListener('click', clickGuard, true)
    clickGuardTimer = window.setTimeout(releaseClickGuard, 1_000)
  }

  // A ⌘-click on an identifier is ours: the viewer must not start a selection
  // or move its caret, so the press and its click stop here.
  const onPointerDown = (event: PointerEvent): void => {
    if (!event.metaKey || event.button !== 0 || event.shiftKey || event.altKey || event.ctrlKey) return
    if (popover != null && event.composedPath().includes(popover)) return
    const hit = identifierAt(event, openersOf()?.currentPath() ?? null)
    if (hit == null) return
    event.preventDefault()
    event.stopPropagation()
    // The press's own click follows its release at once; a click later than
    // that is someone else's and must get through.
    swallowClick(event.timeStamp)
    hideUnderline()
    showPopover(hit)
  }

  const onScroll = (): void => hideUnderline()
  const onBlur = (): void => metaChanged(false)

  function metaChanged(down: boolean): void {
    if (down === metaDown) return
    metaDown = down
    if (down) {
      window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
      window.addEventListener('scroll', onScroll, { capture: true, passive: true })
      window.addEventListener('blur', onBlur)
      return
    }
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('blur', onBlur)
    if (frame !== 0) cancelAnimationFrame(frame)
    frame = 0
    pointer = null
    hideUnderline()
  }

  // Clicks are heard all the time once the chunk is here (one cheap check);
  // the pointer only while ⌘ is down.
  window.addEventListener('pointerdown', onPointerDown, true)
  return {
    metaChanged,
    dispose() {
      metaChanged(false)
      closePopover()
      releaseClickGuard()
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }
}
