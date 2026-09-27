import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  AgentAccessMode,
  AgentActivityUpdate,
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentProvider,
  AgentRequestSelection,
  AgentRequestSubject,
  AgentStreamEvent,
  AgentUsageUpdate
} from '../../../shared/contracts'
import { getErrorMessage } from '../explorer/repositoryApi'
import {
  appendStreamingMarkdown,
  EMPTY_STREAMING_MARKDOWN,
  type MarkdownBlock,
  type StreamingMarkdown
} from '../markdown/markdown'
import { markAgentStreamEvent } from '../review/reviewMetrics'

const MAX_ANSWER_LENGTH = 200_000

export interface AgentAnswerState {
  answer: string
  streaming: boolean
  error: string | null
  sessionId: string | null
  /** Echoed above the answer so a long stream still shows what was asked. */
  question: string
  /** What the agent did on the way to the answer: tool calls, thinking. */
  activity: readonly AgentActivityUpdate[]
  approvals: readonly AgentApprovalRequest[]
  sessionKey: string | null
  usage: AgentUsageUpdate | null
  history: readonly AgentTurnRecord[]
  provider: AgentProvider | null
  model: string
  effort: string
  accessMode: AgentAccessMode | null
  startedAt: number | null
  completedAt: number | null
  // Parsing lives here rather than in the panel's render so each chunk only
  // parses the tail it added, and so no ref is written during render.
  parsed: StreamingMarkdown
}

export interface AgentAnswerApi extends AgentAnswerState {
  blocks: MarkdownBlock[]
  ask(options: {
    provider: AgentProvider
    model: string
    effort: string
    accessMode: AgentAccessMode
    prompt: string
    context: string
    question?: string
    subject: AgentRequestSubject
    selections: AgentRequestSelection[]
    sessionScope: string
  }): void
  respondToApproval(requestId: string, decision: AgentApprovalDecision): void
  cancel(): void
  reset(): void
}

export interface AgentTurnRecord {
  id: string
  question: string
  answer: string
  blocks: MarkdownBlock[]
  activity: readonly AgentActivityUpdate[]
  error: string | null
  usage: AgentUsageUpdate | null
  provider: AgentProvider | null
  model: string
  effort: string
  accessMode: AgentAccessMode | null
  startedAt: number | null
  completedAt: number | null
}

const MAX_ACTIVITY_ITEMS = 80
const MAX_ACTIVITY_DETAIL_LENGTH = 20_000
const MAX_ACTIVITY_OUTPUT_LENGTH = 12_000
const MAX_HISTORY_TURNS = 20
// At the live caps an archived turn can hold 2.5 M characters of tool detail
// and output, and twenty of them were over 60 MB for one agent panel. Nobody
// reads the full output of a tool call five questions ago; the newest turns
// keep everything, older ones keep enough of each step to recognise it.
const FULL_HISTORY_TURNS = 3
const ARCHIVED_ACTIVITY_DETAIL_LENGTH = 1_000
const ARCHIVED_ACTIVITY_OUTPUT_LENGTH = 2_000

export const EMPTY_ANSWER: AgentAnswerState = {
  answer: '',
  streaming: false,
  error: null,
  sessionId: null,
  question: '',
  activity: [],
  approvals: [],
  sessionKey: null,
  usage: null,
  history: [],
  provider: null,
  model: '',
  effort: '',
  accessMode: null,
  startedAt: null,
  completedAt: null,
  parsed: EMPTY_STREAMING_MARKDOWN
}

function archiveTurn(state: AgentAnswerState): AgentTurnRecord | null {
  if (state.question === '' && state.answer === '' && state.activity.length === 0 && state.error == null) return null
  return {
    id: `${state.startedAt ?? Date.now()}-${state.question.slice(0, 24)}`,
    question: state.question,
    answer: state.answer,
    blocks: state.parsed.blocks,
    activity: state.activity,
    error: state.error,
    usage: state.usage,
    provider: state.provider,
    model: state.model,
    effort: state.effort,
    accessMode: state.accessMode,
    startedAt: state.startedAt,
    completedAt: state.completedAt
  }
}

function trimmedActivity(item: AgentActivityUpdate): AgentActivityUpdate {
  const detailTooLong = (item.detail?.length ?? 0) > ARCHIVED_ACTIVITY_DETAIL_LENGTH
  const outputTooLong = (item.output?.length ?? 0) > ARCHIVED_ACTIVITY_OUTPUT_LENGTH
  if (!detailTooLong && !outputTooLong) return item
  return {
    ...item,
    // The ellipsis counts toward the cap, so a trimmed item is never trimmed again.
    ...(detailTooLong && { detail: `${item.detail!.slice(0, ARCHIVED_ACTIVITY_DETAIL_LENGTH - 1)}…` }),
    ...(outputTooLong && { output: `…${item.output!.slice(1 - ARCHIVED_ACTIVITY_OUTPUT_LENGTH)}` })
  }
}

// Returns the same record when nothing needed trimming, so a turn that is
// already compact keeps its identity and its memoized row does not re-render.
function compactTurn(turn: AgentTurnRecord): AgentTurnRecord {
  let changed = false
  const activity = turn.activity.map((item) => {
    const trimmed = trimmedActivity(item)
    if (trimmed !== item) changed = true
    return trimmed
  })
  return changed ? { ...turn, activity } : turn
}

/**
 * Adds a finished turn to the history: at most twenty turns, the newest few
 * intact and the rest with their tool detail and output cut to a preview.
 */
export function appendTurnToHistory(
  history: readonly AgentTurnRecord[],
  turn: AgentTurnRecord
): readonly AgentTurnRecord[] {
  const next = [...history, turn].slice(-MAX_HISTORY_TURNS)
  const firstFull = next.length - FULL_HISTORY_TURNS
  for (let index = 0; index < firstFull; index += 1) next[index] = compactTurn(next[index]!)
  return next
}

// Folded outside the component so a whole frame's worth of events costs one
// state update, and so the folding itself is unit-testable.
export function reduceAgentEvent(current: AgentAnswerState, event: AgentStreamEvent): AgentAnswerState {
  if (event.kind === 'session') {
    return { ...current, sessionId: event.sessionId ?? current.sessionId }
  }
  if (event.kind === 'text') {
    // A long answer is truncated from the front so the panel cannot grow
    // without bound during a very long stream; the cut lands on a settled block
    // boundary so the parse stays incremental afterwards.
    const parsed = appendStreamingMarkdown(current.parsed, event.text ?? '', MAX_ANSWER_LENGTH)
    return { ...current, answer: parsed.source, parsed }
  }
  if (event.kind === 'activity') {
    if (event.activity == null) return current
    return { ...current, activity: mergeActivity(current.activity, event.activity) }
  }
  if (event.kind === 'usage') {
    if (event.usage == null) return current
    return { ...current, usage: mergeUsage(current.usage, event.usage) }
  }
  if (event.kind === 'approval') {
    if (event.approval == null) return current
    return {
      ...current,
      approvals: [...current.approvals.filter((approval) =>
        approval.requestId !== event.approval?.requestId), event.approval]
    }
  }
  if (event.kind === 'error') {
    return {
      ...current,
      streaming: false,
      approvals: [],
      error: event.text ?? 'The agent failed to answer.',
      completedAt: Date.now()
    }
  }
  return { ...current, streaming: false, approvals: [], completedAt: Date.now() }
}

export function reduceAgentEvents(
  current: AgentAnswerState,
  events: readonly AgentStreamEvent[]
): AgentAnswerState {
  // Strictly in arrival order: text and activity interleave, and folding them
  // out of order would reorder the transcript.
  let next = current
  for (const event of events) next = reduceAgentEvent(next, event)
  return next
}

export function useAgentAnswer(): AgentAnswerApi {
  const [state, setState] = useState<AgentAnswerState>(EMPTY_ANSWER)
  const requestIdRef = useRef<string | null>(null)
  const queueRef = useRef<AgentStreamEvent[]>([])
  const frameRef = useRef(0)

  useEffect(() => {
    const repository = window.repository
    if (repository == null) return
    // At 30-80 stream events a second, one setState per event is 30-80 renders
    // of the whole transcript per second. Batching to a frame keeps the commit
    // rate at the frame rate no matter how fast the model streams.
    const flush = (): void => {
      frameRef.current = 0
      const events = queueRef.current
      if (events.length === 0) return
      queueRef.current = []
      setState((current) => reduceAgentEvents(current, events))
    }
    const unsubscribe = repository.onAgentEvent((event) => {
      if (event.id !== requestIdRef.current) return
      markAgentStreamEvent()
      queueRef.current.push(event)
      // A terminal state or a permission prompt is what the user is waiting on,
      // so those land in the same tick instead of on the next frame.
      if (event.kind === 'done' || event.kind === 'error' || event.kind === 'approval') {
        if (frameRef.current !== 0) window.cancelAnimationFrame(frameRef.current)
        flush()
      } else if (frameRef.current === 0) {
        frameRef.current = window.requestAnimationFrame(flush)
      }
      if (event.kind === 'done' || event.kind === 'error') requestIdRef.current = null
    })
    return () => {
      unsubscribe()
      if (frameRef.current !== 0) window.cancelAnimationFrame(frameRef.current)
      // Nothing is left to render the answer, and the CLI would otherwise run to
      // its own timeout spending plan tokens on a transcript nobody will read.
      const runningId = requestIdRef.current
      requestIdRef.current = null
      if (runningId != null) void window.repository?.cancelAgent(runningId)
    }
  }, [])

  const ask = useCallback((options: {
    provider: AgentProvider
    model: string
    effort: string
    accessMode: AgentAccessMode
    prompt: string
    context: string
    question?: string
    subject: AgentRequestSubject
    selections: AgentRequestSelection[]
    sessionScope: string
  }) => {
    const repository = window.repository
    if (repository == null) return
    const id = crypto.randomUUID()
    const sessionKey = `${options.provider}:${options.model}:${options.accessMode}:${options.sessionScope}`
    const resumeSessionId = state.sessionKey === sessionKey ? state.sessionId : null
    requestIdRef.current = id
    setState((current) => {
      const archived = archiveTurn(current)
      return {
        ...EMPTY_ANSWER,
        history: archived == null ? current.history : appendTurnToHistory(current.history, archived),
        streaming: true,
        sessionId: resumeSessionId,
        sessionKey,
        question: options.question ?? options.prompt,
        provider: options.provider,
        model: options.model,
        effort: options.effort,
        accessMode: options.accessMode,
        startedAt: Date.now()
      }
    })
    void repository
      .askAgent({
        id,
        provider: options.provider,
        model: options.model,
        effort: options.effort,
        accessMode: options.accessMode,
        prompt: options.prompt,
        context: options.context,
        subject: options.subject,
        selections: options.selections,
        ...(resumeSessionId == null ? {} : { resumeSessionId })
      })
      .catch((error: unknown) => {
        if (requestIdRef.current !== id) return
        requestIdRef.current = null
        setState((current) => ({
          ...current,
          streaming: false,
          error: getErrorMessage(error),
          completedAt: Date.now()
        }))
      })
  }, [state.sessionId, state.sessionKey])

  const respondToApproval = useCallback((requestId: string, decision: AgentApprovalDecision) => {
    const approval = state.approvals.find((candidate) => candidate.requestId === requestId)
    if (approval == null) return
    setState((current) => ({
      ...current,
      approvals: current.approvals.filter((candidate) => candidate.requestId !== requestId),
      activity: current.activity.map((item) => item.id === approval.itemId
        ? { ...item, status: decision === 'decline' ? 'blocked' : 'running' }
        : item)
    }))
    void window.repository?.respondAgentApproval(requestId, decision).catch((error: unknown) => {
      setState((current) => ({ ...current, error: getErrorMessage(error) }))
    })
  }, [state.approvals])

  const cancel = useCallback(() => {
    const id = requestIdRef.current
    if (id == null) return
    requestIdRef.current = null
    void window.repository?.cancelAgent(id)
    setState((current) => ({
      ...current,
      streaming: false,
      approvals: [],
      completedAt: Date.now(),
      activity: current.activity.map((item) => item.status === 'running' || item.status === 'waiting'
        ? { ...item, status: 'blocked', completedAt: Date.now() }
        : item)
    }))
  }, [])

  const reset = useCallback(() => {
    requestIdRef.current = null
    setState(EMPTY_ANSWER)
  }, [])

  return { ...state, blocks: state.parsed.blocks, ask, respondToApproval, cancel, reset }
}

function appendBounded(current: string | undefined, addition: string | undefined, limit: number): string {
  const next = `${current ?? ''}${addition ?? ''}`
  return next.length > limit ? next.slice(-limit) : next
}

export function mergeActivity(
  current: readonly AgentActivityUpdate[],
  update: AgentActivityUpdate
): AgentActivityUpdate[] {
  const existingIndex = current.findIndex((item) => item.id === update.id)
  const now = Date.now()
  if (existingIndex === -1) {
    const added: AgentActivityUpdate = {
      ...update,
      startedAt: update.startedAt ?? now,
      ...(update.status === 'running' || update.status === 'waiting'
        ? {}
        : { completedAt: update.completedAt ?? now, durationMs: update.durationMs ?? 0 })
    }
    // A delta can open its item (Claude's thinking does). Bounding it and
    // dropping `append` as the merge below does means the main process can join
    // deltas into one event without the folded item coming out any different.
    // A whole value is bounded the same way, or one large tool result would
    // step past the per-item cap the history estimate is built on.
    if (update.detail != null) {
      added.detail = appendBounded(undefined, update.detail, MAX_ACTIVITY_DETAIL_LENGTH)
    }
    if (update.output != null) {
      added.output = appendBounded(undefined, update.output, MAX_ACTIVITY_OUTPUT_LENGTH)
    }
    delete added.append
    return [...current, added].slice(-MAX_ACTIVITY_ITEMS)
  }
  const existing = current[existingIndex]!
  const merged: AgentActivityUpdate = {
    ...existing,
    ...update,
    title: update.title || existing.title,
    kind: update.title === '' ? existing.kind : update.kind,
    detail: update.append === 'detail'
      ? appendBounded(existing.detail, update.detail, MAX_ACTIVITY_DETAIL_LENGTH)
      : update.detail == null ? existing.detail : appendBounded(undefined, update.detail, MAX_ACTIVITY_DETAIL_LENGTH),
    output: update.append === 'output'
      ? appendBounded(existing.output, update.output, MAX_ACTIVITY_OUTPUT_LENGTH)
      : update.output == null ? existing.output : appendBounded(undefined, update.output, MAX_ACTIVITY_OUTPUT_LENGTH),
    startedAt: existing.startedAt ?? update.startedAt ?? now
  }
  if (update.status !== 'running' && update.status !== 'waiting') {
    merged.completedAt = update.completedAt ?? existing.completedAt ?? now
    merged.durationMs = update.durationMs ?? existing.durationMs ??
      Math.max(0, merged.completedAt - (merged.startedAt ?? merged.completedAt))
  }
  delete merged.append
  const next = [...current]
  next[existingIndex] = merged
  return next
}

export function mergeUsage(
  current: AgentUsageUpdate | null,
  update: AgentUsageUpdate
): AgentUsageUpdate {
  const rateLimits = update.rateLimits == null
    ? current?.rateLimits
    : [
        ...(current?.rateLimits ?? []).filter((window) =>
          !update.rateLimits?.some((candidate) => candidate.label === window.label)),
        ...update.rateLimits
      ]
  return {
    ...current,
    ...update,
    ...(rateLimits != null && { rateLimits })
  }
}
