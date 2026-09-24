import { useId, useLayoutEffect, useRef, useState } from 'react'
import {
  IconBrandGithub,
  IconCheck,
  IconChevronSm,
  IconClockArrow,
  IconEye,
  IconFileCode,
  IconMinus,
  IconX
} from '@pierre/icons'

import type {
  PullRequestConversation,
  RemoteReviewSummary,
  RemoteReviewThread
} from '../../../shared/contracts'
import { GitHubMarkdownContent, useGitHubMarkdownRenderer } from './GitHubMarkdownContent'
import { RemoteAvatar } from './RemoteAvatar'
import { formatCommentAge } from './RemoteReviewThreads'
import { outdatedRemoteThreads } from './usePullRequestConversation'
import { useReviewClock } from '../review/reviewClock'
import './PullRequestContext.css'

type ReviewStateIcon = typeof IconCheck
type ReviewStateTone = 'approved' | 'changes' | 'commented' | 'pending' | 'muted'

/**
 * A review state is something a person did, so it reads as a verb in a sentence
 * rather than as a tag pinned to their name. The colour rides on the badge and
 * the words stay neutral — an outlined pill in coloured text is invisible at a
 * glance, which is the whole job of this row.
 */
function reviewStateMeta(state: string): { verb: string; tone: ReviewStateTone; icon: ReviewStateIcon } {
  switch (state.toLowerCase()) {
    case 'approved': return { verb: 'approved these changes', tone: 'approved', icon: IconCheck }
    case 'changes_requested': return { verb: 'requested changes', tone: 'changes', icon: IconX }
    case 'commented': return { verb: 'reviewed', tone: 'commented', icon: IconEye }
    case 'dismissed': return { verb: 'had their review dismissed', tone: 'muted', icon: IconMinus }
    case 'pending': return { verb: 'has a pending review', tone: 'pending', icon: IconClockArrow }
    default: return { verb: state.toLowerCase().replaceAll('_', ' '), tone: 'muted', icon: IconMinus }
  }
}

/**
 * A bare `COMMENTED` review with no body says only that someone opened the diff;
 * whatever they wrote is already on the lines it was written about. And when one
 * person reviewed twice, only their last review is their position — the earlier
 * ones stay as history, dimmed, the way GitHub's timeline keeps them.
 */
function visibleReviews(
  reviews: readonly RemoteReviewSummary[]
): Array<{ review: RemoteReviewSummary; superseded: boolean }> {
  const shown = reviews.filter(
    (review) => review.state.toLowerCase() !== 'commented' || review.body.trim() !== ''
  )
  const latestByAuthor = new Map<string, string>()
  for (const review of shown) latestByAuthor.set(review.authorLogin, review.id)
  return shown.map((review) => ({
    review,
    superseded: latestByAuthor.get(review.authorLogin) !== review.id
  }))
}

type HunkLineKind = 'header' | 'add' | 'del' | 'ctx'

function hunkLines(diffHunk: string): Array<{ kind: HunkLineKind; text: string }> {
  return diffHunk.split('\n').map((text) => ({
    kind: text.startsWith('@@') ? 'header'
      : text.startsWith('+') ? 'add'
        : text.startsWith('-') ? 'del' : 'ctx',
    text
  }))
}

/**
 * A thread a push stranded. Its line numbers describe a commit that is no longer
 * the head, so the hunk GitHub captured when the comment was written is the only
 * context that still holds — and it is a diff, so it is drawn as one. The card is
 * bordered on all four sides: a single rule down the left is the blockquote
 * idiom, and this is a file, not a quotation.
 */
function OutdatedThread({ thread, now }: {
  thread: RemoteReviewThread
  now: number
}): React.JSX.Element {
  const line = thread.originalLine ?? thread.originalStartLine
  return (
    <li className="pr-context-outdated-thread">
      <header className="pr-context-outdated-header">
        <IconFileCode aria-hidden="true" />
        <code>{thread.path}{line == null ? '' : `:${line}`}</code>
        <span className="pr-context-outdated-flag">Outdated</span>
        {thread.resolved ? (
          <span className="pr-context-outdated-flag" data-tone="resolved">
            <IconCheck aria-hidden="true" />Resolved
          </span>
        ) : null}
      </header>
      {thread.diffHunk === '' ? null : (
        <ol className="pr-context-outdated-hunk" aria-label="Code this comment was written on">
          {hunkLines(thread.diffHunk).map((entry, index) => (
            <li key={index} data-kind={entry.kind}>{entry.text}</li>
          ))}
        </ol>
      )}
      <ol className="pr-context-outdated-comments">
        {thread.comments.map((comment) => (
          <li className="pr-context-outdated-comment" key={comment.id}>
            <span className="pr-context-outdated-author">
              <RemoteAvatar url={comment.authorAvatarUrl} login={comment.authorLogin} />
              <strong>{comment.authorLogin}</strong>
              <time dateTime={comment.createdAt}>{formatCommentAge(comment.createdAt, now)}</time>
            </span>
            <GitHubMarkdownContent source={comment.body} className="pr-context-review-body" />
          </li>
        ))}
      </ol>
    </li>
  )
}

/**
 * A long description folds away behind the same chevron the section header
 * uses, and its label says what a click will do rather than staying "Show" once
 * it is already showing.
 */
function DescriptionDisclosure({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <details className="pr-context-description" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <IconChevronSm className="pr-context-disclosure-chevron" aria-hidden="true" />
        {open ? 'Hide description' : 'Show description'}
      </summary>
      {children}
    </details>
  )
}

const PLACEHOLDER_LINES = [0.92, 0.78, 0.54] as const

/** Stands in for the description while it loads, so the diff below starts where it will stay. */
function ContextPlaceholder(): React.JSX.Element {
  return (
    <div className="pr-context-ghost">
      <span className="sr-only" role="status">Loading pull request context…</span>
      {PLACEHOLDER_LINES.map((width, index) => (
        <i key={index} aria-hidden="true" style={{ width: `${Math.round(width * 100)}%` }} />
      ))}
    </div>
  )
}

/**
 * CSS cannot transition `height: auto` into a different `auto`, so a body whose
 * content is swapped — placeholder to description, or a new review landing —
 * would snap. This pins the old height inline, then moves the pin to the new
 * one and lets the body's own height transition carry it; the review viewer's
 * ResizeObserver follows the section frame by frame, so the diff below slides
 * rather than jumps.
 *
 * A CSS transition rather than `element.animate()`: a transition retargets from
 * its current value. A toggle mid-glide drops the pin, and the open/close
 * transition picks up from the height on screen. An animation holding `height`
 * instead hid the toggle's transition until it ended, and the box snapped shut.
 */
function useHeightGlide(ref: React.RefObject<HTMLDivElement | null>, contentKey: unknown, enabled: boolean): void {
  const settledHeight = useRef<number | null>(null)
  const pinned = useRef(false)
  // Read at content changes only; opening and closing are the stylesheet's job.
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useLayoutEffect(() => {
    const element = ref.current
    if (element == null) return
    const settle = (event?: TransitionEvent): void => {
      if (event != null && (event.target !== element || event.propertyName !== 'height')) return
      if (pinned.current && event?.type === 'transitionend') {
        // Back to `auto`, which is the height the pin just reached: no motion.
        pinned.current = false
        element.style.height = ''
      }
      if (!pinned.current) settledHeight.current = element.offsetHeight
    }
    settle()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => settle())
    observer?.observe(element)
    element.addEventListener('transitionend', settle)
    return () => {
      observer?.disconnect()
      element.removeEventListener('transitionend', settle)
    }
  }, [ref])

  useLayoutEffect(() => {
    const element = ref.current
    if (element == null || !pinned.current) return
    pinned.current = false
    element.style.height = ''
  }, [enabled, ref])

  useLayoutEffect(() => {
    const element = ref.current
    if (element == null) return
    // Mid-glide, the next glide starts from where the box is on screen.
    const from = pinned.current ? element.getBoundingClientRect().height : settledHeight.current
    element.style.height = ''
    pinned.current = false
    const to = element.offsetHeight
    settledHeight.current = to
    if (!enabledRef.current || from == null || Math.abs(from - to) < 1) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    // Pin the old height with transitions off, so the pin itself is not
    // animated from the new content's height, then release it toward the new.
    element.style.transition = 'none'
    element.style.height = `${from}px`
    void element.offsetHeight
    element.style.transition = ''
    element.style.height = `${to}px`
    pinned.current = true
  }, [contentKey, ref])
}

export function PullRequestContext({ conversation, pullRequest = false }: {
  conversation: PullRequestConversation | null
  /**
   * The review is a pull request, so the section is coming: it holds its place
   * from the first paint instead of arriving above a diff the reader has begun.
   */
  pullRequest?: boolean
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(true)
  const contentId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  const now = useReviewClock()
  const body = conversation?.body.trim() ?? ''
  const reviews = conversation?.reviews ?? []
  const outdated = outdatedRemoteThreads(conversation)
  // Asked for at mount, so the chunk downloads while GitHub answers. Until it is
  // here the placeholder stays: painting the raw source first and reformatting
  // it a moment later is a reflow the reader sees as the description jumping.
  const markdownRenderer = useGitHubMarkdownRenderer()
  const loading = pullRequest && (conversation == null || markdownRenderer == null)
  const empty = !loading && body === '' && reviews.length === 0 && outdated.length === 0
  useHeightGlide(bodyRef, loading ? null : conversation, expanded)
  if (empty && !pullRequest) return null

  const longBody = body.split('\n').length > 10 || body.length > 1_200
  const description = body === '' ? null : (
    <GitHubMarkdownContent source={body} className="pr-context-markdown" />
  )
  const shown = visibleReviews(reviews)

  return (
    <section className="pr-context" aria-label="Pull request context">
      <header>
        {/* An empty pull request keeps the strip it reserved, so nothing below moves
            up, but there is nothing to open. */}
        {empty ? (
          <div className="pr-context-toggle" data-empty="">
            <IconBrandGithub aria-hidden="true" />
            <strong>Pull request context</strong>
            <span className="pr-context-note">{conversation?.available === false ? 'Unavailable' : 'No description'}</span>
          </div>
        ) : (
          <button type="button" className="pr-context-toggle" aria-expanded={expanded}
            aria-controls={contentId} onClick={() => setExpanded((current) => !current)}>
            <IconChevronSm className="pr-context-chevron" aria-hidden="true" />
            <IconBrandGithub aria-hidden="true" />
            <strong>Pull request context</strong>
          </button>
        )}
      </header>
      {/* The body stays mounted so its height can animate: this section lives in
          the review viewer's header slot, whose ResizeObserver re-anchors the
          diff below on every observed change, and a height that moves frame by
          frame is what keeps the hunks from lurching. `inert` is what takes a
          collapsed body out of the tab order; the attribute is `data-collapsed`
          rather than `hidden` because `hidden` would impose `display: none`,
          which cannot be transitioned out of. */}
      <div id={contentId} className="pr-context-body" ref={bodyRef}
        data-collapsed={expanded && !empty ? undefined : ''} inert={!expanded || empty}>
        {loading ? <ContextPlaceholder /> : null}
        {longBody ? (
          <DescriptionDisclosure>{description}</DescriptionDisclosure>
        ) : description}
        {shown.length > 0 ? (
          <ol className="pr-context-reviews" aria-label="Submitted reviews">
            {shown.map(({ review, superseded }) => {
              const meta = reviewStateMeta(review.state)
              const StateIcon = meta.icon
              return (
                <li className="pr-context-review" key={review.id} data-tone={meta.tone}
                  data-superseded={superseded ? '' : undefined}>
                  <div className="pr-context-review-byline">
                    <span className="pr-context-review-glyph" aria-hidden="true"><StateIcon /></span>
                    <RemoteAvatar url={review.authorAvatarUrl} login={review.authorLogin} />
                    <p className="pr-context-review-sentence">
                      <strong>{review.authorLogin}</strong> {meta.verb}
                    </p>
                    {review.submittedAt == null ? null : (
                      <span className="pr-context-review-age">{formatCommentAge(review.submittedAt, now)}</span>
                    )}
                  </div>
                  {review.body.trim() === '' ? null : (
                    <GitHubMarkdownContent source={review.body} className="pr-context-review-body" />
                  )}
                </li>
              )
            })}
          </ol>
        ) : null}
        {outdated.length === 0 ? null : (
          <details className="pr-context-outdated">
            <summary>
              <IconClockArrow aria-hidden="true" />
              {outdated.length} outdated {outdated.length === 1 ? 'comment' : 'comments'}
              <span>no longer on the current diff</span>
            </summary>
            <ol aria-label="Outdated review comments">
              {outdated.map((thread) => (
                <OutdatedThread key={thread.id} thread={thread} now={now} />
              ))}
            </ol>
          </details>
        )}
      </div>
    </section>
  )
}
