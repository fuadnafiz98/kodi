import { afterEach, describe, expect, test } from 'bun:test'

import type { RepositoryApi } from '../../../shared/contracts'
import {
  AGENT_CHATS_KEY,
  backgroundEvent,
  findChat,
  flushAgentChatsForTest,
  parseChats,
  removeChat,
  resetAgentChatsForTest,
  runInBackground,
  saveChat,
  serializeChats,
  takeBackgroundRun,
  upsertChat,
  type AgentChat
} from './agentChats'
import { EMPTY_ANSWER, type AgentAnswerState, type AgentTurnRecord } from './useAgentAnswer'

afterEach(() => {
  resetAgentChatsForTest()
  localStorage.clear()
})

function turn(question: string, answer: string, at: number): AgentTurnRecord {
  return {
    id: `${at}-${question}`,
    question,
    answer,
    blocks: [],
    activity: [],
    error: null,
    usage: null,
    provider: 'claude',
    model: 'sonnet',
    effort: 'high',
    accessMode: 'review',
    startedAt: at,
    completedAt: at + 1
  }
}

function chat(id: string, updatedAt: number, turns = [turn(`ask ${id}`, `answer ${id}`, updatedAt - 1)]): AgentChat {
  return { id, title: `ask ${id}`, updatedAt, turns, sessionId: `session-${id}`, sessionKey: `key-${id}` }
}

describe('upsertChat', () => {
  test('keeps the newest first and replaces an older copy of the same chat', () => {
    let list = upsertChat([], chat('a', 10))
    list = upsertChat(list, chat('b', 20))
    list = upsertChat(list, chat('a', 30, [turn('ask a', 'answer a', 9), turn('more', 'yes', 29)]))
    expect(list.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(list[0]?.turns).toHaveLength(2)
  })

  test('returns the same list for a save that changes nothing', () => {
    const list = upsertChat([], chat('a', 10))
    expect(upsertChat(list, chat('a', 10))).toBe(list)
  })

  test('holds at most thirty chats, dropping the oldest', () => {
    let list: readonly AgentChat[] = []
    for (let index = 0; index < 35; index += 1) list = upsertChat(list, chat(`c${index}`, index + 1))
    expect(list).toHaveLength(30)
    expect(list.at(-1)?.id).toBe('c5')
  })
})

describe('stored chats', () => {
  test('round-trip without their parsed blocks, which come back when a chat is opened', () => {
    saveChat(chat('a', 10, [{ ...turn('Why?', 'Because **this**.', 9), blocks: [{ id: 'x' } as never] }]))
    flushAgentChatsForTest()
    const stored = localStorage.getItem(AGENT_CHATS_KEY)
    expect(stored).not.toBeNull()
    expect(stored).not.toContain('"blocks"')

    resetAgentChatsForTest()
    const opened = findChat('a')
    expect(opened?.sessionId).toBe('session-a')
    expect(opened?.turns[0]?.question).toBe('Why?')
    expect(opened?.turns[0]?.blocks.length).toBeGreaterThan(0)
  })

  test('a removed chat is gone from storage too', () => {
    saveChat(chat('a', 10))
    saveChat(chat('b', 20))
    removeChat('a')
    flushAgentChatsForTest()
    resetAgentChatsForTest()
    expect(findChat('a')).toBeNull()
    expect(findChat('b')).not.toBeNull()
  })

  test('corrupt or foreign storage reads as no chats', () => {
    expect(parseChats('{not json')).toEqual([])
    expect(parseChats(JSON.stringify({ chats: 'nope' }))).toEqual([])
    expect(parseChats(JSON.stringify({ chats: [{ id: 'a' }, chat('b', 2)] })).map((entry) => entry.id)).toEqual(['b'])
    localStorage.setItem(AGENT_CHATS_KEY, '{broken')
    expect(findChat('a')).toBeNull()
  })

  test('the oldest chats are cut until the list fits the storage share', () => {
    const big = 'x'.repeat(300_000)
    const list = [1, 2, 3, 4, 5].map((index) => chat(`c${index}`, 10 - index, [turn('q', big, index)]))
    const parsed = parseChats(serializeChats(list))
    expect(parsed.length).toBe(3)
    expect(parsed.map((entry) => entry.id)).toEqual(['c1', 'c2', 'c3'])
  })
})

describe('background runs', () => {
  const running = (): AgentAnswerState => ({
    ...EMPTY_ANSWER,
    chatId: 'bg',
    streaming: true,
    question: 'Is it safe?',
    references: [{ path: 'src/blob.py', startLine: 4, endLine: 4, side: 'additions' }],
    provider: 'claude',
    model: 'sonnet',
    startedAt: 10
  })

  afterEach(() => {
    delete window.repository
  })

  test('a chat left mid-answer is listed at once and finishes from its own events', () => {
    runInBackground(running(), 'request-1')
    expect(findChat('bg')?.turns[0]?.question).toBe('Is it safe?')

    backgroundEvent({ id: 'other', kind: 'text', text: 'not mine' })
    backgroundEvent({ id: 'request-1', kind: 'text', text: 'Yes, it is.' })
    backgroundEvent({ id: 'request-1', kind: 'done' })

    const saved = findChat('bg')
    expect(saved?.turns[0]?.answer).toBe('Yes, it is.')
    expect(saved?.turns[0]?.references).toEqual([{ path: 'src/blob.py', startLine: 4, endLine: 4, side: 'additions' }])
    expect(takeBackgroundRun('bg')).toBeNull()
  })

  test('opening it again hands back the live run to keep following', () => {
    runInBackground(running(), 'request-2')
    backgroundEvent({ id: 'request-2', kind: 'text', text: 'Half' })
    const run = takeBackgroundRun('bg')
    expect(run?.requestId).toBe('request-2')
    expect(run?.state.answer).toBe('Half')
    expect(run?.state.streaming).toBe(true)
    expect(takeBackgroundRun('bg')).toBeNull()
  })

  test('deleting a running chat stops its run', () => {
    const cancelled: string[] = []
    window.repository = { cancelAgent: async (id: string) => { cancelled.push(id) } } as unknown as RepositoryApi
    runInBackground(running(), 'request-3')
    removeChat('bg')
    expect(cancelled).toEqual(['request-3'])
    expect(findChat('bg')).toBeNull()
  })
})
