import { IconRefresh } from '@pierre/icons'

import type { GitIntegrationSnapshot } from '../../../shared/contracts'
import { ActionIcon } from './GitActionIcon'
import { formatUpdatedAgo } from './gitPanelModel'

export interface GitSyncBarProps {
  integration: GitIntegrationSnapshot | null
  loading: boolean
  loadingInbox: boolean
  actionKey: string | null
  /** Any action holding the index or HEAD, which blocks fetch/pull/push. */
  mutating: boolean
  syncing: boolean
  /** When the panel data was last fetched, or `null` before the first load. */
  updatedAt: number | null
  /** Ticks with `updatedAt` so the freshness label stays honest. */
  now: number
  onRefresh?(): void
  onFetch(): void
  onPull(): void
  onPush(): void
}

export function GitSyncBar({
  integration,
  loading,
  loadingInbox,
  actionKey,
  mutating,
  syncing,
  updatedAt,
  now,
  onRefresh,
  onFetch,
  onPull,
  onPush
}: GitSyncBarProps): React.JSX.Element {
  const behind = integration?.behind ?? 0
  const ahead = integration?.ahead ?? 0
  return (
    <div className="git-sync-bar" aria-label="Remote synchronization">
      <span className="git-sync-counts" title={`${behind} behind, ${ahead} ahead of upstream`}>
        <span aria-label={`${behind} behind`}>↓{behind}</span>
        <span aria-label={`${ahead} ahead`}>↑{ahead}</span>
      </span>
      {updatedAt == null ? null : (
        <small className="git-sync-freshness">
          {loading || loadingInbox ? 'updating…' : `updated ${formatUpdatedAgo(now - updatedAt)}`}
        </small>
      )}
      <div>
        {onRefresh == null ? null : (
          <button type="button" className="git-sync-refresh" onClick={onRefresh} disabled={syncing}
            aria-label="Refresh repository data" title="Refresh">
            <ActionIcon busy={loading || loadingInbox}><IconRefresh /></ActionIcon>
          </button>
        )}
        <button type="button" onClick={onFetch} disabled={mutating} aria-busy={actionKey === 'sync:fetch'}><ActionIcon busy={actionKey === 'sync:fetch'} />Fetch</button>
        <button type="button" className={behind > 0 ? 'suggested' : undefined} onClick={onPull} disabled={mutating} aria-busy={actionKey === 'sync:pull'}>
          <ActionIcon busy={actionKey === 'sync:pull'} />Pull{behind > 0 ? <span className="git-sync-badge">{behind}</span> : null}
        </button>
        <button type="button" className={ahead > 0 ? 'suggested' : undefined} onClick={onPush} disabled={mutating} aria-busy={actionKey === 'sync:push'}>
          <ActionIcon busy={actionKey === 'sync:push'} />Push{ahead > 0 ? <span className="git-sync-badge">{ahead}</span> : null}
        </button>
      </div>
    </div>
  )
}
