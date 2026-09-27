import type { GitIntegrationSnapshot } from '../../../shared/contracts'
import type { RepositoryPanelTab } from './useGitWorkflow'

export interface GitPanelTabsProps {
  tab: RepositoryPanelTab
  integration: GitIntegrationSnapshot | null
  changeCount: number
  pullRequestCount: number
  onTabChange(tab: RepositoryPanelTab): void
}

export function GitPanelTabs({
  tab,
  integration,
  changeCount,
  pullRequestCount,
  onTabChange
}: GitPanelTabsProps): React.JSX.Element {
  // Five tabs with icons overflowed the 520px panel; the labels carry it alone.
  const tabs: ReadonlyArray<{ id: RepositoryPanelTab; label: string; count: number | null }> = [
    { id: 'changes', label: 'Changes', count: changeCount },
    { id: 'history', label: 'History', count: integration?.commits.length ?? null },
    { id: 'branches', label: 'Branches', count: integration?.branches.length ?? null },
    { id: 'remotes', label: 'Remotes', count: integration?.remotes.length ?? null },
    { id: 'pull-requests', label: 'Pull requests', count: integration == null ? null : pullRequestCount }
  ]
  return (
    <div className="git-panel-tabs" role="tablist" aria-label="Repository data">
      {tabs.map((item) => (
        <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
          className={tab === item.id ? 'active' : undefined} onClick={() => onTabChange(item.id)}>
          {item.label}{item.count == null ? null : <span>{item.count}</span>}
        </button>
      ))}
    </div>
  )
}
