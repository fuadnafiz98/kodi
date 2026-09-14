import type { Ref } from 'react'
import { IconArrow, IconChevronSm, IconGear, IconX } from '@pierre/icons'

import type { AgentAccessMode, AgentModelOption, AgentProvider } from '../../../shared/contracts'
import { agentAttachmentId, formatAgentAttachment, type AgentAttachment } from './agentAttachments'
import { ACCESS_MODES, EFFORT_LABELS } from './agentPanelOptions'
import { AgentSettingsPanel } from './AgentSettingsPanel'
import type { ConfirmRequest } from '../app/ConfirmDialog'

export interface AgentComposerProps {
  draft: string
  composerRef: Ref<HTMLTextAreaElement>
  ready: boolean
  streaming: boolean
  /** A conversation exists, so the placeholder asks for a follow-up. */
  started: boolean
  settingsOpen: boolean
  attachments: readonly AgentAttachment[]
  provider: AgentProvider
  model: string
  effort: string
  accessMode: AgentAccessMode
  accessModeLocked: boolean
  models: readonly AgentModelOption[]
  efforts: readonly string[]
  loadingModels: boolean
  selectedModel: AgentModelOption | undefined
  onDraftChange(draft: string): void
  onSend(prompt: string): void
  onSettingsToggle(): void
  onRemoveAttachment(id: string): void
  onProviderChange(provider: AgentProvider): void
  onModelChange(model: string): void
  onEffortChange(effort: string): void
  onAccessModeChange(accessMode: AgentAccessMode): void
  onConfirm(request: ConfirmRequest): Promise<boolean>
  onCancel(): void
}

export function AgentComposer({
  draft,
  composerRef,
  ready,
  streaming,
  started,
  settingsOpen,
  attachments,
  provider,
  model,
  effort,
  accessMode,
  accessModeLocked,
  models,
  efforts,
  loadingModels,
  selectedModel,
  onDraftChange,
  onSend,
  onSettingsToggle,
  onRemoveAttachment,
  onProviderChange,
  onModelChange,
  onEffortChange,
  onAccessModeChange,
  onConfirm,
  onCancel
}: AgentComposerProps): React.JSX.Element {
  return (
    <div className="agent-composer">
      <form onSubmit={(event) => { event.preventDefault(); onSend(draft) }}>
        {attachments.length > 0 ? (
          <div className="agent-attachments" aria-label="Attached selections">
            {attachments.map((attachment) => {
              const id = agentAttachmentId(attachment)
              const label = formatAgentAttachment(attachment)
              return (
                <span className="agent-attachment" key={id}
                  title={`${attachment.subject.repositoryName} · ${attachment.path} · ${attachment.side === 'deletions' ? 'old' : 'new'} side`}>
                  <code>{label}</code>
                  <button type="button" onClick={() => onRemoveAttachment(id)}
                    aria-label={`Remove ${label}`}><IconX /></button>
                </span>
              )
            })}
          </div>
        ) : null}
        <textarea ref={composerRef} value={draft} name="agent-question" rows={1} disabled={!ready}
          placeholder={!ready ? `Connect ${provider === 'claude' ? 'Claude Code' : 'Codex'} to continue…`
            : started ? 'Send a follow-up…' : 'Ask about this code…'}
          aria-label={started ? 'Send a follow-up' : 'Ask about this code'}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            event.preventDefault()
            onSend(draft)
          }} />
        {settingsOpen ? (
          <AgentSettingsPanel
            provider={provider}
            model={model}
            effort={effort}
            accessMode={accessMode}
            accessModeLocked={accessModeLocked}
            models={models}
            efforts={efforts}
            loadingModels={loadingModels}
            selectedModel={selectedModel}
            onProviderChange={onProviderChange}
            onModelChange={onModelChange}
            onEffortChange={onEffortChange}
            onAccessModeChange={onAccessModeChange}
            onConfirm={onConfirm}
          />
        ) : null}
        <div className="agent-composer-actions">
          <button type="button" className="agent-config-toggle" aria-expanded={settingsOpen}
            onClick={onSettingsToggle} title="Agent settings">
            <IconGear aria-hidden="true" />
            <span>{provider === 'claude' ? 'Claude Code' : 'Codex'} · {selectedModel?.label ?? model}</span>
            <small>{ACCESS_MODES[accessMode].label} · {EFFORT_LABELS[effort] ?? (effort || 'Standard')}</small>
            <IconChevronSm className="agent-config-chevron" aria-hidden="true" />
          </button>
          {streaming ? (
            <button type="button" className="agent-send stopping" onClick={onCancel}
              aria-label="Stop the answer" title="Stop"><span className="agent-stop-icon" aria-hidden="true" /></button>
          ) : (
            <button type="submit" className="agent-send" disabled={draft.trim() === '' || !ready}
              aria-label="Send message" title="Send message"><IconArrow /></button>
          )}
        </div>
      </form>
    </div>
  )
}
