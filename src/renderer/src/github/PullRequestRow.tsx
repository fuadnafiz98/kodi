import { IconApproved, IconBranch, IconInReview, IconMerged, IconRefresh } from '@pierre/icons'

import type {
  InboxPullRequest,
  PullRequestMergeStrategy,
  PullRequestSummary
} from '../../../shared/contracts'
import { ActionIcon } from '../git/GitActionIcon'
import { formatRelativeDate, isMutatingAction } from '../git/gitPanelModel'

export interface PullRequestRowProps {
  summary: PullRequestSummary | InboxPullRequest
  details: PullRequestSummary | undefined
  actionKey: string | null
  onReview(pullRequest: PullRequestSummary): void
  onMerge(pullRequest: PullRequestSummary, strategy: PullRequestMergeStrategy): void
  onMarkReady(pullRequest: PullRequestSummary): void
  onOpenPullRequest(selector: number | string): void
  onCheckout(pullRequest: PullRequestSummary): void
}

export function PullRequestRow({
  summary,
  details,
  actionKey,
  onReview,
  onMerge,
  onMarkReady,
  onOpenPullRequest,
  onCheckout
}: PullRequestRowProps): React.JSX.Element {
  const state = summary.state.toLowerCase()
  const mutating = isMutatingAction(actionKey)
  return (
    <article className="pr-row compact">
      <div className="pr-row-title">
        <span>#{summary.number}</span>
        <strong>{summary.title}</strong>
        {state === 'open' ? null : <em className={`pr-state state-${state}`}>{summary.state}</em>}
        {summary.isDraft ? <em>Draft</em> : null}
      </div>
      <div className="pr-row-meta">
        <span>{summary.author.login}</span>
        {details != null ? <span>{details.headRefName} → {details.baseRefName}</span> : null}
        <span>{formatRelativeDate(summary.updatedAt)}</span>
      </div>
      <div className="pr-row-actions">
        {details != null ? <button type="button" onClick={() => onCheckout(details)}
          disabled={mutating}
          aria-busy={actionKey === `checkout:${summary.number}`}
          aria-label={`Checkout pull request ${summary.number}`} title="Checkout">
          <ActionIcon busy={actionKey === `checkout:${summary.number}`}><IconBranch /></ActionIcon>
        </button> : null}
        {details?.isDraft && details.state.toLowerCase() === 'open' ? (
          <button type="button" onClick={() => onMarkReady(details)}
            disabled={mutating}
            aria-busy={actionKey === `ready:${summary.number}`}
            aria-label={`Mark pull request ${summary.number} ready`} title="Mark ready">
            <ActionIcon busy={actionKey === `ready:${summary.number}`}><IconApproved /></ActionIcon>
          </button>
        ) : null}
        {details?.state.toLowerCase() === 'open' && !details.isDraft ? (
          <button type="button" onClick={() => onMerge(details, 'squash')}
            disabled={mutating}
            aria-busy={actionKey === `merge:${summary.number}`}
            aria-label={`Squash and merge pull request ${summary.number}`} title="Squash and merge">
            <ActionIcon busy={actionKey === `merge:${summary.number}`}><IconMerged /></ActionIcon>
          </button>
        ) : null}
        <button className="primary" type="button"
          onClick={() => details == null ? onOpenPullRequest(summary.number) : onReview(details)}
          disabled={actionKey === `review:${summary.number}`}
          aria-busy={actionKey === `review:${summary.number}`}
          aria-label={`Review pull request ${summary.number}`} title="Review changes">
          {actionKey === `review:${summary.number}` ? <IconRefresh className="spin" /> : <IconInReview />}
        </button>
      </div>
    </article>
  )
}
