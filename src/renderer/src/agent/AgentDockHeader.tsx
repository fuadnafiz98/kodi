import { IconCommentAdd, IconSparkles, IconX } from '@pierre/icons'

export interface AgentDockHeaderProps {
  streaming: boolean
  /** The provider is signed in, so a question can actually be sent. */
  ready: boolean
  /** A conversation exists, so there is something to reset. */
  started: boolean
  onReset(): void
  onClose(): void
}

export function AgentDockHeader({
  streaming,
  ready,
  started,
  onReset,
  onClose
}: AgentDockHeaderProps): React.JSX.Element {
  return (
    <header className="agent-dock-header">
      <div className="agent-dock-title">
        <IconSparkles aria-hidden="true" />
        <span>Agent</span>
      </div>
      <div className={`agent-header-state ${streaming ? 'running' : ready ? 'connected' : 'disconnected'}`}
        role="status" aria-live="polite">
        <i aria-hidden="true" />
        <span>{streaming ? 'Working' : ready ? 'Ready' : 'Offline'}</span>
      </div>
      <div className="agent-dock-header-actions">
        {started ? (
          <button type="button" onClick={onReset} aria-label="New conversation" title="New conversation">
            <IconCommentAdd />
          </button>
        ) : null}
        <button type="button" onClick={onClose} aria-label="Close agent panel" title="Close">
          <IconX />
        </button>
      </div>
    </header>
  )
}
