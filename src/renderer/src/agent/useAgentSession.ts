import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  AgentAccessMode,
  AgentModelCatalog,
  AgentModelOption,
  AgentProvider,
  AgentProviderStatuses,
  AgentRequestSubject
} from '../../../shared/contracts'
import {
  agentAttachmentId,
  agentSubjectKey,
  attachAgentSelection,
  describeAgentAttachments,
  mergeAgentAttachments,
  type AgentAttachment,
  type AgentSelection
} from './agentAttachments'
import { useAgentAnswer, type AgentAnswerApi } from './useAgentAnswer'
import { getErrorMessage } from '../explorer/repositoryApi'

interface AgentSessionOptions {
  /** Sent alongside the question so the agent sees the change under review. */
  context: string
  subject: AgentRequestSubject | null
}

// Everything the agent panel needs: whether it is docked open, which provider
// answers, and which selections are attached to the next question.
export interface AgentSessionApi {
  answer: AgentAnswerApi
  open: boolean
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
  setProvider(provider: AgentProvider): void
  setModel(model: string): void
  setEffort(effort: string): void
  setAccessMode(accessMode: AgentAccessMode): void
  refreshStatuses(): void
  login(provider: AgentProvider): void
  /** `prompt` fills the composer, as Ask agent on a review comment does. */
  attach(selection: AgentSelection, prompt?: string): void
  /** Text the composer should take, once per id. */
  prefill: { id: number; text: string } | null
  removeAttachment(id: string): void
  ask(prompt: string): void
  toggle(): void
  close(): void
}

interface ProviderSelection {
  model: string
  effort: string
}

const DEFAULT_CATALOG: AgentModelCatalog = {
  claude: [{
    id: 'sonnet',
    label: 'Claude Sonnet',
    description: 'Uses the latest Sonnet model available to Claude Code.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    default: true
  }],
  codex: [{
    id: 'default',
    label: 'Codex default',
    description: 'Uses the default model in your Codex configuration.',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    defaultEffort: 'high',
    default: true
  }]
}

const AGENT_SETTINGS_KEY = 'kodi:agent-settings:v2'
const MAX_ATTACHMENT_TEXT_LENGTH = 40_000
const MAX_ATTACHMENTS_PER_TAB = 8
const MAX_ATTACHMENT_TABS = 12
const NO_ATTACHMENTS: readonly AgentAttachment[] = []
// Sign-in happens in a browser the app cannot see, so it is polled — but an
// abandoned sign-in used to poll two CLI probes a second forever.
const AUTH_POLL_START_MS = 2_000
const AUTH_POLL_MAX_MS = 30_000
const AUTH_POLL_GIVE_UP_MS = 120_000
const DEFAULT_STATUSES: AgentProviderStatuses = {
  claude: {
    provider: 'claude',
    installed: true,
    authenticated: false,
    label: 'Checking connection',
    detail: 'Checking Claude Code.'
  },
  codex: {
    provider: 'codex',
    installed: true,
    authenticated: false,
    label: 'Checking connection',
    detail: 'Checking Codex.'
  }
}

function loadAgentSettings(): {
  provider: AgentProvider
  accessMode: AgentAccessMode
  selections: Record<AgentProvider, ProviderSelection>
} {
  const fallback = {
    provider: 'claude' as AgentProvider,
    accessMode: 'auto' as AgentAccessMode,
    selections: {
      claude: { model: 'sonnet', effort: 'high' },
      codex: { model: 'default', effort: 'high' }
    }
  }
  try {
    const value = JSON.parse(localStorage.getItem(AGENT_SETTINGS_KEY) ?? '') as Partial<typeof fallback>
    return {
      provider: value.provider === 'codex' ? 'codex' : 'claude',
      accessMode: value.accessMode === 'review' ? 'review' : 'auto',
      selections: {
        claude: value.selections?.claude ?? fallback.selections.claude,
        codex: value.selections?.codex ?? fallback.selections.codex
      }
    }
  } catch {
    return fallback
  }
}

export function useAgentSession({ context, subject }: AgentSessionOptions): AgentSessionApi {
  const answer = useAgentAnswer()
  const initialSettings = useMemo(loadAgentSettings, [])
  const [open, setOpen] = useState(false)
  const [prefill, setPrefill] = useState<{ id: number; text: string } | null>(null)
  const [provider, setProvider] = useState<AgentProvider>(initialSettings.provider)
  const [configuredAccessMode, setConfiguredAccessMode] = useState<AgentAccessMode>(initialSettings.accessMode)
  const [selections, setSelections] = useState(initialSettings.selections)
  const [catalog, setCatalog] = useState<AgentModelCatalog>(DEFAULT_CATALOG)
  const [loadingModels, setLoadingModels] = useState(false)
  const [statuses, setStatuses] = useState<AgentProviderStatuses>(DEFAULT_STATUSES)
  const [loadingStatuses, setLoadingStatuses] = useState(false)
  const [authenticatingProvider, setAuthenticatingProvider] = useState<AgentProvider | null>(null)
  const authenticatingProviderRef = useRef(authenticatingProvider)
  useEffect(() => {
    authenticatingProviderRef.current = authenticatingProvider
  }, [authenticatingProvider])
  const [statusError, setStatusError] = useState<string | null>(null)
  const [attachmentsBySubject, setAttachmentsBySubject] = useState<
    Readonly<Record<string, readonly AgentAttachment[]>>
  >({})
  const subjectKey = subject == null ? null : agentSubjectKey(subject)
  const attachments = subjectKey == null ? NO_ATTACHMENTS : attachmentsBySubject[subjectKey] ?? NO_ATTACHMENTS
  const accessModeLocked = subject != null && subject.source !== 'workingTree'
  const accessMode = accessModeLocked ? 'review' : configuredAccessMode

  const models = catalog[provider]
  const selected = selections[provider]
  const selectedModel = models.find((model) => model.id === selected.model) ??
    models.find((model) => model.default === true) ?? models[0]!
  const model = selectedModel.id
  const efforts = selectedModel.efforts
  const effort = efforts.includes(selected.effort) ? selected.effort : selectedModel.defaultEffort

  useEffect(() => {
    try {
      const persistedAccessMode = configuredAccessMode === 'full-access' ? 'auto' : configuredAccessMode
      localStorage.setItem(AGENT_SETTINGS_KEY, JSON.stringify({
        provider,
        accessMode: persistedAccessMode,
        selections
      }))
    } catch {
      // The settings are optional when storage is blocked or full.
    }
  }, [configuredAccessMode, provider, selections])

  useEffect(() => {
    if (!open || window.repository == null) return
    let active = true
    setLoadingModels(true)
    void window.repository.getAgentModels()
      .then((models) => {
        if (active) setCatalog(models)
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingModels(false)
      })
    return () => { active = false }
  }, [open])

  const probeStatuses = useCallback((only: AgentProvider | null) => {
    const repository = window.repository
    if (repository == null) return
    setLoadingStatuses(true)
    setStatusError(null)
    void repository.getAgentStatuses(only ?? undefined)
      .then((next) => {
        setStatuses(next)
        const authenticating = authenticatingProviderRef.current
        if (authenticating != null && next[authenticating].authenticated) {
          setAuthenticatingProvider(null)
        }
      })
      .catch((error: unknown) => setStatusError(getErrorMessage(error)))
      .finally(() => setLoadingStatuses(false))
  }, [])

  const refreshStatuses = useCallback(() => { probeStatuses(null) }, [probeStatuses])

  useEffect(() => {
    if (!open) return
    refreshStatuses()
  }, [open, refreshStatuses])

  useEffect(() => {
    if (!open || authenticatingProvider == null) return
    // Only the provider being signed into is re-probed, the interval backs off,
    // and an unfinished sign-in stops asking instead of spawning forever.
    let delay = AUTH_POLL_START_MS
    let timer = 0
    const startedAt = Date.now()
    const poll = (): void => {
      if (Date.now() - startedAt > AUTH_POLL_GIVE_UP_MS) {
        setAuthenticatingProvider(null)
        setStatusError('Still waiting for sign-in. Finish it in your browser, then check the connection.')
        return
      }
      probeStatuses(authenticatingProvider)
      delay = Math.min(delay * 2, AUTH_POLL_MAX_MS)
      timer = window.setTimeout(poll, delay)
    }
    timer = window.setTimeout(poll, delay)
    return () => window.clearTimeout(timer)
  }, [authenticatingProvider, open, probeStatuses])

  const login = useCallback((nextProvider: AgentProvider) => {
    const repository = window.repository
    if (repository == null) return
    setAuthenticatingProvider(nextProvider)
    setStatusError(null)
    void repository.loginAgent(nextProvider).catch((error: unknown) => {
      setAuthenticatingProvider(null)
      setStatusError(getErrorMessage(error))
    })
  }, [])

  const setModel = useCallback((nextModel: string) => {
    const option = catalog[provider].find((candidate) => candidate.id === nextModel)
    if (option == null) return
    setSelections((current) => ({
      ...current,
      [provider]: { model: nextModel, effort: option.defaultEffort }
    }))
  }, [catalog, provider])

  const setEffort = useCallback((nextEffort: string) => {
    setSelections((current) => ({
      ...current,
      [provider]: { ...current[provider], effort: nextEffort }
    }))
  }, [provider])

  const attach = useCallback((selection: AgentSelection, prompt?: string) => {
    setOpen(true)
    if (subject == null || subjectKey == null) {
      setStatusError('Select code in a repository tab before adding it to the agent.')
      return
    }
    if (selection.selectedText.length > MAX_ATTACHMENT_TEXT_LENGTH) {
      setStatusError('That selection is too large. Select a smaller region of code.')
      return
    }
    const attachment = attachAgentSelection(subject, selection)
    setStatusError(null)
    if (prompt != null && prompt !== '') setPrefill((current) => ({ id: (current?.id ?? 0) + 1, text: prompt }))
    setAttachmentsBySubject((current) => {
      const nextForSubject = mergeAgentAttachments(current[subjectKey] ?? [], attachment)
        .slice(-MAX_ATTACHMENTS_PER_TAB)
      const next = { ...current, [subjectKey]: nextForSubject }
      const keys = Object.keys(next)
      if (keys.length > MAX_ATTACHMENT_TABS) delete next[keys[0]!]
      return next
    })
  }, [subject, subjectKey])

  const removeAttachment = useCallback((id: string) => {
    if (subjectKey == null) return
    setAttachmentsBySubject((current) => ({
      ...current,
      [subjectKey]: (current[subjectKey] ?? []).filter(
        (attachment) => agentAttachmentId(attachment) !== id
      )
    }))
  }, [subjectKey])

  // Reading the tab/review summary from a ref keeps `ask` stable while an answer
  // streams instead of rebuilding this callback on every token.
  const contextRef = useRef(context)
  useEffect(() => {
    contextRef.current = context
  }, [context])

  const askAnswer = answer.ask
  const ask = useCallback((prompt: string) => {
    if (subject == null || subjectKey == null) {
      setStatusError('Open a repository tab before asking the agent.')
      return
    }
    askAnswer({
      provider,
      model,
      effort,
      accessMode,
      prompt: describeAgentAttachments(attachments, prompt),
      context: contextRef.current,
      question: prompt,
      subject,
      selections: attachments.map(({ subject: _subject, ...selection }) => selection),
      sessionScope: subjectKey
    })
    setAttachmentsBySubject((current) => ({ ...current, [subjectKey]: NO_ATTACHMENTS }))
  }, [accessMode, askAnswer, attachments, effort, model, provider, subject, subjectKey])

  const toggle = useCallback(() => setOpen((current) => !current), [])
  const close = useCallback(() => setOpen(false), [])

  return useMemo(() => ({
    answer,
    open,
    provider,
    model,
    effort,
    accessMode,
    accessModeLocked,
    models,
    efforts,
    loadingModels,
    statuses,
    loadingStatuses,
    authenticatingProvider,
    statusError,
    attachments,
    setProvider,
    setModel,
    setEffort,
    setAccessMode: setConfiguredAccessMode,
    refreshStatuses,
    login,
    attach,
    prefill,
    removeAttachment,
    ask,
    toggle,
    close
  }), [
    accessMode,
    accessModeLocked,
    answer,
    ask,
    attach,
    attachments,
    authenticatingProvider,
    close,
    effort,
    efforts,
    loadingModels,
    loadingStatuses,
    login,
    model,
    models,
    open,
    prefill,
    provider,
    refreshStatuses,
    removeAttachment,
    setEffort,
    setModel,
    statusError,
    statuses,
    toggle
  ])
}
