import { useState } from 'react'
import { IconApproved, IconCheck, IconRefresh, IconReply } from '@pierre/icons'

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

export function RemoteReviewThreadCard({
  thread,
  pending,
  onReply,
  onToggleResolved
}: RemoteReviewThreadCardProps): React.JSX.Element {
  const [replyBody, setReplyBody] = useState('')
  const [composing, setComposing] = useState(false)
  const now = useReviewClock()

  const author = thread.comments[0]?.authorLogin ?? 'GitHub'
  const resolveLabel = thread.resolved ? 'Reopen thread on GitHub' : 'Resolve thread on GitHub'

  return (
    <article className={`review-card review-thread review-remote-thread ${thread.resolved ? 'resolved' : ''}`}>
      <header>
        <RemoteAvatar url={thread.comments[0]?.authorAvatarUrl ?? ''} login={author} />
        <strong>{author}</strong>
        <span className="review-remote-age">{formatCommentAge(thread.comments[0]?.createdAt ?? '', now)}</span>
        {thread.outdated ? <em data-tone="outdated">Outdated</em> : null}
        {thread.resolved ? <em data-tone="resolved">Resolved</em> : null}
        <button className="review-remote-resolve" type="button" disabled={pending}
          title={resolveLabel} aria-label={resolveLabel}
          onClick={() => onToggleResolved(thread.id, !thread.resolved)}>
          {pending ? <IconRefresh className="spin" /> : thread.resolved ? <IconCheck /> : <IconApproved />}
        </button>
      </header>
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
      {composing ? (
        <div className="review-reply-composer">
          <textarea value={replyBody} rows={2} autoFocus
            aria-label={`Reply to ${author}`}
            placeholder="Reply on GitHub…" onChange={(event) => setReplyBody(event.target.value)} />
          <div className="review-card-actions">
            <button type="button" onClick={() => { setComposing(false); setReplyBody('') }}>Cancel</button>
            <button className="primary" type="button" disabled={replyBody.trim() === '' || pending}
              onClick={() => {
                onReply(thread.id, replyBody.trim())
                setComposing(false)
                setReplyBody('')
              }}>
              {pending ? <IconRefresh className="spin" /> : <IconReply />}Reply
            </button>
          </div>
        </div>
      ) : (
        <footer>
          <button className="review-remote-reply" type="button" disabled={pending} onClick={() => setComposing(true)}>
            <IconReply />Reply on GitHub
          </button>
        </footer>
      )}
    </article>
  )
}
