import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { CodeView, CodeViewItem } from '@pierre/diffs'
import {
  IconArrowUpRight,
  IconCheck,
  IconChevronSm,
  IconCopy,
  IconEllipsis,
  IconGear,
  IconRefresh,
  IconSparkles
} from '@pierre/icons'

import type { RepositoryReview } from '../../../shared/contracts'
import type { GuideFile, GuideSection, NormalizedGuide } from '../../../shared/reviewGuide'
import { formatGuideMarkdown } from './formatGuideMarkdown'
import { GuideAgentPicker } from './GuideAgentPicker'
import { resolveGuideRun, useGuideAgentChoice } from './guideAgentSettings'
import { guideHomeFiles, guideItemId, guideItemOrder, sectionLabel } from './guideOrder'
import type { GuideAgentContext, GuideItemOrder, ReviewGuideHost } from './reviewGuideHost'
import { reviewGuideStore, useGuideState, type GuideState } from './reviewGuideStore'
import './ReviewGuide.css'

/** The viewer handle the review hands over; only what the guide reads. */
export interface GuideViewerHandle {
  getInstance(): CodeView<unknown> | undefined
  scrollTo(target: unknown): void
  setSelectedLines(selection: unknown): void
  getItem(id: string): unknown
}

export interface ReviewGuideViewProps {
  worldId: string
  viewerRef: RefObject<GuideViewerHandle | null>
  /** The items the viewer shows, in the order it shows them. */
  items: readonly CodeViewItem<unknown>[]
  viewedPaths: ReadonlySet<string>
  repositoryReview: RepositoryReview | null
  fileCount: number
}

const READING_THROTTLE_MS = 90
const NARROW_WIDTH = 980
const COLUMN_WIDTH = 296
const MIN_COLUMN_WIDTH = 240
const MAX_COLUMN_WIDTH = 640
// The review keeps at least this much beside a dragged column.
const MIN_REVIEW_WIDTH = 480
const COLUMN_WIDTH_KEY = 'kodi:guide-column-width'

function storedColumnWidth(): number {
  try {
    const value = Number(localStorage.getItem(COLUMN_WIDTH_KEY))
    return Number.isFinite(value) && value >= MIN_COLUMN_WIDTH && value <= MAX_COLUMN_WIDTH ? value : COLUMN_WIDTH
  } catch {
    return COLUMN_WIDTH
  }
}

function saveColumnWidth(width: number): void {
  try {
    localStorage.setItem(COLUMN_WIDTH_KEY, String(Math.round(width)))
  } catch {
    // Private storage: the width lasts until the window closes.
  }
}

/**
 * The handle on the column's right edge: drag to widen or narrow it, arrows
 * step by 16 px, a double-click puts it back. The width is written to the
 * column directly while dragging and kept in state once the pointer lifts.
 */
function GuideColumnResizer({ columnRef, width, onWidth }: {
  columnRef: RefObject<HTMLElement | null>
  width: number
  onWidth(width: number): void
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false)
  const clamp = (value: number): number => {
    // A review not laid out yet (width 0) does not limit the column.
    const available = columnRef.current?.parentElement?.clientWidth ?? 0
    const room = available > 0 ? available - MIN_REVIEW_WIDTH : Infinity
    return Math.round(Math.min(Math.max(value, MIN_COLUMN_WIDTH), Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, room))))
  }
  return (
    <div className="guide-resizer" role="separator" aria-orientation="vertical" aria-label="Resize the walkthrough"
      aria-valuemin={MIN_COLUMN_WIDTH} aria-valuemax={MAX_COLUMN_WIDTH} aria-valuenow={width} tabIndex={0}
      data-dragging={dragging ? '' : undefined} data-guide-resizer=""
      onDoubleClick={() => onWidth(COLUMN_WIDTH)}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        onWidth(clamp(width + (event.key === 'ArrowRight' ? 16 : -16)))
      }}
      onPointerDown={(event) => {
        const column = columnRef.current
        if (event.button !== 0 || column == null) return
        event.preventDefault()
        const handle = event.currentTarget
        handle.setPointerCapture(event.pointerId)
        const startX = event.clientX
        const startWidth = column.offsetWidth
        let next = startWidth
        const review = column.parentElement
        review?.setAttribute('data-guide-resizing', '')
        setDragging(true)
        const move = (moveEvent: PointerEvent): void => {
          next = clamp(startWidth + moveEvent.clientX - startX)
          column.style.width = `${next}px`
        }
        const end = (): void => {
          handle.removeEventListener('pointermove', move)
          handle.removeEventListener('pointerup', end)
          handle.removeEventListener('pointercancel', end)
          review?.removeAttribute('data-guide-resizing')
          setDragging(false)
          onWidth(next)
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', end)
        handle.addEventListener('pointercancel', end)
      }} />
  )
}
const FAR_HUNK_LINE = 200

// One order object per guide, so the review's memo sees the same identity on
// every render until the guide itself is replaced.
const orders = new WeakMap<NormalizedGuide, GuideItemOrder>()
function orderFor(guide: NormalizedGuide): GuideItemOrder {
  let order = orders.get(guide)
  if (order == null) {
    order = guideItemOrder(guide)
    orders.set(guide, order)
  }
  return order
}

function host(): ReviewGuideHost | undefined {
  return window.__kodiReviewGuide
}

function subscribeHost(listener: () => void): () => void {
  return host()?.subscribe(listener) ?? (() => {})
}

function hostAgent(): GuideAgentContext | null {
  return host()?.agent ?? null
}

function useHostAgent(): GuideAgentContext | null {
  return useSyncExternalStore(subscribeHost, hostAgent, hostAgent)
}

function useHostOrder(worldId: string): GuideItemOrder | null {
  const read = (): GuideItemOrder | null => host()?.order(worldId) ?? null
  return useSyncExternalStore(subscribeHost, read, read)
}

function deepActiveElement(): Element | null {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement != null) active = active.shadowRoot.activeElement
  return active
}

function isTyping(element: Element | null): boolean {
  if (element == null) return false
  if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') return true
  return (element as HTMLElement).isContentEditable === true
}

// Never `getScrollTop()` from here: it consumes the viewer's pending scroll
// state, and a read between its frames made plain scrolling drift. The scroll
// listener hands over the viewer's own value; before the first one, the
// scroller's position is read without touching the viewer's state.
function restingScrollTop(viewer: CodeView<unknown>): number {
  return (viewer as unknown as { root?: HTMLElement | null }).root?.scrollTop ?? 0
}

/** The file at the top of the screen: the last one whose top is at or above it. */
function readingItemId(viewer: CodeView<unknown>, top: number): string | null {
  let current: string | null = null
  let currentTop = -Infinity
  let first: string | null = null
  let firstTop = Infinity
  for (const item of viewer.getRenderedItems()) {
    const itemTop = viewer.getTopForItem(item.id)
    if (itemTop == null) continue
    if (itemTop < firstTop) {
      first = item.id
      firstTop = itemTop
    }
    if (itemTop <= top + 1 && itemTop > currentTop) {
      current = item.id
      currentTop = itemTop
    }
  }
  return current ?? first
}

function readerAtTop(viewer: CodeView<unknown> | undefined, items: readonly CodeViewItem<unknown>[]): boolean {
  if (viewer == null || items.length === 0) return true
  const firstTop = viewer.getTopForItem(items[0]!.id) ?? 0
  return restingScrollTop(viewer) <= firstTop + 8
}

function formatCounts(added: number, deleted: number): React.JSX.Element {
  return <span className="guide-counts">
    {added > 0 ? <span className="guide-added">+{added}</span> : null}
    {deleted > 0 ? <span className="guide-deleted">−{deleted}</span> : null}
    {added === 0 && deleted === 0 ? <span className="guide-unchanged">±0</span> : null}
  </span>
}

function splitPath(path: string): { name: string; directory: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? { name: path, directory: '' } : { name: path.slice(slash + 1), directory: path.slice(0, slash) }
}

function relativeTime(iso: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(iso))
  if (!Number.isFinite(elapsed)) return ''
  const minutes = Math.round(elapsed / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}

const PHASE_TEXT: Record<string, string> = {
  collecting: 'Collecting changes…',
  thinking: 'Reading the change…',
  writing: 'Writing the guide…',
  normalizing: 'Checking against the diff…'
}

function providerName(provider: string): string {
  return provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'the agent'
}

function modelLabel(agent: GuideAgentContext | null, provider: string, model: string): string {
  if (provider === 'file') return 'the agent that wrote the change'
  const known = agent?.provider === provider ? agent.models.find((option) => option.id === model) : undefined
  if (known != null) return known.label
  return model === '' || model === 'default' ? `${providerName(provider)} default` : model
}

function reviewMetadata(review: RepositoryReview | null, guide: NormalizedGuide | undefined, fileCount: number): string {
  if (review?.kind === 'github') {
    const match = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(review.pullRequest.url)
    const slug = match == null ? `#${review.pullRequest.number}` : `${match[1]}#${match[2]}`
    return `${slug} · ${review.pullRequest.baseRefName} ← ${review.pullRequest.headRefName}`
  }
  if (review != null) return `${review.headOid.slice(0, 8)} · ${review.title}`
  const branch = guide?.facts.subject.workingBranch
  return `${branch ?? 'working tree'} · ${fileCount} file${fileCount === 1 ? '' : 's'}`
}

function GuideFileRow({
  file,
  homeSection,
  viewed,
  stale,
  current,
  onOpen
}: {
  file: GuideFile
  homeSection: GuideSection | null
  viewed: boolean
  stale: boolean
  current: boolean
  onOpen(): void
}): React.JSX.Element {
  const { name, directory } = splitPath(file.path)
  return (
    <li>
      <button type="button" className="guide-file-row" data-guide-file={file.path}
        data-current={current ? '' : undefined} data-home={file.home ? '' : undefined}
        title={`${file.path} — ⌥-click to open in your editor`}
        onClick={(event) => {
          if (event.altKey) {
            const hunk = file.focus.find((candidate) => candidate.side === 'additions' && candidate.startLine != null)
            host()?.openInEditor(file.path, hunk?.startLine ?? null)
            return
          }
          onOpen()
        }}>
        <span className="guide-file-name">{name}</span>
        <span className="guide-file-directory">{directory}</span>
        {stale ? <span className="guide-file-stale" title="Changed since this guide was written" aria-label="changed" /> : null}
        {file.home || homeSection == null
          ? formatCounts(file.added, file.deleted)
          : <span className="guide-file-home"><IconArrowUpRight aria-hidden="true" />{sectionLabel(homeSection)}</span>}
        {viewed ? <IconCheck className="guide-file-viewed" aria-label="viewed" /> : null}
      </button>
    </li>
  )
}

function renderInlineCode(text: string): React.ReactNode[] {
  return text.split(/(`[^`]+`)/).map((part, index) => part.startsWith('`') && part.endsWith('`') && part.length > 2
    ? <code key={index}>{part.slice(1, -1)}</code>
    : part)
}

/**
 * Every section as a step: number and title, the one being read open with its
 * prose and files. A click on a step goes to its first file.
 */
function GuideSteps({
  guide,
  activeIndex,
  viewedPaths,
  stalePaths,
  readingItem,
  onOpenSection,
  onOpenFile
}: {
  guide: NormalizedGuide
  activeIndex: number
  viewedPaths: ReadonlySet<string>
  stalePaths: ReadonlySet<string>
  readingItem: string | null
  onOpenSection(index: number): void
  onOpenFile(path: string, sectionIndex: number): void
}): React.JSX.Element {
  const homes = useMemo(() => {
    const byPath = new Map<string, GuideSection>()
    for (const candidate of guide.sections) {
      for (const file of candidate.files) if (file.home) byPath.set(file.path, candidate)
    }
    return byPath
  }, [guide])
  return (
    <ol className="guide-steps">
      {guide.sections.map((section, index) => {
        const active = index === activeIndex
        const homeFiles = section.files.filter((file) => file.home)
        const viewed = homeFiles.length > 0 && homeFiles.every((file) => viewedPaths.has(file.path))
        return (
          <li key={section.id} className="guide-step" data-guide-step={section.id}
            data-active={active ? '' : undefined} data-viewed={viewed ? '' : undefined}
            data-supporting={section.number == null ? '' : undefined}>
            <button type="button" className="guide-step-head" aria-current={active ? 'step' : undefined}
              onClick={() => onOpenSection(index)}>
              <span className="guide-step-mark" aria-hidden="true">
                {viewed ? <IconCheck /> : section.number == null ? '' : String(section.number).padStart(2, '0')}
              </span>
              <span className="guide-step-title">{section.title}</span>
            </button>
            {active ? (
              <div className="guide-step-body" data-guide-section={section.id}>
                <p className="guide-step-text">{renderInlineCode(section.body)}</p>
                <ul className="guide-file-list">
                  {section.files.map((file) => (
                    <GuideFileRow key={file.path} file={file} homeSection={homes.get(file.path) ?? null}
                      viewed={viewedPaths.has(file.path)} stale={stalePaths.has(file.path)}
                      current={readingItem === guideItemId(file.path)}
                      onOpen={() => onOpenFile(file.path, index)} />
                  ))}
                </ul>
              </div>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

function GuideStateMessage({
  state,
  agent,
  subjectReady,
  onGenerate,
  onCancel
}: {
  state: GuideState
  agent: GuideAgentContext | null
  subjectReady: boolean
  onGenerate(): void
  onCancel(): void
}): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  const loading = state.status === 'loading'
  useEffect(() => {
    if (!loading) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [loading])
  if (loading) {
    const elapsed = Math.max(0, Math.round((now - (state.startedAt ?? now)) / 1_000))
    return (
      <div className="guide-state" data-guide-state="loading" role="status">
        <IconRefresh className="spin" aria-hidden="true" />
        <span className="guide-state-phase">{PHASE_TEXT[state.phase ?? 'collecting']}</span>
        {elapsed >= 3 ? <span className="guide-state-elapsed">{elapsed} s</span> : null}
        <button type="button" className="guide-button" onClick={onCancel}>Cancel</button>
      </div>
    )
  }
  if (state.status === 'unavailable') {
    const noMatch = state.code === 'no-match'
    return (
      <div className="guide-state" data-guide-state="unavailable" role="alert">
        <strong>{noMatch ? 'The guide did not match this diff' : 'No guide'}</strong>
        <p>{state.reason ?? (noMatch ? 'It named files or hunks this review does not have.' : '')}</p>
        <div className="guide-state-actions">
          {state.code === 'not-connected' && agent != null ? (
            <button type="button" className="guide-button primary" onClick={() => agent.login(agent.provider)}>Sign in</button>
          ) : null}
          <button type="button" className="guide-button" disabled={!subjectReady} onClick={onGenerate}>
            {noMatch ? 'Try again' : 'Generate'}
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="guide-state" data-guide-state="idle">
      <IconSparkles className="guide-state-mark" aria-hidden="true" />
      <strong>Generate a guide for this review</strong>
      <p>The model reads the diff, not your repository, and explains it section by section, core first.</p>
      <GuideAgentPicker dock={agent} />
      <button type="button" className="guide-button primary" data-guide-generate="" disabled={!subjectReady} onClick={onGenerate}>
        Generate
      </button>
    </div>
  )
}

function GuideHeaderMenu({ guide }: { guide: NormalizedGuide }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [open])
  return (
    <div className="guide-menu" ref={menuRef}>
      <button type="button" className="guide-icon-button" aria-label="Guide actions" aria-expanded={open}
        onClick={() => setOpen((value) => !value)}><IconEllipsis aria-hidden="true" /></button>
      {open ? (
        <div className="guide-menu-popover" role="menu">
          <button type="button" role="menuitem" onClick={() => {
            void navigator.clipboard.writeText(formatGuideMarkdown(guide)).catch(() => {})
            setOpen(false)
          }}><IconCopy aria-hidden="true" />Copy guide as Markdown</button>
          {guide.context == null || guide.context.messages.length === 0 ? null : (
            <div className="guide-menu-context">
              <span>From the agent’s session</span>
              {guide.context.messages.slice(-4).map((message, index) => (
                <p key={index}><b>{message.role === 'user' ? 'You' : 'Agent'}:</b> {message.text.slice(0, 280)}</p>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** The model the next run uses, from the header: pick, then Regenerate. */
function GuideModelPopover({ agent, regenerating, onRegenerate }: {
  agent: GuideAgentContext | null
  regenerating: boolean
  onRegenerate(): void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (!popoverRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', escape)
    }
  }, [open])
  return (
    <div className="guide-menu" ref={popoverRef}>
      <button type="button" className="guide-icon-button" aria-label="Guide model" title="Model, effort and focus"
        aria-expanded={open} data-guide-model="" onClick={() => setOpen((value) => !value)}>
        <IconGear aria-hidden="true" />
      </button>
      {open ? (
        <div className="guide-menu-popover guide-model-popover" role="dialog" aria-label="Guide model">
          <GuideAgentPicker dock={agent} />
          <button type="button" className="guide-button primary" disabled={regenerating}
            onClick={() => { onRegenerate(); setOpen(false) }}>Regenerate</button>
        </div>
      ) : null}
    </div>
  )
}

function GuideHeader({
  guide,
  agent,
  review,
  fileCount,
  onRegenerate,
  regenerating
}: {
  guide: NormalizedGuide
  agent: GuideAgentContext | null
  review: RepositoryReview | null
  fileCount: number
  onRegenerate(): void
  regenerating: boolean
}): React.JSX.Element {
  const { totals, facts } = guide
  const partial = totals.implementationAdded !== totals.added || totals.implementationDeleted !== totals.deleted
  const shownAdded = partial ? totals.implementationAdded : totals.added
  const shownDeleted = partial ? totals.implementationDeleted : totals.deleted
  // One height whatever is being read: a header that shrank on scroll moved
  // the review under the reader.
  return (
    <header className="guide-header">
      <div className="guide-heading">
        <h1 className="guide-title" title={guide.title}>{guide.title}</h1>
        <div className="guide-meta">
          <span>{reviewMetadata(review, guide, fileCount)}</span>
          <span className="guide-meta-counts" title={partial
            ? `Implementation only; ${totals.added + totals.deleted} lines in all, with tests, docs and generated files`
            : undefined}>
            {formatCounts(shownAdded, shownDeleted)}{partial ? <span className="guide-meta-star">*</span> : null}
          </span>
          <span className="guide-meta-author">
            {modelLabel(agent, facts.provider, facts.model)}{facts.effort == null ? '' : ` · ${facts.effort}`}
            {' · '}{relativeTime(facts.generatedAt, Date.now())}
          </span>
        </div>
      </div>
      <div className="guide-header-actions">
        <button type="button" className="guide-button ghost" data-guide-regenerate="" disabled={regenerating} onClick={onRegenerate}>
          <IconRefresh aria-hidden="true" />Regenerate
        </button>
        <GuideModelPopover agent={agent} regenerating={regenerating} onRegenerate={onRegenerate} />
        <GuideHeaderMenu guide={guide} />
      </div>
    </header>
  )
}

/**
 * The Guide view around the review: a header, a pinned column with the section
 * being read, and a rail of ticks. The viewer itself stays the review's own
 * instance; this only reads it and asks it to scroll.
 */
export function ReviewGuideView({
  worldId,
  viewerRef,
  items,
  viewedPaths,
  repositoryReview,
  fileCount
}: ReviewGuideViewProps): React.JSX.Element {
  const state = useGuideState(worldId)
  const agent = useHostAgent()
  const choice = useGuideAgentChoice()
  const run = useMemo(() => agent == null ? null : resolveGuideRun(choice, agent), [agent, choice])
  const guide = state.guide
  const subject = agent?.subject?.tabId === worldId ? agent.subject : null
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [readingItem, setReadingItem] = useState<string | null>(null)
  const columnRef = useRef<HTMLElement | null>(null)
  const [narrow, setNarrow] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [columnWidth, setColumnWidth] = useState(storedColumnWidth)
  const changeColumnWidth = useCallback((width: number) => {
    setColumnWidth(width)
    saveColumnWidth(width)
  }, [])
  const pendingTargetRef = useRef<{ path: string; sectionIndex: number } | null>(null)
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  useEffect(() => {
    const current = host()
    if (current != null) reviewGuideStore.connect(current)
  }, [])

  // A stored guide shows without spending tokens.
  useEffect(() => {
    if (subject == null || run == null) return
    void reviewGuideStore.request(worldId, subject, run, { cachedOnly: true })
  }, [run, subject, worldId])

  const homeFiles = useMemo(() => guide == null ? [] : guideHomeFiles(guide), [guide])
  const sectionOfItem = useMemo(() => new Map(homeFiles.map((file) => [file.itemId, file.sectionIndex])), [homeFiles])

  // Which file is being read, from the viewer's own scroll, at most every 90 ms.
  const recomputeReadingRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    let timer = 0
    let unsubscribe: (() => void) | null = null
    let instance: CodeView<unknown> | undefined
    let scrollTop = 0
    const compute = (): void => {
      timer = 0
      if (instance == null) return
      // At the end of the review the last files can never reach the top of the
      // screen; the reader is on the last one then.
      const root = (instance as unknown as { root?: HTMLElement | null }).root
      const atEnd = root != null && root.scrollHeight - root.clientHeight > 0 && scrollTop >= root.scrollHeight - root.clientHeight - 2
      const last = itemsRef.current.at(-1)?.id ?? null
      const id = atEnd && last != null ? last : readingItemId(instance, scrollTop)
      setReadingItem((previous) => previous === id ? previous : id)
    }
    const attach = (): boolean => {
      instance = viewerRef.current?.getInstance()
      if (instance == null) return false
      scrollTop = restingScrollTop(instance)
      unsubscribe = instance.subscribeToScroll((top) => {
        scrollTop = top
        if (timer === 0) timer = window.setTimeout(compute, READING_THROTTLE_MS)
      })
      // A reorder moves the files under a reader who did not scroll.
      recomputeReadingRef.current = () => {
        if (instance != null) scrollTop = restingScrollTop(instance)
        if (timer === 0) timer = window.setTimeout(compute, READING_THROTTLE_MS)
      }
      compute()
      return true
    }
    let poll = 0
    if (!attach()) {
      poll = window.setInterval(() => {
        if (attach()) window.clearInterval(poll)
      }, 100)
    }
    return () => {
      window.clearInterval(poll)
      window.clearTimeout(timer)
      unsubscribe?.()
      recomputeReadingRef.current = null
    }
  }, [viewerRef, worldId])

  useEffect(() => {
    recomputeReadingRef.current?.()
  }, [items])

  // Below 980 px of review there is no room for the column; a compact bar replaces it.
  useEffect(() => {
    const node = rootRef.current?.parentElement
    if (node == null) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? NARROW_WIDTH
      setNarrow((previous) => (width < NARROW_WIDTH) === previous ? previous : width < NARROW_WIDTH)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // A guide reorders the review only when the reader is at the top, or asks to.
  const appliedOrder = useHostOrder(worldId)
  const applied = guide != null && appliedOrder === orderFor(guide)
  useEffect(() => {
    const current = host()
    if (guide == null || state.status !== 'ready' || current == null) return
    const order = orderFor(guide)
    if (current.order(worldId) === order) return
    const hadOrder = current.order(worldId) != null
    if (hadOrder || readerAtTop(viewerRef.current?.getInstance(), itemsRef.current)) {
      current.setOrder(worldId, order)
      if (state.pendingOrder) reviewGuideStore.set(worldId, { pendingOrder: false })
      // The viewer keeps the file that was on top where it was; a reader at the
      // top starts the guide at its first section instead.
      const first = hadOrder ? undefined : guideHomeFiles(guide)[0]
      if (first != null) {
        window.requestAnimationFrame(() => {
          viewerRef.current?.scrollTo({ type: 'item', id: first.itemId, align: 'start', behavior: 'instant' })
        })
      }
    } else if (!state.pendingOrder) {
      reviewGuideStore.set(worldId, { pendingOrder: true })
    }
  }, [guide, state.pendingOrder, state.status, viewerRef, worldId])

  const scrollToItem = useCallback((itemId: string) => {
    viewerRef.current?.scrollTo({ type: 'item', id: itemId, align: 'start', behavior: 'smooth-auto' })
  }, [viewerRef])

  const goToSection = useCallback((index: number) => {
    const first = homeFiles.find((file) => file.sectionIndex === index)
    if (first != null) scrollToItem(first.itemId)
  }, [homeFiles, scrollToItem])

  const goToFile = useCallback((path: string, sectionIndex: number) => {
    if (guide == null) return
    const viewer = viewerRef.current
    const id = guideItemId(path)
    if (viewer?.getItem(id) == null) {
      // Not loaded yet: go there once its page lands.
      pendingTargetRef.current = { path, sectionIndex }
      return
    }
    pendingTargetRef.current = null
    const file = guide.sections[sectionIndex]?.files.find((candidate) => candidate.path === path)
    const hunk = file?.focus[0]
    if (hunk != null && hunk.kind === 'patch' && hunk.startLine != null && hunk.startLine > FAR_HUNK_LINE) {
      viewer.scrollTo({ type: 'line', id, lineNumber: hunk.startLine, side: hunk.side, align: 'start', behavior: 'smooth-auto' })
      viewer.setSelectedLines({ id, range: { start: hunk.startLine, end: hunk.endLine ?? hunk.startLine, side: hunk.side } })
      return
    }
    scrollToItem(id)
  }, [guide, scrollToItem, viewerRef])

  useEffect(() => {
    const target = pendingTargetRef.current
    if (target == null) return
    if (viewerRef.current?.getItem(guideItemId(target.path)) != null) goToFile(target.path, target.sectionIndex)
  }, [goToFile, items, viewerRef])

  const readingSection = guide == null
    ? 0
    : sectionOfItem.get(readingItem ?? '') ?? (readingItem == null ? 0 : guide.sections.length - 1)
  const sectionCount = guide?.sections.length ?? 0

  // `}`/`{` move by section and `]`/`[` by file in guide order. Captured ahead of
  // the review's own `]`/`[`, which follow the tree's path order.
  const keyStateRef = useRef({ readingItem, readingSection, homeFiles, goToSection, scrollToItem, applied })
  useEffect(() => {
    keyStateRef.current = { readingItem, readingSection, homeFiles, goToSection, scrollToItem, applied }
  })
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      if (event.code !== 'BracketRight' && event.code !== 'BracketLeft') return
      if (isTyping(deepActiveElement())) return
      const { readingItem: reading, readingSection: section, homeFiles: files, goToSection: toSection, scrollToItem: toItem, applied: ordered } = keyStateRef.current
      if (!ordered || files.length === 0) return
      const forward = event.code === 'BracketRight'
      event.preventDefault()
      event.stopPropagation()
      if (event.shiftKey) {
        const sections = [...new Set(files.map((file) => file.sectionIndex))]
        const position = sections.indexOf(section)
        const next = sections[Math.min(Math.max(position + (forward ? 1 : -1), 0), sections.length - 1)]
        if (next != null && next !== section) toSection(next)
        return
      }
      const index = files.findIndex((file) => file.itemId === reading)
      const next = files[Math.min(Math.max(index + (forward ? 1 : -1), 0), files.length - 1)]
      if (next != null && next.itemId !== reading) toItem(next.itemId)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [])

  const generate = useCallback((force: boolean) => {
    if (subject == null || run == null) return
    void reviewGuideStore.request(worldId, subject, run, force ? { force: true } : {})
  }, [run, subject, worldId])

  const showOrder = useCallback(() => {
    if (guide == null) return
    host()?.setOrder(worldId, orderFor(guide))
    reviewGuideStore.set(worldId, { pendingOrder: false })
    window.requestAnimationFrame(() => goToSection(0))
  }, [goToSection, guide, worldId])

  // A pull request pushed past the guide's head, or a file changed under it.
  const headMoved = guide != null && subject != null && subject.source !== 'workingTree' &&
    guide.facts.subject.headOid !== subject.headOid
  const stale = state.stale || headMoved
  const ready = state.status === 'ready' || (state.status === 'loading' && guide != null)

  const activeIndex = Math.min(readingSection, Math.max(0, sectionCount - 1))

  // A wheel over the steps reads on through the review: the column itself does
  // not scroll, so the wheel has no default of its own and the listener stays
  // passive. The open step is kept on screen as the reader moves.
  useEffect(() => {
    const column = columnRef.current
    if (column == null) return
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey) return
      const root = (viewerRef.current?.getInstance() as unknown as { root?: HTMLElement | null } | undefined)?.root
      if (root == null) return
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1
      root.scrollBy({ top: event.deltaY * unit, behavior: 'instant' })
    }
    column.addEventListener('wheel', onWheel, { passive: true })
    return () => column.removeEventListener('wheel', onWheel)
  }, [viewerRef, ready, narrow])

  useEffect(() => {
    const column = columnRef.current
    const step = column?.querySelector<HTMLElement>('.guide-step[data-active]')
    if (column == null || step == null) return
    const top = step.offsetTop - column.offsetTop
    const bottom = top + step.offsetHeight
    const target = step.offsetHeight > column.clientHeight || top < column.scrollTop
      ? top - 12
      : bottom > column.scrollTop + column.clientHeight ? bottom - column.clientHeight + 12 : null
    if (target != null) column.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
  }, [activeIndex, guide])

  const counter = guide == null || !ready ? null : (() => {
    const section = guide.sections[activeIndex]
    if (section == null) return ''
    return section.number == null ? sectionLabel(section) : `${sectionLabel(section)} / ${String(guide.sectionCount).padStart(2, '0')}`
  })()

  const notices = guide == null || !ready ? null : (
    <>
      {state.status === 'loading' ? (
        <GuideStateMessage state={state} agent={agent} subjectReady={subject != null}
          onGenerate={() => generate(true)} onCancel={() => reviewGuideStore.cancel(worldId)} />
      ) : null}
      {stale && state.status !== 'loading' ? (
        <div className="guide-notice" data-guide-stale="" role="status">
          <span>Files changed since this guide was written.</span>
          <button type="button" className="guide-link" onClick={() => generate(true)}>Regenerate</button>
        </div>
      ) : null}
      {state.pendingOrder ? (
        <div className="guide-notice" role="status">
          <span>The guide is ready.</span>
          <button type="button" className="guide-link" data-guide-show="" onClick={showOrder}>Show it</button>
        </div>
      ) : null}
    </>
  )

  const column = guide == null || !ready ? (
    <GuideStateMessage state={state} agent={agent} subjectReady={subject != null}
      onGenerate={() => generate(state.status === 'unavailable')} onCancel={() => reviewGuideStore.cancel(worldId)} />
  ) : (
    <>
      {notices}
      <div className="guide-column-head">
        <span>Walkthrough</span>
        <span className="guide-counter" data-guide-counter="">{counter}</span>
      </div>
      {guide.overview == null ? null : <p className="guide-overview">{renderInlineCode(guide.overview)}</p>}
      <GuideSteps guide={guide} activeIndex={activeIndex} viewedPaths={viewedPaths} stalePaths={state.stalePaths}
        readingItem={readingItem} onOpenSection={goToSection} onOpenFile={goToFile} />
    </>
  )

  return (
    <div className="review-guide" ref={rootRef} data-review-guide-view="" data-narrow={narrow ? '' : undefined}>
      {guide == null || !ready ? null : (
        <GuideHeader guide={guide} agent={agent} review={repositoryReview} fileCount={fileCount}
          onRegenerate={() => generate(true)} regenerating={state.status === 'loading'} />
      )}
      {narrow && guide != null && ready ? (
        <div className="guide-compact-bar" data-guide-compact="">
          <button type="button" className="guide-icon-button" aria-label="Previous section"
            disabled={activeIndex <= 0} onClick={() => goToSection(activeIndex - 1)}>
            <IconChevronSm className="guide-chevron-left" aria-hidden="true" />
          </button>
          <button type="button" className="guide-compact-title" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
            <span className="guide-counter" data-guide-counter="">{counter}</span>
            <span>{guide.sections[activeIndex]?.title}</span>
          </button>
          <button type="button" className="guide-icon-button" aria-label="Next section"
            disabled={activeIndex >= sectionCount - 1} onClick={() => goToSection(activeIndex + 1)}>
            <IconChevronSm className="guide-chevron-right" aria-hidden="true" />
          </button>
          {expanded ? (
            <div className="guide-compact-body">
              {notices}
              <GuideSteps guide={guide} activeIndex={activeIndex} viewedPaths={viewedPaths} stalePaths={state.stalePaths}
                readingItem={readingItem} onOpenSection={goToSection} onOpenFile={goToFile} />
            </div>
          ) : null}
        </div>
      ) : (
        <aside className="guide-column" ref={columnRef} data-guide-column="" aria-label="Review guide"
          style={{ width: columnWidth }}>
          {column}
          <GuideColumnResizer columnRef={columnRef} width={columnWidth} onWidth={changeColumnWidth} />
        </aside>
      )}
    </div>
  )
}

export default ReviewGuideView
