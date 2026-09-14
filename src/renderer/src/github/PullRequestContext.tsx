import { useId, useState } from 'react'
import { IconBrandGithub, IconCheck, IconChevronSm, IconClockArrow, IconComment, IconMinus, IconX } from '@pierre/icons'

import type { PullRequestConversation } from '../../../shared/contracts'
import { GitHubMarkdownContent } from './GitHubMarkdownContent'
import { RemoteAvatar } from './RemoteAvatar'
import { formatCommentAge } from './RemoteReviewThreads'
import { useReviewClock } from '../review/reviewClock'
import './PullRequestContext.css'

type ReviewStateIcon = typeof IconCheck
type ReviewStateTone = 'approved' | 'changes' | 'commented' | 'muted'

function reviewStateMeta(state: string): { label: string; tone: ReviewStateTone; icon: ReviewStateIcon | null } {
  switch (state.toLowerCase()) {
    case 'approved': return { label: 'Approved', tone: 'approved', icon: IconCheck }
    case 'changes_requested': return { label: 'Changes requested', tone: 'changes', icon: IconX }
    case 'commented': return { label: 'Commented', tone: 'commented', icon: IconComment }
    case 'dismissed': return { label: 'Dismissed', tone: 'muted', icon: IconMinus }
    case 'pending': return { label: 'Pending', tone: 'muted', icon: IconClockArrow }
    default: return { label: state.toLowerCase().replaceAll('_', ' '), tone: 'muted', icon: null }
  }
}

export function PullRequestContext({ conversation }: {
  conversation: PullRequestConversation | null
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(true)
  const contentId = useId()
  const now = useReviewClock()
  const body = conversation?.body.trim() ?? ''
  const reviews = conversation?.reviews ?? []
  if (body === '' && reviews.length === 0) return null

  const longBody = body.split('\n').length > 10 || body.length > 1_200
  const description = body === '' ? null : (
    <GitHubMarkdownContent source={body} className="pr-context-markdown" />
  )

  return (
    <section className="pr-context" aria-label="Pull request context">
      <header>
        <button type="button" className="pr-context-toggle" aria-expanded={expanded}
          aria-controls={contentId} onClick={() => setExpanded((current) => !current)}>
          <IconChevronSm className="pr-context-chevron" aria-hidden="true" />
          <IconBrandGithub aria-hidden="true" />
          <strong>Pull request context</strong>
        </button>
      </header>
      {expanded ? (
        <div id={contentId}>
          {longBody ? (
            <details>
              <summary>Show description</summary>
              {description}
            </details>
          ) : description}
          {reviews.length > 0 ? (
            <ol className="pr-context-reviews" aria-label="Submitted reviews">
              {reviews.map((review) => {
                const meta = reviewStateMeta(review.state)
                const StateIcon = meta.icon
                return (
                  <li className="pr-context-review" key={review.id}>
                    <RemoteAvatar url={review.authorAvatarUrl} login={review.authorLogin} />
                    <div className="pr-context-review-main">
                      <div className="pr-context-review-byline">
                        <strong>{review.authorLogin}</strong>
                        <span className="pr-context-review-state" data-tone={meta.tone}>
                          {StateIcon == null ? null : <StateIcon aria-hidden="true" />}
                          {meta.label}
                        </span>
                        {review.submittedAt == null ? null : (
                          <span className="pr-context-review-age">{formatCommentAge(review.submittedAt, now)}</span>
                        )}
                      </div>
                      {review.body.trim() === '' ? null : (
                        <GitHubMarkdownContent source={review.body} className="pr-context-review-body" />
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
