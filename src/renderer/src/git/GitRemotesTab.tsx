import { IconCodeFolder } from '@pierre/icons'

import type { GitIntegrationSnapshot } from '../../../shared/contracts'

export interface GitRemotesTabProps {
  integration: GitIntegrationSnapshot | null
}

export function GitRemotesTab({ integration }: GitRemotesTabProps): React.JSX.Element {
  return (
    <section className="remote-list" aria-label="Git remotes">
      {integration?.remotes.length === 0 ? <div className="git-panel-state"><strong>No remotes</strong><span>Add a Git remote to fetch, pull, and push.</span></div> : null}
      {integration?.remotes.map((remote) => (
        <article key={remote.name}>
          <IconCodeFolder />
          <div><strong>{remote.name}</strong><code>{remote.fetchUrl}</code>{remote.pushUrl !== remote.fetchUrl ? <code>{remote.pushUrl}</code> : null}</div>
        </article>
      ))}
    </section>
  )
}
