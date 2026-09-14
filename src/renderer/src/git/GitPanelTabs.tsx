import { IconBraces, IconBranch, IconBrandGithub, IconCodeFolder } from '@pierre/icons'

import type { GitIntegrationSnapshot } from '../../../shared/contracts'
import type { RepositoryPanelTab } from './useGitWorkflow'

export interface GitPanelTabsProps {
  tab: RepositoryPanelTab
  integration: GitIntegrationSnapshot | null
  pullRequestCount: number
  onTabChange(tab: RepositoryPanelTab): void
}

export function GitPanelTabs({
  tab,
  integration,
  pullRequestCount,
  onTabChange
}: GitPanelTabsProps): React.JSX.Element {
  return (
    <div className="git-panel-tabs" role="tablist" aria-label="Repository data">
      <button type="button" role="tab" aria-selected={tab === 'history'} className={tab === 'history' ? 'active' : undefined} onClick={() => onTabChange('history')}>
        <IconBraces />History <span>{integration?.commits.length ?? 0}</span>
      </button>
      <button type="button" role="tab" aria-selected={tab === 'branches'} className={tab === 'branches' ? 'active' : undefined} onClick={() => onTabChange('branches')}>
        <IconBranch />Branches <span>{integration?.branches.length ?? 0}</span>
      </button>
      <button type="button" role="tab" aria-selected={tab === 'remotes'} className={tab === 'remotes' ? 'active' : undefined} onClick={() => onTabChange('remotes')}>
        <IconCodeFolder />Remotes <span>{integration?.remotes.length ?? 0}</span>
      </button>
      <button type="button" role="tab" aria-selected={tab === 'pull-requests'} className={tab === 'pull-requests' ? 'active' : undefined} onClick={() => onTabChange('pull-requests')}>
        <IconBrandGithub />Pull requests <span>{pullRequestCount}</span>
      </button>
    </div>
  )
}
