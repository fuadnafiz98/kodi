import { findInLine, isCaseSensitive, type ReviewMatch } from './reviewSearch'

const MATCH_HIGHLIGHT = 'kodi-review-find'
// NodeFilter.SHOW_TEXT, by value: the test DOM has no NodeFilter global.
const SHOW_TEXT = 4
const ACTIVE_HIGHLIGHT = 'kodi-review-find-active'

// Highlights paint ranges without touching the rows: no wrapper elements for
// the viewer to trip over when it re-renders a row, and nothing that can change
// a wrapped row's height (the review measures those). `::highlight()` rules do
// not cross a shadow boundary, so each file's shadow root gets its own copy.
const REVIEW_FIND_CSS = `
  ::highlight(${MATCH_HIGHLIGHT}) { background-color: rgba(234, 179, 8, 0.38); }
  ::highlight(${ACTIVE_HIGHLIGHT}) { background-color: rgba(249, 115, 22, 0.85); color: #fff; }
`

/** The drawn row a match belongs to, inside one file's shadow root. */
export function rowForMatch(root: ParentNode, match: Pick<ReviewMatch, 'side' | 'lineNumber'>): HTMLElement | null {
  const split = root.querySelector('[data-diff-type="split"]') != null
  for (const row of root.querySelectorAll<HTMLElement>(`[data-content] [data-line="${match.lineNumber}"]`)) {
    // A split diff draws each side in its own column; a unified one numbers a
    // deleted row by the old file and every other row by the new one.
    const onDeletionSide = split
      ? row.closest('[data-deletions]') != null
      : row.dataset.lineType === 'change-deletion'
    if (onDeletionSide === (match.side === 'deletions')) return row
  }
  return null
}

/** Ranges covering `[column, column + length)` of a row's text. */
export function rangeInRow(row: HTMLElement, column: number, length: number): Range | null {
  const walker = document.createTreeWalker(row, SHOW_TEXT)
  const range = document.createRange()
  let offset = 0
  let started = false
  const end = column + length
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
    const size = node.textContent?.length ?? 0
    if (!started && column < offset + size) {
      range.setStart(node, column - offset)
      started = true
    }
    if (started && end <= offset + size) {
      range.setEnd(node, end - offset)
      return range
    }
    offset += size
  }
  return null
}

export interface PaintedMatches {
  matches: Range[]
  active: Range | null
}

/**
 * Ranges for one file's drawn rows. Each row is searched again in its own text,
 * so a row the viewer drew differently from the model (a draft, a tab) still
 * gets marks where the text really is.
 */
export function rangesForItem(
  root: ParentNode,
  matches: readonly ReviewMatch[],
  query: string,
  active: ReviewMatch | null
): PaintedMatches {
  const caseSensitive = isCaseSensitive(query)
  const painted: PaintedMatches = { matches: [], active: null }
  const seenRows = new Set<HTMLElement>()
  for (const match of matches) {
    const row = rowForMatch(root, match)
    if (row == null || seenRows.has(row)) continue
    seenRows.add(row)
    const text = row.textContent ?? ''
    const activeHere = active != null && active.itemId === match.itemId && active.side === match.side
      && active.lineNumber === match.lineNumber
    for (const column of findInLine(text, query, caseSensitive)) {
      const range = rangeInRow(row, column, query.length)
      if (range == null) continue
      if (activeHere && column === active.column) painted.active = range
      else painted.matches.push(range)
    }
  }
  return painted
}

function ensureStyles(root: ShadowRoot): void {
  if (root.querySelector('style[data-kodi-review-find]') != null) return
  const style = document.createElement('style')
  style.dataset.kodiReviewFind = ''
  style.textContent = REVIEW_FIND_CSS
  root.append(style)
}

interface RenderedItem {
  id: string
  element: HTMLElement
}

/** Paints every drawn match in the review, replacing what was painted before. */
export function paintReviewFind(
  rendered: readonly RenderedItem[],
  matchesByItem: ReadonlyMap<string, readonly ReviewMatch[]>,
  query: string,
  active: ReviewMatch | null
): number {
  const highlights = typeof CSS === 'undefined' ? undefined : CSS.highlights
  if (highlights == null || typeof Highlight === 'undefined') return 0
  const all: Range[] = []
  let activeRange: Range | null = null
  for (const item of rendered) {
    const matches = matchesByItem.get(item.id)
    const root = item.element.shadowRoot
    if (matches == null || matches.length === 0 || root == null) continue
    ensureStyles(root)
    const painted = rangesForItem(root, matches, query, active)
    all.push(...painted.matches)
    if (painted.active != null) activeRange = painted.active
  }
  highlights.set(MATCH_HIGHLIGHT, new Highlight(...all))
  if (activeRange == null) highlights.delete(ACTIVE_HIGHLIGHT)
  else highlights.set(ACTIVE_HIGHLIGHT, new Highlight(activeRange))
  return all.length + (activeRange == null ? 0 : 1)
}

export function clearReviewFind(): void {
  if (typeof CSS === 'undefined' || CSS.highlights == null) return
  CSS.highlights.delete(MATCH_HIGHLIGHT)
  CSS.highlights.delete(ACTIVE_HIGHLIGHT)
}

/**
 * True when the viewer redrew a painted row: its range either lost its nodes
 * or, when the row's text was replaced in place (the highlighted tokens
 * arriving), collapsed to nothing. Time to repaint.
 */
export function paintIsStale(): boolean {
  if (typeof CSS === 'undefined' || CSS.highlights == null) return false
  for (const name of [MATCH_HIGHLIGHT, ACTIVE_HIGHLIGHT]) {
    const highlight = CSS.highlights.get(name)
    if (highlight == null) continue
    for (const range of highlight) {
      if ((range as Range).collapsed || !(range as Range).startContainer.isConnected) return true
    }
  }
  return false
}
