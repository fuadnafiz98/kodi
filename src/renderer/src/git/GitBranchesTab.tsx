import { IconInReview, IconRefresh, IconSwitch } from '@pierre/icons'

import type { GitIntegrationSnapshot } from '../../../shared/contracts'
import { ActionIcon } from './GitActionIcon'
import { SelectControl } from '../settings/SelectControl'

export interface GitBranchesTabProps {
  integration: GitIntegrationSnapshot | null
  actionKey: string | null
  /** Any action holding the index or HEAD, which blocks a switch. */
  mutating: boolean
  baseBranch: string
  onBaseBranchChange(name: string): void
  onSwitchBranch(name: string): void
  onReviewLocalBranch(baseRef: string, headRef: string): void
}

export function GitBranchesTab({
  integration,
  actionKey,
  mutating,
  baseBranch,
  onBaseBranchChange,
  onSwitchBranch,
  onReviewLocalBranch
}: GitBranchesTabProps): React.JSX.Element {
  return (
    <section className="branch-list" aria-label="Local branches">
      <div className="branch-compare-base">
        <label htmlFor="branch-base">Comparison base</label>
        <SelectControl>
          <select id="branch-base" value={baseBranch} onChange={(event) => onBaseBranchChange(event.target.value)}>
            {integration?.branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
          </select>
        </SelectControl>
      </div>
      {integration?.branches.map((branch) => {
        const branchKey = `branch:${branch.name}`
        const compareKey = `compare:${branch.name}`
        return (
          <article key={branch.name} className={`branch-row ${branch.current ? 'current' : ''}`}>
            <IconSwitch />
            <span><strong>{branch.name}</strong>{branch.upstream != null ? <small>{branch.upstream}</small> : null}</span>
            {branch.current ? <em>Current</em> : null}
            <div>
              {branch.name !== baseBranch ? <button type="button" onClick={() => onReviewLocalBranch(baseBranch, branch.name)} disabled={actionKey === compareKey} aria-busy={actionKey === compareKey}>{actionKey === compareKey ? <IconRefresh className="spin" /> : <IconInReview />}Compare</button> : null}
              {!branch.current ? <button type="button" onClick={() => onSwitchBranch(branch.name)} disabled={mutating} aria-busy={actionKey === branchKey}><ActionIcon busy={actionKey === branchKey} />Switch</button> : null}
            </div>
          </article>
        )
      })}
      {integration != null && integration.remoteBranches.length > 0 ? (
        <div className="remote-branch-summary"><strong>Remote branches</strong>{integration.remoteBranches.map((branch) => <span key={branch.name}>{branch.name}</span>)}</div>
      ) : null}
    </section>
  )
}
