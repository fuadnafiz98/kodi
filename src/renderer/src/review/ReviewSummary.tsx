import { useEffect, useRef, useState } from 'react'
import { IconCheck, IconChevronSm, IconCopy, IconRefresh, IconTrash, IconX } from '@pierre/icons'

import type { CodeViewItem } from '@pierre/diffs'

import { formatCompactSelectedRange, formatSelectedRange, type ReviewThread } from './ReviewComments'
import { formatReviewCommentsMarkdown } from './reviewCommentsMarkdown'

export interface ReviewSummaryEntry {
  path: string
  thread: ReviewThread
}

export function fileNameFromReviewPath(path: string): string {
  return path.split('/').at(-1) ?? path
}

export function formatReviewCommentsForAgent(entries: readonly ReviewSummaryEntry[]): string {
  const comments = entries.map(({ path, thread }, index) => {
    const replies = thread.replies.map((reply) => `   Reply: ${reply.body}`).join('\n')
    const status = thread.orphaned ? ' [Orphaned — verify location]' : ''
    return `${index + 1}. ${path} — ${formatSelectedRange(thread.range)}${status}\n   ${thread.body}${replies === '' ? '' : `\n${replies}`}`
  })
  return `Please address these code review comments:\n\n${comments.join('\n\n')}`
}

const COPY_STATE_MS = { copied: 1_600, failed: 2_400 } as const
const CLEAR_CONFIRM_MS = 2_400

interface ReviewSummaryProps {
  entries: readonly ReviewSummaryEntry[]
  reattachingThreadId: string | null
  onBeginReattach(entry: ReviewSummaryEntry): void
  onCancelReattach(): void
  onDrop(entry: ReviewSummaryEntry): void
  onDropAll(): void
  /** The review's item for a path, so Markdown can quote the lines around each note. */
  itemFor?(path: string): CodeViewItem<unknown> | undefined
}

export function ReviewSummary({
  entries,
  reattachingThreadId,
  onBeginReattach,
  onCancelReattach,
  onDrop,
  onDropAll,
  itemFor
}: ReviewSummaryProps): React.JSX.Element | null {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const [markdownState, setMarkdownState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const markdownTimerRef = useRef(0)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [open, setOpen] = useState(false)
  const resetTimerRef = useRef(0)
  const rootRef = useRef<HTMLElement>(null)

  useEffect(() => () => {
    window.clearTimeout(resetTimerRef.current)
    window.clearTimeout(markdownTimerRef.current)
  }, [])
  useEffect(() => {
    if (!confirmingClear) return
    const timer = window.setTimeout(() => setConfirmingClear(false), CLEAR_CONFIRM_MS)
    return () => window.clearTimeout(timer)
  }, [confirmingClear])
  useEffect(() => {
    if (!confirmingClear && !open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (confirmingClear) setConfirmingClear(false)
      else setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [confirmingClear, open])
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const root = rootRef.current
      if (root == null || (event.target instanceof Node && root.contains(event.target))) return
      setOpen(false)
      setConfirmingClear(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [open])

  if (entries.length === 0) return null

  // Failure needs the same lifecycle as success: a terminal error state is a dead
  // end, with no signal that retrying is even possible.
  const settle = (state: 'copied' | 'failed'): void => {
    window.clearTimeout(resetTimerRef.current)
    setCopyState(state)
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), COPY_STATE_MS[state])
  }

  const copyComments = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(formatReviewCommentsForAgent(entries))
      settle('copied')
    } catch {
      settle('failed')
    }
  }

  const copyMarkdown = async (): Promise<void> => {
    let state: 'copied' | 'failed' = 'copied'
    try {
      await navigator.clipboard.writeText(formatReviewCommentsMarkdown(entries, (path) => itemFor?.(path)))
    } catch {
      state = 'failed'
    }
    window.clearTimeout(markdownTimerRef.current)
    setMarkdownState(state)
    markdownTimerRef.current = window.setTimeout(() => setMarkdownState('idle'), COPY_STATE_MS[state])
  }

  const requestClear = (): void => {
    if (entries.length === 1 || confirmingClear) {
      onDropAll()
      setConfirmingClear(false)
      return
    }
    setConfirmingClear(true)
  }

  return (
    <section ref={rootRef} className="review-summary" aria-label="Review comments summary">
      <header>
        <h2 className="review-summary-title">
          <button
            type="button"
            aria-expanded={open}
            aria-controls="review-notes-list"
            aria-haspopup="true"
            onClick={() => setOpen((current) => !current)}
          >
            <IconChevronSm className="review-summary-chevron" aria-hidden="true" />
            Review notes
            <span className="review-summary-count">{entries.length}</span>
          </button>
        </h2>
        <div className="review-summary-toolbar">
          <button
            type="button"
            data-copy-state={copyState}
            title="Copy notes for agent"
            aria-label="Copy notes for agent"
            onClick={() => void copyComments()}
          >
            <span className="icon-swap" data-state={copyState === 'copied' ? 'alt' : 'base'}>
              <IconCopy /><IconCheck />
            </span>
            {copyState === 'failed' ? <span className="review-copy-label">Copy failed</span> : null}
          </button>
          <button
            type="button"
            className="review-summary-markdown"
            data-copy-state={markdownState}
            title="Copy as Markdown, with the lines each note is about"
            aria-label="Copy notes as Markdown"
            onClick={() => void copyMarkdown()}
          >
            {markdownState === 'copied' ? <IconCheck /> : <span className="review-summary-md" aria-hidden="true">MD</span>}
            {markdownState === 'failed' ? <span className="review-copy-label">Copy failed</span> : null}
          </button>
          <button
            className="review-summary-clear"
            type="button"
            data-confirming={confirmingClear ? '' : undefined}
            title="Delete all notes"
            aria-label={confirmingClear ? `Delete ${entries.length} notes` : 'Delete all'}
            onClick={requestClear}
          >
            <IconTrash />
            {confirmingClear ? `Delete ${entries.length}` : null}
          </button>
        </div>
      </header>
      {/* The rows only mount while the list is open. Hidden, they were still
          rebuilt on every header re-render — a thread edit, a conversation poll —
          at about 11 DOM nodes a note, and in-page find cannot reach a
          display:none list anyway. Nothing in a row holds state to lose. The
          empty list stays so `aria-controls` keeps its target. */}
      <ol id="review-notes-list" role="list" hidden={!open}>
        {open ? entries.map((entry) => {
          const { path, thread } = entry
          const reattaching = reattachingThreadId === thread.id
          const fileName = fileNameFromReviewPath(path)
          return (
            <li key={thread.id}>
              <div className="review-summary-item-head">
                <div className="review-summary-file">
                  <strong title={path}>{fileName}</strong>
                  <span>{formatCompactSelectedRange(thread.range)}</span>
                  {thread.orphaned ? <em data-state="orphaned">Orphaned</em> : thread.resolved ? <em>Resolved</em> : null}
                </div>
                <button
                  className="review-summary-delete"
                  type="button"
                  aria-label={`Delete comment on ${fileName}`}
                  title="Delete comment"
                  onClick={() => onDrop(entry)}
                >
                  <IconTrash />
                </button>
              </div>
              <p>{thread.body}</p>
              {thread.replies.map((reply) => <blockquote key={reply.id}>{reply.body}</blockquote>)}
              {thread.orphaned ? (
                <div className="review-orphan-actions">
                  <span>{reattaching ? 'Select replacement lines in any file.' : 'The original lines no longer have one safe match.'}</span>
                  {reattaching ? (
                    <button type="button" onClick={onCancelReattach}><IconX />Cancel</button>
                  ) : (
                    <button type="button" onClick={() => onBeginReattach(entry)}><IconRefresh />Reattach</button>
                  )}
                </div>
              ) : null}
            </li>
          )
        }) : null}
      </ol>
    </section>
  )
}
