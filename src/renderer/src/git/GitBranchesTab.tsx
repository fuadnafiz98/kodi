import { useState } from 'react'
import { IconBranch, IconCheck, IconInReview, IconRefresh, IconSearch } from '@pierre/icons'

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
  // Local to the tab, so typing re-renders the list and nothing above it.
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const branches = integration?.branches ?? []
  const visible = needle === ''
    ? branches
    : branches.filter((branch) => branch.name.toLowerCase().includes(needle))
  return (
    <section className="branch-list" aria-label="Local branches">
      <div className="branch-toolbar">
        <label className="branch-filter">
          <IconSearch aria-hidden="true" />
          <input type="search" name="branch-filter" aria-label="Filter branches" placeholder="Filter branches"
            value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="branch-compare-base">
          <label htmlFor="branch-base">Compare with</label>
          <SelectControl>
            <select id="branch-base" name="branch-base" value={baseBranch} onChange={(event) => onBaseBranchChange(event.target.value)}>
              {branches.map((branch) => <option key={branch.name} value={branch.name}>{branch.name}</option>)}
            </select>
          </SelectControl>
        </div>
      </div>
      {visible.length === 0 && needle !== '' ? (
        <div className="git-panel-state"><strong>No matching branches</strong><span>Nothing local matches “{query.trim()}”.</span></div>
      ) : null}
      {visible.map((branch) => {
        const branchKey = `branch:${branch.name}`
        const compareKey = `compare:${branch.name}`
        return (
          <article key={branch.name} className={`branch-row ${branch.current ? 'current' : ''}`}>
            {branch.current ? <IconCheck aria-hidden="true" /> : <IconBranch aria-hidden="true" />}
            <span><strong>{branch.name}</strong>{branch.upstream != null ? <small>{branch.upstream}</small> : null}</span>
            {branch.current ? <em>Current</em> : null}
            <div className="branch-row-actions">
              {branch.name !== baseBranch ? <button type="button" onClick={() => onReviewLocalBranch(baseBranch, branch.name)} disabled={actionKey === compareKey} aria-busy={actionKey === compareKey} title={`Review ${branch.name} against ${baseBranch}`}>{actionKey === compareKey ? <IconRefresh className="spin" /> : <IconInReview />}Compare</button> : null}
              {!branch.current ? <button type="button" onClick={() => onSwitchBranch(branch.name)} disabled={mutating} aria-busy={actionKey === branchKey}><ActionIcon busy={actionKey === branchKey} />Switch</button> : null}
            </div>
          </article>
        )
      })}
      {integration != null && integration.remoteBranches.length > 0 && needle === '' ? (
        <div className="remote-branch-summary"><strong>Remote branches</strong>{integration.remoteBranches.map((branch) => <span key={branch.name}>{branch.name}</span>)}</div>
      ) : null}
    </section>
  )
}
