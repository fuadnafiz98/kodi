import { IconCommentAdd, IconX } from '@pierre/icons'

import { IconSparklesOutline } from '../app/IconSparklesOutline'
import { AgentChatHistory } from './AgentChatHistory'

export interface AgentDockHeaderProps {
  streaming: boolean
  /** The provider is signed in, so a question can actually be sent. */
  ready: boolean
  /** A conversation exists, so there is something to reset. */
  started: boolean
  currentChatId: string
  onReset(): void
  onOpenChat(id: string): void
  onDeleteChat(id: string): void
  onClose(): void
}

export function AgentDockHeader({
  streaming,
  ready,
  started,
  currentChatId,
  onReset,
  onOpenChat,
  onDeleteChat,
  onClose
}: AgentDockHeaderProps): React.JSX.Element {
  return (
    <header className="agent-dock-header">
      <div className="agent-dock-title">
        <IconSparklesOutline aria-hidden="true" />
        <span>Agent</span>
      </div>
      <div className={`agent-header-state ${streaming ? 'running' : ready ? 'connected' : 'disconnected'}`}
        role="status" aria-live="polite">
        <i aria-hidden="true" />
        <span>{streaming ? 'Working' : ready ? 'Ready' : 'Offline'}</span>
      </div>
      <div className="agent-dock-header-actions">
        <AgentChatHistory currentChatId={currentChatId}
          onOpenChat={onOpenChat} onDeleteChat={onDeleteChat} />
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
