import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import './AgentPanel.css'

import type {
  AgentAccessMode, AgentActivityUpdate, AgentApprovalDecision,
  AgentApprovalRequest, AgentModelOption, AgentProvider, AgentProviderStatuses,
  AgentUsageUpdate
} from '../../../shared/contracts'
import { agentAttachmentId, type AgentAttachment } from './agentAttachments'
import { AgentComposer } from './AgentComposer'
import { AgentCurrentTurn } from './AgentCurrentTurn'
import { AgentDockHeader } from './AgentDockHeader'
import { AgentEmptyState } from './AgentEmptyState'
import { ProviderConnection } from './AgentProviderConnection'
import { AgentTurn } from './AgentTurn'
import type { ConfirmRequest } from '../app/ConfirmDialog'
import type { MarkdownBlock } from '../markdown/markdown'
import type { AgentReference, AgentTurnRecord } from './useAgentAnswer'

interface AgentPanelProps {
  answer: string
  blocks: MarkdownBlock[]
  streaming: boolean
  error: string | null
  question: string
  references: readonly AgentReference[]
  activity: readonly AgentActivityUpdate[]
  approvals: readonly AgentApprovalRequest[]
  usage: AgentUsageUpdate | null
  history: readonly AgentTurnRecord[]
  chatId: string
  startedAt: number | null
  completedAt: number | null
  provider: AgentProvider
  model: string
  effort: string
  accessMode: AgentAccessMode
  accessModeLocked: boolean
  models: readonly AgentModelOption[]
  efforts: readonly string[]
  loadingModels: boolean
  statuses: AgentProviderStatuses
  loadingStatuses: boolean
  authenticatingProvider: AgentProvider | null
  statusError: string | null
  attachments: readonly AgentAttachment[]
  /** Text for the composer (Ask agent on a review comment), once per id. */
  prefill?: { id: number; text: string } | null
  contextLabel: string
  onProviderChange(provider: AgentProvider): void
  onModelChange(model: string): void
  onEffortChange(effort: string): void
  onAccessModeChange(accessMode: AgentAccessMode): void
  onConfirm(request: ConfirmRequest): Promise<boolean>
  onRefreshStatuses(): void
  onLogin(provider: AgentProvider): void
  onApprovalDecision(requestId: string, decision: AgentApprovalDecision): void
  onRemoveAttachment(id: string): void
  onAsk(prompt: string): void
  onCancel(): void
  onReset(): void
  onOpenChat(id: string): void
  onOpenReference?(reference: AgentReference): void
  onDeleteChat(id: string): void
  onClose(): void
}

let lastPrefillId = 0
function takePrefill(id: number): boolean {
  if (id <= lastPrefillId) return false
  lastPrefillId = id
  return true
}

export const AgentPanel = memo(function AgentPanel({
  answer, blocks, streaming, error, question, references, activity, approvals, usage, history, chatId,
  startedAt, completedAt, provider, model, effort, accessMode, accessModeLocked, models, efforts,
  loadingModels, statuses, loadingStatuses, authenticatingProvider, statusError,
  attachments, prefill = null, contextLabel, onProviderChange, onModelChange, onEffortChange,
  onAccessModeChange, onConfirm, onRefreshStatuses, onLogin, onApprovalDecision,
  onRemoveAttachment, onAsk, onCancel, onReset, onOpenChat, onOpenReference, onDeleteChat, onClose
}: AgentPanelProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const transcriptRef = useRef<HTMLDivElement>(null)
  useFollowTranscriptEnd(transcriptRef)
  const started = history.length > 0 || question !== '' || blocks.length > 0 || activity.length > 0 || error != null
  const providerStatus = statuses[provider]
  const ready = providerStatus.authenticated
  const selectedModel = useMemo(
    () => models.find((option) => option.id === model),
    [model, models]
  )
  const liveLabel = useAgentLiveLabel(activity, blocks.length > 0)

  const latestAttachment = attachments.at(-1)
  const latestAttachmentId = latestAttachment == null ? null : agentAttachmentId(latestAttachment)
  useEffect(() => {
    if (latestAttachmentId != null) composerRef.current?.focus()
  }, [latestAttachmentId])
  const prefillId = prefill?.id ?? null
  const prefillText = prefill?.text ?? ''
  useEffect(() => {
    // Once: a dock reopened later must not put an old question back.
    if (prefillId == null || !takePrefill(prefillId)) return
    setDraft(prefillText)
    composerRef.current?.focus()
  }, [prefillId, prefillText])

  const send = (prompt: string): void => {
    const trimmed = prompt.trim()
    if (trimmed === '' || streaming || !ready) return
    setSettingsOpen(false)
    onAsk(trimmed)
    setDraft('')
  }

  return (
    <aside className="agent-dock" aria-label="Agent">
      <AgentDockHeader streaming={streaming} ready={ready} started={started} currentChatId={chatId}
        onReset={onReset} onOpenChat={onOpenChat} onDeleteChat={onDeleteChat} onClose={onClose} />

      <div className="agent-dock-transcript" ref={transcriptRef}>
        {!ready || statusError != null ? (
          <ProviderConnection provider={provider} status={providerStatus} loading={loadingStatuses}
            authenticating={authenticatingProvider === provider} error={statusError}
            onRefresh={onRefreshStatuses} onLogin={() => onLogin(provider)} />
        ) : null}

        {started ? null : (
          <AgentEmptyState contextLabel={contextLabel} streaming={streaming} ready={ready}
            onAsk={onAsk} onCloseSettings={() => setSettingsOpen(false)} />
        )}

        {history.map((turn) => <AgentTurn key={turn.id} turn={turn} onOpenReference={onOpenReference} />)}

        <AgentCurrentTurn
          question={question}
          references={references}
          onOpenReference={onOpenReference}
          blocks={blocks}
          answer={answer}
          error={error}
          streaming={streaming}
          activity={activity}
          approvals={approvals}
          usage={usage}
          startedAt={startedAt}
          completedAt={completedAt}
          provider={provider}
          modelLabel={selectedModel?.label ?? model}
          effort={effort}
          accessMode={accessMode}
          liveLabel={liveLabel}
          onApprovalDecision={onApprovalDecision}
        />
        <span className="agent-scroll-anchor" aria-hidden="true" />
      </div>

      <AgentComposer
        draft={draft}
        composerRef={composerRef}
        ready={ready}
        streaming={streaming}
        started={started}
        settingsOpen={settingsOpen}
        attachments={attachments}
        provider={provider}
        model={model}
        effort={effort}
        accessMode={accessMode}
        accessModeLocked={accessModeLocked}
        models={models}
        efforts={efforts}
        loadingModels={loadingModels}
        selectedModel={selectedModel}
        onDraftChange={setDraft}
        onSend={send}
        onSettingsToggle={() => setSettingsOpen((open) => !open)}
        onRemoveAttachment={onRemoveAttachment}
        onProviderChange={onProviderChange}
        onModelChange={onModelChange}
        onEffortChange={onEffortChange}
        onAccessModeChange={onAccessModeChange}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    </aside>
  )
})

/** What the timeline says the agent is doing, for the live status line. */
function useAgentLiveLabel(
  activity: readonly AgentActivityUpdate[],
  hasAnswerBlocks: boolean
): string {
  const latestRunning = useMemo(() => {
    for (let index = activity.length - 1; index >= 0; index -= 1) {
      const item = activity[index]
      if (item?.status === 'running' || item?.status === 'waiting') return item
    }
    return undefined
  }, [activity])
  if (latestRunning?.status === 'waiting') return 'Waiting for approval'
  return latestRunning?.title || (hasAnswerBlocks ? 'Writing answer' : 'Inspecting repository')
}

// Within this of the end still counts as reading the end.
const FOLLOW_SLACK_PX = 24

/**
 * Keeps a reader who is at the end of the transcript at the end as it grows:
 * a streaming answer, and the usage and Copy answer rows that land under it
 * when it finishes. Nothing followed before, so a long answer ran out under the
 * composer and its last rows sat below the fold. A reader who scrolls up to
 * reread is left where they are until they come back down.
 */
function useFollowTranscriptEnd(transcriptRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const transcript = transcriptRef.current
    if (transcript == null) return
    let following = true
    let frame = 0
    const onScroll = (): void => {
      following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= FOLLOW_SLACK_PX
    }
    // One scroll per frame however many tokens landed in it.
    const observer = new MutationObserver(() => {
      if (!following || frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (following) transcript.scrollTop = transcript.scrollHeight
      })
    })
    observer.observe(transcript, { childList: true, subtree: true, characterData: true })
    transcript.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      observer.disconnect()
      transcript.removeEventListener('scroll', onScroll)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [transcriptRef])
}
