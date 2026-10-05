import { useState } from 'react'
import { IconApproved, IconCheck, IconChevronSm, IconRefresh, IconReply } from '@pierre/icons'

import type { RemoteReviewThread } from '../../../shared/contracts'
import { GitHubMarkdownContent } from './GitHubMarkdownContent'
import { RemoteAvatar } from './RemoteAvatar'
import { useReviewClock } from '../review/reviewClock'

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function formatCommentAge(value: string, now: number): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const elapsedMinutes = Math.round((timestamp - now) / 60_000)
  if (Math.abs(elapsedMinutes) < 60) return RELATIVE_TIME_FORMATTER.format(elapsedMinutes, 'minute')
  const elapsedHours = Math.round(elapsedMinutes / 60)
  if (Math.abs(elapsedHours) < 24) return RELATIVE_TIME_FORMATTER.format(elapsedHours, 'hour')
  return RELATIVE_TIME_FORMATTER.format(Math.round(elapsedHours / 24), 'day')
}

// GitHub bodies are markdown, and review bots write dense markdown: backticks,
// lists, fenced snippets. Rendered as plain text it reads like source.
function RemoteComment({ body }: { body: string }): React.JSX.Element {
  return <GitHubMarkdownContent source={body} variant="comment" className="review-remote-body" />
}

interface RemoteReviewThreadCardProps {
  thread: RemoteReviewThread
  pending: boolean
  onReply(threadId: string, body: string): void
  onToggleResolved(threadId: string, resolved: boolean): void
}

function RemoteThreadHeader({ thread, author, now, pending, onHide, onToggleResolved }: {
  thread: RemoteReviewThread
  author: string
  now: number
  pending: boolean
  onHide(): void
  onToggleResolved(): void
}): React.JSX.Element {
  const resolveLabel = thread.resolved ? 'Reopen thread on GitHub' : 'Resolve thread on GitHub'
  return (
    <header>
      <RemoteAvatar url={thread.comments[0]?.authorAvatarUrl ?? ''} login={author} />
      <strong>{author}</strong>
      <span className="review-remote-age">{formatCommentAge(thread.comments[0]?.createdAt ?? '', now)}</span>
      {thread.outdated ? <em data-tone="outdated">Outdated</em> : null}
      {thread.resolved ? <em data-tone="resolved">Resolved</em> : null}
      {thread.resolved ? (
        <button className="review-remote-resolve" type="button"
          title="Hide this resolved thread" aria-label="Hide this resolved thread"
          onClick={onHide}><IconChevronSm /></button>
      ) : null}
      <button className="review-remote-resolve" type="button" disabled={pending}
        title={resolveLabel} aria-label={resolveLabel}
        onClick={onToggleResolved}>
        {pending ? <IconRefresh className="spin" /> : thread.resolved ? <IconCheck /> : <IconApproved />}
      </button>
    </header>
  )
}

function RemoteThreadReply({ author, pending, composing, replyBody, onCompose, onChange, onCancel, onSend }: {
  author: string
  pending: boolean
  composing: boolean
  replyBody: string
  onCompose(): void
  onChange(body: string): void
  onCancel(): void
  onSend(): void
}): React.JSX.Element {
  return composing ? (
    <div className="review-reply-composer">
      <textarea value={replyBody} rows={2} autoFocus
        aria-label={`Reply to ${author}`}
        placeholder="Reply on GitHub…" onChange={(event) => onChange(event.target.value)} />
      <div className="review-card-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button className="primary" type="button" disabled={replyBody.trim() === '' || pending}
          onClick={onSend}>
          {pending ? <IconRefresh className="spin" /> : <IconReply />}Reply
        </button>
      </div>
    </div>
  ) : (
    <footer>
      <button className="review-remote-reply" type="button" disabled={pending} onClick={onCompose}>
        <IconReply />Reply on GitHub
      </button>
    </footer>
  )
}

export function RemoteReviewThreadCard({
  thread,
  pending,
  onReply,
  onToggleResolved
}: RemoteReviewThreadCardProps): React.JSX.Element {
  // Held here rather than in the reply area, so a draft outlives the thread
  // folding away when it is resolved and coming back when it is reopened.
  const [replyBody, setReplyBody] = useState('')
  const [composing, setComposing] = useState(false)
  // A resolved thread is settled business. It stays on its line — that is where
  // it means something — but as one row until asked for, the way GitHub folds it
  // away, so resolving on GitHub visibly clears the review here too.
  const [showResolved, setShowResolved] = useState(false)
  const now = useReviewClock()

  const author = thread.comments[0]?.authorLogin ?? 'GitHub'
  const collapsed = thread.resolved && !showResolved
  const commentCount = thread.comments.length

  if (collapsed) {
    return (
      <article className="review-card review-thread review-remote-thread resolved collapsed">
        <button type="button" className="review-remote-collapsed" onClick={() => setShowResolved(true)}>
          <IconCheck aria-hidden="true" />
          <strong>{author}</strong>
          <span>resolved · {commentCount} {commentCount === 1 ? 'comment' : 'comments'}</span>
        </button>
      </article>
    )
  }

  return (
    <article className={`review-card review-thread review-remote-thread ${thread.resolved ? 'resolved' : ''}`}>
      <RemoteThreadHeader thread={thread} author={author} now={now} pending={pending}
        onHide={() => setShowResolved(false)}
        onToggleResolved={() => onToggleResolved(thread.id, !thread.resolved)} />
      <ol className="review-remote-comments">
        {thread.comments.map((comment, index) => (
          <li className="review-remote-comment" key={comment.id}>
            {/* The first comment's author is already the thread's title, so only
                replies carry their own byline. */}
            {index === 0 ? null : (
              <span><strong>{comment.authorLogin}</strong>{formatCommentAge(comment.createdAt, now)}</span>
            )}
            <RemoteComment body={comment.body} />
          </li>
        ))}
      </ol>
      <RemoteThreadReply author={author} pending={pending} composing={composing} replyBody={replyBody}
        onCompose={() => setComposing(true)}
        onChange={setReplyBody}
        onCancel={() => { setComposing(false); setReplyBody('') }}
        onSend={() => {
          onReply(thread.id, replyBody.trim())
          setComposing(false)
          setReplyBody('')
        }} />
    </article>
  )
}
