import { IconRefresh } from '@pierre/icons'

import type { AgentProvider, AgentProviderStatuses } from '../../../shared/contracts'

export function ProviderConnection({ provider, status, loading, authenticating, error, onRefresh, onLogin }: {
  provider: AgentProvider
  status: AgentProviderStatuses[AgentProvider]
  loading: boolean
  authenticating: boolean
  error: string | null
  onRefresh(): void
  onLogin(): void
}): React.JSX.Element {
  const providerLabel = provider === 'claude' ? 'Claude Code' : 'Codex'
  return (
    <section className="agent-connection agent-state-surface" aria-label={`${providerLabel} connection`}>
      <div className="agent-connection-copy">
        <span className="agent-connection-title"><i aria-hidden="true" />{providerLabel}</span>
        <strong>{authenticating ? 'Complete sign-in in your browser' : status.label}</strong>
        <p>{error ?? status.detail}</p>
        {status.version == null ? null : <code>{status.version}</code>}
      </div>
      <div className="agent-connection-actions">
        <button type="button" onClick={onRefresh} disabled={loading} title="Check connection"
          aria-label="Check connection"><IconRefresh className={loading ? 'spin' : ''} /></button>
        <button type="button" className="primary" onClick={onLogin} disabled={authenticating || !status.installed}>
          {authenticating ? 'Waiting…' : 'Sign in'}
        </button>
      </div>
    </section>
  )
}
