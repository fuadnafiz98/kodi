import { useSyncExternalStore } from 'react'

import { appendStreamingMarkdown, EMPTY_STREAMING_MARKDOWN } from '../markdown/markdown'
import { browserBudgetStorage, forgetStorageKey, persistManagedValue, type BudgetStorage } from '../review/storageBudget'
import type { AgentStreamEvent } from '../../../shared/contracts'
import { chatFromState, compactTurn, reduceAgentEvent, type AgentAnswerState, type AgentTurnRecord } from './useAgentAnswer'

/**
 * Every conversation the agent panel has had, so starting a new one keeps the
 * last one a click away, and a restart keeps them all. Loaded with the panel
 * (this module is its own chunk), never on the startup path.
 */
export interface AgentChat {
  id: string
  title: string
  updatedAt: number
  turns: readonly AgentTurnRecord[]
  /** The CLI session the chat ran in, so a question asked after reopening it resumes that session. */
  sessionId: string | null
  sessionKey: string | null
}

export const AGENT_CHATS_KEY = 'kodi:agent-chats:v1'
const MAX_CHATS = 30
const MAX_STORED_LENGTH = 1_000_000
const PERSIST_DEBOUNCE_MS = 500

let chats: readonly AgentChat[] | null = null
// Chats left while they were being answered, by chat id: they keep folding
// their stream here until it ends or the chat is opened again.
const backgroundRuns = new Map<string, { state: AgentAnswerState; requestId: string }>()
let runningChatIds: ReadonlySet<string> = new Set()
let persistTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

type StoredTurn = Omit<AgentTurnRecord, 'blocks'>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function parseTurn(value: unknown): AgentTurnRecord | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.question !== 'string'
    || typeof value.answer !== 'string') return null
  const turn = value as unknown as StoredTurn
  return {
    ...turn,
    activity: Array.isArray(turn.activity) ? turn.activity : [],
    error: typeof turn.error === 'string' ? turn.error : null,
    usage: isRecord(turn.usage) ? turn.usage : null,
    // Parsed when the chat is opened, not for every stored answer on load.
    blocks: []
  }
}

function parseChat(value: unknown): AgentChat | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string'
    || typeof value.updatedAt !== 'number' || !Array.isArray(value.turns)) return null
  const turns = value.turns.map(parseTurn)
  if (turns.length === 0 || turns.some((turn) => turn == null)) return null
  return {
    id: value.id,
    title: value.title,
    updatedAt: value.updatedAt,
    turns: turns as AgentTurnRecord[],
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
    sessionKey: typeof value.sessionKey === 'string' ? value.sessionKey : null
  }
}

export function parseChats(serialized: string | null): AgentChat[] {
  if (serialized == null || serialized === '') return []
  try {
    const parsed = JSON.parse(serialized) as unknown
    if (!isRecord(parsed) || !Array.isArray(parsed.chats)) return []
    return parsed.chats.map(parseChat).filter((chat): chat is AgentChat => chat != null)
  } catch {
    return []
  }
}

/** Newest first, compacted, answers without their parsed blocks, cut to fit. */
export function serializeChats(list: readonly AgentChat[]): string {
  const stored = list.map((chat) => ({
    ...chat,
    turns: chat.turns.map((turn): StoredTurn => {
      const { blocks: _blocks, ...rest } = compactTurn(turn)
      return rest
    })
  }))
  let serialized = JSON.stringify({ chats: stored })
  while (serialized.length > MAX_STORED_LENGTH && stored.length > 1) {
    stored.pop()
    serialized = JSON.stringify({ chats: stored })
  }
  return serialized
}

/** Puts `chat` first in its place by recency, replacing an older copy of it. */
export function upsertChat(list: readonly AgentChat[], chat: AgentChat): readonly AgentChat[] {
  const existing = list.find((candidate) => candidate.id === chat.id)
  if (existing != null && existing.updatedAt === chat.updatedAt && existing.turns.length === chat.turns.length
    && existing.sessionId === chat.sessionId && existing.sessionKey === chat.sessionKey
    && existing.turns.at(-1)?.answer === chat.turns.at(-1)?.answer) return list
  return [chat, ...list.filter((candidate) => candidate.id !== chat.id)]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_CHATS)
}

function storage(): BudgetStorage | null {
  return browserBudgetStorage()
}

function currentChats(): readonly AgentChat[] {
  if (chats == null) {
    try {
      chats = parseChats(storage()?.getItem(AGENT_CHATS_KEY) ?? null)
    } catch {
      chats = []
    }
  }
  return chats
}

function writeNow(): void {
  const target = storage()
  if (target == null) return
  try {
    const list = currentChats()
    if (list.length === 0) {
      target.removeItem(AGENT_CHATS_KEY)
      forgetStorageKey(target, AGENT_CHATS_KEY)
    } else {
      persistManagedValue(target, AGENT_CHATS_KEY, serializeChats(list))
    }
  } catch {
    // Storage refused: the chats stay in this window until it closes.
  }
}

function persist(): void {
  if (persistTimer != null) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    writeNow()
  }, PERSIST_DEBOUNCE_MS)
}

function replace(next: readonly AgentChat[]): void {
  if (next === chats) return
  chats = next
  persist()
  for (const listener of listeners) listener()
}

export function saveChat(chat: AgentChat): void {
  replace(upsertChat(currentChats(), chat))
}

export function removeChat(id: string): void {
  const run = backgroundRuns.get(id)
  if (run != null) {
    backgroundRuns.delete(id)
    void window.repository?.cancelAgent(run.requestId)
    publishRunning()
  }
  const list = currentChats()
  if (!list.some((chat) => chat.id === id)) return
  replace(list.filter((chat) => chat.id !== id))
}

/** A stored chat with its answers parsed, ready to be shown again. */
export function findChat(id: string): AgentChat | null {
  const chat = currentChats().find((candidate) => candidate.id === id)
  if (chat == null) return null
  return {
    ...chat,
    turns: chat.turns.map((turn) => turn.blocks.length > 0 || turn.answer === ''
      ? turn
      : { ...turn, blocks: appendStreamingMarkdown(EMPTY_STREAMING_MARKDOWN, turn.answer, turn.answer.length).blocks })
  }
}

/** Drops the in-memory copy so the next read comes from storage. For tests. */
export function resetAgentChatsForTest(): void {
  if (persistTimer != null) clearTimeout(persistTimer)
  persistTimer = null
  chats = null
}

/** Writes any pending change now. For tests. */
export function flushAgentChatsForTest(): void {
  if (persistTimer == null) return
  clearTimeout(persistTimer)
  persistTimer = null
  writeNow()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useAgentChats(): readonly AgentChat[] {
  return useSyncExternalStore(subscribe, currentChats, currentChats)
}

function publishRunning(): void {
  runningChatIds = new Set(backgroundRuns.keys())
  for (const listener of listeners) listener()
}

function readRunning(): ReadonlySet<string> {
  return runningChatIds
}

/** Ids of the chats still being answered in the background. */
export function useRunningChats(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, readRunning, readRunning)
}

/** Takes over a chat that was left mid-answer; it is listed, as it stands, straight away. */
export function runInBackground(state: AgentAnswerState, requestId: string): void {
  if (state.chatId === '') return
  backgroundRuns.set(state.chatId, { state, requestId })
  publishRunning()
  const chat = chatFromState(state)
  if (chat != null) saveChat(chat)
}

/** Folds a stream event into the background chat it belongs to; saves it when it ends. */
export function backgroundEvent(event: AgentStreamEvent): void {
  for (const [chatId, run] of backgroundRuns) {
    if (run.requestId !== event.id) continue
    run.state = reduceAgentEvent(run.state, event)
    if (event.kind === 'done' || event.kind === 'error') {
      backgroundRuns.delete(chatId)
      publishRunning()
      const chat = chatFromState(run.state)
      if (chat != null) saveChat(chat)
    }
    return
  }
}

/** A background chat opened again: its live state and the request to keep following. */
export function takeBackgroundRun(chatId: string): { state: AgentAnswerState; requestId: string } | null {
  const run = backgroundRuns.get(chatId)
  if (run == null) return null
  backgroundRuns.delete(chatId)
  publishRunning()
  return run
}

/** The panel is going away: nothing is left to finish these runs for. */
export function cancelBackgroundRuns(): void {
  for (const run of backgroundRuns.values()) void window.repository?.cancelAgent(run.requestId)
  backgroundRuns.clear()
  publishRunning()
}
