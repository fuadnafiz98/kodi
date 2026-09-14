import { IconInReview, IconRefresh } from '@pierre/icons'

import type { GitIntegrationSnapshot } from '../../../shared/contracts'
import { formatRelativeDate } from './gitPanelModel'

export interface GitHistoryTabProps {
  integration: GitIntegrationSnapshot | null
  actionKey: string | null
  onReviewCommit(oid: string): void
}

export function GitHistoryTab({ integration, actionKey, onReviewCommit }: GitHistoryTabProps): React.JSX.Element {
  return (
    <section className="commit-list" aria-label="Recent commits">
      {integration?.commits.length === 0 ? <div className="git-panel-state"><strong>No commits</strong><span>This repository has no commit history.</span></div> : null}
      {integration?.commits.map((commit) => (
        <article className="commit-row" key={commit.oid}>
          <span className="commit-node" aria-hidden="true" />
          <div>
            <strong>{commit.subject}</strong>
            <span>{commit.authorName} · {formatRelativeDate(commit.authoredAt)}</span>
            {commit.decorations.length > 0 ? <div>{commit.decorations.map((decoration) => <em key={decoration}>{decoration}</em>)}</div> : null}
          </div>
          <code>{commit.shortOid}</code>
          <button type="button" onClick={() => onReviewCommit(commit.oid)}
            disabled={actionKey === `commit:${commit.oid}`} aria-busy={actionKey === `commit:${commit.oid}`}
            aria-label={`Review commit ${commit.shortOid}`}>
            {actionKey === `commit:${commit.oid}` ? <IconRefresh className="spin" /> : <IconInReview />}
          </button>
        </article>
      ))}
    </section>
  )
}
