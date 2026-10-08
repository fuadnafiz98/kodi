import type { CodeView, CodeViewItem } from '@pierre/diffs'

import type { ReviewFindSource } from './reviewFindSource'
import {
  carryActiveIndex,
  nextMatchIndex,
  searchReviewItems,
  type ReviewMatch
} from './reviewSearch'
import { clearReviewFind, paintIsStale, paintReviewFind } from './reviewSearchHighlights'

export interface ReviewFindState {
  /** 0-based; -1 when nothing matches. */
  active: number
  total: number
  truncated: boolean
}

// Changes the panel cannot be told about: a page of the review landing, an
// agent rewriting a file, the reader switching tabs or views.
const WATCH_MS = 250
// While the reader scrolls, rows arrive and leave; repaint at most this often.
const SCROLL_REPAINT_MS = 90
// A collapsed file opens over a few frames before its lines can be scrolled to.
const EXPAND_WAIT_FRAMES = 30

declare global {
  interface Window {
    /** Set to an array by an e2e probe: the controller then logs what it does. */
    __kodiReviewFindTrace?: unknown[]
  }
}

function trace(event: string, detail?: unknown): void {
  window.__kodiReviewFindTrace?.push([Math.round(performance.now()), event, detail])
}

function isOnScreen(element: HTMLElement | undefined): boolean {
  if (element == null || !element.isConnected) return false
  if (typeof element.checkVisibility === 'function') return element.checkVisibility()
  return element.getClientRects().length > 0
}

/** The mounted review the reader is looking at, if the current view is one. */
export function visibleReviewSource(): ReviewFindSource | null {
  for (const source of window.__kodiReviewFind ?? []) {
    if (isOnScreen(source.viewer()?.getContainerElement())) return source
  }
  return null
}

function showsUnchangedLines(viewer: CodeView<unknown>): boolean {
  return (viewer as unknown as { options?: { expandUnchanged?: boolean } }).options?.expandUnchanged === true
}

/**
 * ⌘F over a multi-file review: searches the diff model of every file (drawn
 * or not, collapsed or not), paints the drawn matches, and moves between them —
 * opening a collapsed file and scrolling the viewer to the line.
 */
export class ReviewFindController {
  private query = ''
  private source: ReviewFindSource | null = null
  private items: readonly CodeViewItem<unknown>[] | null = null
  private matches: ReviewMatch[] = []
  private byItem = new Map<string, ReviewMatch[]>()
  private active = -1
  private truncated = false
  private watchTimer = 0
  private repaintTimer = 0
  private unsubscribeScroll: (() => void) | null = null
  // The viewer redraws a row in place (its highlighted tokens arriving, a
  // hydration): the painted ranges collapse, so a redraw schedules a repaint.
  private readonly redraws = new MutationObserver(() => this.repaintNextFrame())
  private redrawFrame = 0
  private observed = new WeakSet<ShadowRoot>()
  private moveToken = 0

  constructor(private readonly onChange: (state: ReviewFindState | null) => void) {}

  /** True when the current view is a review this controller can search. */
  get available(): boolean {
    return visibleReviewSource() != null
  }

  /** Searches for `query` and brings its first match from the reader's place on screen. */
  setQuery(query: string): void {
    const fresh = this.matches.length === 0
    this.query = query
    this.research(true, fresh)
    this.watch()
    if (query !== '') void this.reveal(this.matches[this.active])
  }

  /** Moves to the next (or previous) match and brings it on screen. */
  move(forward: boolean): void {
    if (this.matches.length === 0) return
    this.active = nextMatchIndex(this.matches.length, this.active, forward)
    this.publish()
    void this.reveal(this.matches[this.active])
  }

  /** Stops watching and removes every mark. */
  clear(): void {
    window.clearInterval(this.watchTimer)
    window.clearTimeout(this.repaintTimer)
    window.cancelAnimationFrame(this.redrawFrame)
    this.watchTimer = 0
    this.repaintTimer = 0
    this.redrawFrame = 0
    this.unsubscribeScroll?.()
    this.unsubscribeScroll = null
    this.redraws.disconnect()
    this.observed = new WeakSet()
    this.moveToken += 1
    this.source = null
    this.items = null
    this.matches = []
    this.byItem = new Map()
    this.active = -1
    clearReviewFind()
  }

  private viewer(): CodeView<unknown> | null {
    return this.source?.viewer() ?? null
  }

  /**
   * Where a new search starts: the file at the top of the screen, so the first
   * match is the next one down from what the reader is looking at.
   */
  private readingPlace(viewer: CodeView<unknown> | null): ReviewMatch | null {
    if (viewer == null) return null
    // The scroller's own offset: `getScrollTop()` consumes the viewer's
    // pending scroll state, and calling it from outside made scrolling drift.
    const top = (viewer as unknown as { root?: HTMLElement | null }).root?.scrollTop ?? 0
    let current: string | null = null
    let currentTop = -Infinity
    for (const item of viewer.getRenderedItems()) {
      const itemTop = viewer.getTopForItem(item.id)
      if (itemTop != null && itemTop <= top + 1 && itemTop > currentTop) {
        current = item.id
        currentTop = itemTop
      }
    }
    return current == null ? null : { itemId: current, side: 'additions', lineNumber: 0, column: 0, length: 0 }
  }

  private research(keepPlace: boolean, fromReadingPlace = false): void {
    const source = visibleReviewSource()
    if (source !== this.source) {
      this.unsubscribeScroll?.()
      this.unsubscribeScroll = source?.viewer()?.subscribeToScroll(() => this.scheduleRepaint()) ?? null
      this.source = source
    }
    if (source == null || this.query === '') {
      this.items = source?.items() ?? null
      this.matches = []
      this.byItem = new Map()
      this.active = -1
      this.truncated = false
      clearReviewFind()
      this.publish()
      return
    }
    const viewer = this.viewer()
    const items = source.items()
    this.items = items
    // The viewer's copy of an item is what is on screen (a draft being typed).
    const shown = items.map((item) => viewer?.getItem(item.id) ?? item)
    const previous = fromReadingPlace
      ? this.readingPlace(viewer)
      : keepPlace ? this.matches[this.active] ?? null : null
    const result = searchReviewItems(shown, this.query, { includeUnchanged: viewer != null && showsUnchangedLines(viewer) })
    this.matches = result.matches
    this.truncated = result.truncated
    this.byItem = new Map()
    for (const match of result.matches) {
      const list = this.byItem.get(match.itemId)
      if (list == null) this.byItem.set(match.itemId, [match])
      else list.push(match)
    }
    this.active = carryActiveIndex(previous, result.matches, items.map((item) => item.id))
    this.publish()
    this.paint()
  }

  private watch(): void {
    if (this.watchTimer !== 0) return
    this.watchTimer = window.setInterval(() => {
      if (this.query === '') return
      const source = visibleReviewSource()
      if (source !== this.source || source?.items() !== this.items) {
        trace('research', { sourceChanged: source !== this.source })
        this.research(true)
        return
      }
      if (paintIsStale()) {
        trace('stale')
        this.paint()
      }
    }, WATCH_MS)
  }

  // A redraw collapsed the painted ranges under the reader's eyes: repaint
  // before the next frame, so a mark never blinks out.
  private repaintNextFrame(): void {
    if (this.redrawFrame !== 0 || this.matches.length === 0) return
    this.redrawFrame = window.requestAnimationFrame(() => {
      this.redrawFrame = 0
      this.paint()
    })
  }

  // While the reader scrolls, rows arrive and leave every frame; at most one
  // repaint per `SCROLL_REPAINT_MS` keeps that off the scroll path.
  private scheduleRepaint(): void {
    trace('schedule', { pending: this.repaintTimer !== 0, matches: this.matches.length })
    if (this.repaintTimer !== 0 || this.matches.length === 0) return
    this.repaintTimer = window.setTimeout(() => {
      this.repaintTimer = 0
      this.paint()
    }, SCROLL_REPAINT_MS)
  }

  private paint(): void {
    const viewer = this.viewer()
    if (viewer == null || this.matches.length === 0) {
      clearReviewFind()
      return
    }
    const rendered = viewer.getRenderedItems()
    for (const item of rendered) {
      const root = item.element.shadowRoot
      if (root == null || this.observed.has(root) || !this.byItem.has(item.id)) continue
      this.observed.add(root)
      this.redraws.observe(root, { childList: true, characterData: true, subtree: true })
    }
    const painted = paintReviewFind(rendered, this.byItem, this.query, this.matches[this.active] ?? null)
    trace('paint', { painted, rendered: rendered.length })
  }

  private publish(): void {
    this.onChange(this.source == null
      ? null
      : { active: this.active, total: this.matches.length, truncated: this.truncated })
  }

  private async reveal(match: ReviewMatch | undefined): Promise<void> {
    const viewer = this.viewer()
    const source = this.source
    if (match == null || viewer == null || source == null) return
    const token = ++this.moveToken
    if (viewer.getItem(match.itemId)?.collapsed === true) {
      source.expand(match.itemId)
      for (let frame = 0; frame < EXPAND_WAIT_FRAMES; frame += 1) {
        await new Promise((resolve) => window.requestAnimationFrame(resolve))
        if (token !== this.moveToken) return
        if (viewer.getItem(match.itemId)?.collapsed !== true) break
      }
    }
    viewer.scrollTo({
      type: 'line',
      id: match.itemId,
      lineNumber: match.lineNumber,
      side: match.side,
      align: 'center',
      behavior: 'instant'
    })
    // The line is drawn a frame or two after the scroll lands.
    for (let frame = 0; frame < 3; frame += 1) {
      await new Promise((resolve) => window.requestAnimationFrame(resolve))
      if (token !== this.moveToken) return
      this.paint()
    }
  }
}
