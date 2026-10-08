import { lazy, Suspense } from 'react'
import { IconX } from '@pierre/icons'

import { IconSparklesOutline } from '../app/IconSparklesOutline'

import type { useAgentSession } from './useAgentSession'
import type { ConfirmRequest } from '../app/ConfirmDialog'
import type { AgentReference } from './useAgentAnswer'

const AgentPanel = lazy(async () => ({ default: (await import('./AgentPanel')).AgentPanel }))

interface AgentDockProps {
  session: ReturnType<typeof useAgentSession>
  contextLabel: string
  confirm(request: ConfirmRequest): Promise<boolean>
  /** A file reference on a question: opens that file, at those lines on the new side. */
  onOpenReference?(reference: AgentReference): void
}

// The chunk's fallback: the same header the panel renders, so the column does
// not appear as an empty 420px box and the close button works immediately.
function AgentDockShell({ onClose }: { onClose(): void }): React.JSX.Element {
  return (
    <aside className="agent-dock pending" aria-label="Agent">
      <header className="agent-dock-header">
        <div className="agent-dock-title">
          <IconSparklesOutline aria-hidden="true" />
          <span>Agent</span>
        </div>
        <div className="agent-dock-header-actions">
          <button type="button" onClick={onClose} aria-label="Close agent panel" title="Close">
            <IconX />
          </button>
        </div>
      </header>
    </aside>
  )
}

// Keeps the panel's wiring next to the panel: the workspace only decides where
// the column sits, not how the conversation is plumbed together.
export function AgentDock({ session, contextLabel, confirm, onOpenReference }: AgentDockProps): React.JSX.Element | null {
  if (!session.open) return null
  return (
    <Suspense fallback={<AgentDockShell onClose={session.toggle} />}>
      <AgentPanel
        blocks={session.answer.blocks}
        answer={session.answer.answer}
        streaming={session.answer.streaming}
        error={session.answer.error}
        question={session.answer.question}
        references={session.answer.references}
        activity={session.answer.activity}
        approvals={session.answer.approvals}
        usage={session.answer.usage}
        history={session.answer.history}
        chatId={session.answer.chatId}
        startedAt={session.answer.startedAt}
        completedAt={session.answer.completedAt}
        provider={session.provider}
        model={session.model}
        effort={session.effort}
        accessMode={session.accessMode}
        accessModeLocked={session.accessModeLocked}
        models={session.models}
        efforts={session.efforts}
        loadingModels={session.loadingModels}
        statuses={session.statuses}
        loadingStatuses={session.loadingStatuses}
        authenticatingProvider={session.authenticatingProvider}
        statusError={session.statusError}
        attachments={session.attachments}
        prefill={session.prefill}
        contextLabel={contextLabel}
        onProviderChange={session.setProvider}
        onModelChange={session.setModel}
        onEffortChange={session.setEffort}
        onAccessModeChange={session.setAccessMode}
        onConfirm={confirm}
        onRefreshStatuses={session.refreshStatuses}
        onLogin={session.login}
        onApprovalDecision={session.answer.respondToApproval}
        onRemoveAttachment={session.removeAttachment}
        onAsk={session.ask}
        onCancel={session.answer.cancel}
        onReset={session.answer.reset}
        onOpenChat={session.answer.openChat}
        onOpenReference={onOpenReference}
        onDeleteChat={session.answer.deleteChat}
        onClose={session.close}
      />
    </Suspense>
  )
}
