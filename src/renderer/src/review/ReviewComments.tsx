import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SelectedLineRange } from '@pierre/diffs'
import './ReviewComments.css'

import type { FileImagePreview, RemoteReviewThread } from '../../../shared/contracts'
import type { ReviewCommentAnchor } from './reviewThreadAnchors'
import {
  IconApproved,
  IconArrow,
  IconCommentAdd,
  IconPencil,
  IconReply,
  IconSparkles,
  IconTrash
} from '@pierre/icons'

export interface ReviewReply {
  id: string
  body: string
}

export interface ReviewThread {
  id: string
  body: string
  lineNumber: number
  side?: 'additions' | 'deletions'
  range: SelectedLineRange
  anchor?: ReviewCommentAnchor
  orphaned?: boolean
  replies: ReviewReply[]
  resolved: boolean
}

export type ReviewAnnotationMetadata =
  | { kind: 'selection'; range: SelectedLineRange }
  | { kind: 'draft'; range: SelectedLineRange }
  | { kind: 'thread'; thread: ReviewThread }
  | { kind: 'remote'; thread: RemoteReviewThread }
  | { kind: 'image'; image: FileImagePreview }
  | { kind: 'markdown'; source: string; partial: boolean }

interface SelectionActionsProps {
  range: SelectedLineRange
  commentLabel?: string
  onComment(): void
  onAskAgent(): void
}

export type SelectionGesture = 'start' | 'change' | 'end'

// The Comment/Chat bar is a commit affordance. Pierre reports the live range
// on start and every change; only pointer-up should mount the annotation.
export function nextPendingSelection<T>(
  gesture: SelectionGesture,
  liveSelection: T | null,
  pending: T | null
): T | null {
  if (gesture === 'start') return null
  if (gesture === 'change') return pending
  return liveSelection
}

export function consumeSelectionChromeKey(
  event: KeyboardEvent,
  handlers: { onDismiss(): void; onAskAgent(): void }
): boolean {
  if (event.defaultPrevented || event.repeat) return false
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    handlers.onDismiss()
    return true
  }
  if (event.key.toLowerCase() === 'i' && (event.metaKey || event.ctrlKey) && !event.altKey) {
    event.preventDefault()
    handlers.onAskAgent()
    return true
  }
  return false
}

// Selecting lines offers both destinations rather than assuming a comment, so the
// same selection can go to a teammate or to the agent.
export function SelectionActions({
  range,
  commentLabel = 'Comment',
  onComment,
  onAskAgent
}: SelectionActionsProps): React.JSX.Element {
  return (
    <div
      className="selection-actions"
      role="toolbar"
      aria-label={`Actions for ${formatSelectedRange(range)}`}
      aria-keyshortcuts="Escape"
    >
      <button
        className="selection-actions-comment"
        type="button"
        onClick={onComment}
        aria-label={commentLabel}
        title={commentLabel}
      >
        <IconCommentAdd />{commentLabel}
      </button>
      <button type="button" onClick={onAskAgent} aria-label="Add selection to Chat" title="Add selection to Chat (⌘I)">
        <IconSparkles />Chat
      </button>
    </div>
  )
}

interface DraftCommentProps {
  range: SelectedLineRange
  onCancel(): void
  onSave(body: string): void
}

function selectedRangeParts(range: SelectedLineRange): {
  first: number
  last: number
  side: 'old' | 'new' | null
} {
  const side = range.side === 'deletions' ? 'old' : range.side === 'additions' ? 'new' : null
  const first = Math.min(range.start, range.end)
  const last = Math.max(range.start, range.end)
  return { first, last, side }
}

export function formatSelectedRange(range: SelectedLineRange): string {
  // Dragging upward reports the anchor first, so the ends are ordered for display.
  const { first, last, side } = selectedRangeParts(range)
  const lines = first === last ? `Line ${first}` : `Lines ${first}–${last}`
  return side == null ? lines : `${lines} · ${side}`
}

export function formatCompactSelectedRange(range: SelectedLineRange): string {
  const { first, last, side } = selectedRangeParts(range)
  const lines = first === last ? `${first}` : `${first}–${last}`
  return side == null ? lines : `${lines} · ${side}`
}

interface ReviewComposerProps {
  value: string
  placeholder: string
  ariaLabel: string
  submitLabel: string
  autoFocus?: boolean
  onChange(value: string): void
  onSubmit(): void
  onCancel(): void
}

function handleComposerKeyDown(
  event: React.KeyboardEvent<HTMLTextAreaElement>,
  handlers: { onCancel(): void; onSubmit(): void }
): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    handlers.onCancel()
    return
  }
  if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
  event.preventDefault()
  event.stopPropagation()
  handlers.onSubmit()
}

export function consumeComposerEscape(
  event: KeyboardEvent,
  options: { field: HTMLElement | null; onCancel(): void }
): boolean {
  if (event.defaultPrevented || event.repeat || event.key !== 'Escape') return false
  if (document.querySelector('dialog[open]') != null) return false
  const target = event.target
  if (target instanceof HTMLElement) {
    const otherField = target.closest('textarea, input, [contenteditable="true"]')
    if (otherField != null && otherField !== options.field) return false
  }
  event.preventDefault()
  event.stopPropagation()
  options.onCancel()
  return true
}

function ReviewComposer({
  value,
  placeholder,
  ariaLabel,
  submitLabel,
  autoFocus = false,
  onChange,
  onSubmit,
  onCancel
}: ReviewComposerProps): React.JSX.Element {
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const onCancelRef = useRef(onCancel)
  const canSubmit = value.trim() !== ''

  useLayoutEffect(() => {
    if (!autoFocus) return
    fieldRef.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    onCancelRef.current = onCancel
  }, [onCancel])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      consumeComposerEscape(event, {
        field: fieldRef.current,
        onCancel: () => onCancelRef.current()
      })
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  return (
    <div className="review-composer">
      <span className="review-composer-avatar" aria-hidden="true">Y</span>
      <textarea
        ref={fieldRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => handleComposerKeyDown(event, { onCancel, onSubmit })}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-keyshortcuts="Escape"
        rows={1}
        autoFocus={autoFocus}
      />
      <button
        className="review-composer-send"
        type="button"
        onClick={onSubmit}
        disabled={!canSubmit}
        aria-label={submitLabel}
        title={`${submitLabel} (Enter)`}
      >
        <IconArrow />
      </button>
    </div>
  )
}

export function DraftComment({ range, onCancel, onSave }: DraftCommentProps): React.JSX.Element {
  const [body, setBody] = useState('')

  const save = (): void => {
    const nextBody = body.trim()
    if (nextBody !== '') onSave(nextBody)
  }

  return (
    <ReviewComposer
      value={body}
      placeholder="Add a comment..."
      ariaLabel="Review comment"
      submitLabel={`Send comment on ${formatSelectedRange(range)}`}
      autoFocus
      onChange={setBody}
      onSubmit={save}
      onCancel={onCancel}
    />
  )
}

interface ReviewThreadCardProps {
  thread: ReviewThread
  onDelete(): void
  onEdit(body: string): void
  onReply(body: string): void
  onToggleResolved(): void
}

export function ReviewThreadCard({
  thread,
  onDelete,
  onEdit,
  onReply,
  onToggleResolved
}: ReviewThreadCardProps): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [editBody, setEditBody] = useState(thread.body)
  const [replying, setReplying] = useState(false)
  const [replyBody, setReplyBody] = useState('')

  const saveEdit = (): void => {
    const body = editBody.trim()
    if (body === '') return
    onEdit(body)
    setEditing(false)
  }

  const saveReply = (): void => {
    const body = replyBody.trim()
    if (body === '') return
    onReply(body)
    setReplyBody('')
    setReplying(false)
  }

  return (
    <article className={`review-card review-thread ${thread.resolved ? 'resolved' : ''}`}>
      <header className="review-thread-header">
        <span className="review-avatar" aria-hidden="true">Y</span>
        <strong>You</strong>
        <span>now</span>
        {thread.resolved ? <span className="review-resolved-label">Resolved</span> : null}
      </header>

      {editing ? (
        <ReviewComposer
          value={editBody}
          placeholder="Edit comment..."
          ariaLabel="Edit review comment"
          submitLabel="Save comment"
          autoFocus
          onChange={setEditBody}
          onSubmit={saveEdit}
          onCancel={() => { setEditBody(thread.body); setEditing(false) }}
        />
      ) : (
        <p>{thread.body}</p>
      )}

      {thread.replies.map((reply) => (
        <div className="review-reply" key={reply.id}>
          <span className="review-avatar" aria-hidden="true">Y</span>
          <div><strong>You</strong><p>{reply.body}</p></div>
        </div>
      ))}

      {replying ? (
        <ReviewComposer
          value={replyBody}
          placeholder="Add a reply..."
          ariaLabel="Reply to review comment"
          submitLabel="Send reply"
          autoFocus
          onChange={setReplyBody}
          onSubmit={saveReply}
          onCancel={() => setReplying(false)}
        />
      ) : null}

      {editing || replying ? null : (
        <footer className="review-thread-actions">
          <button type="button" onClick={() => setReplying(true)}><IconReply />Reply</button>
          <button type="button" onClick={() => setEditing(true)}><IconPencil />Edit</button>
          <button type="button" onClick={onToggleResolved}><IconApproved />{thread.resolved ? 'Reopen' : 'Resolve'}</button>
          <button className="danger" type="button" onClick={onDelete}><IconTrash />Delete</button>
        </footer>
      )}
    </article>
  )
}
