import { describe, expect, it } from 'bun:test'

import type { AgentStreamEvent } from '../../../shared/contracts'
import {
  appendTurnToHistory,
  EMPTY_ANSWER,
  mergeActivity,
  reduceAgentEvents,
  type AgentAnswerState,
  type AgentTurnRecord
} from './useAgentAnswer'

describe('mergeActivity', () => {
  it('keeps one item while its lifecycle and output stream update', () => {
    const started = mergeActivity([], {
      id: 'command-1',
      kind: 'command',
      title: 'Run command',
      detail: 'bun test',
      status: 'running'
    })
    const withOutput = mergeActivity(started, {
      id: 'command-1',
      kind: 'command',
      title: 'Run command',
      output: '12 tests passed',
      status: 'running',
      append: 'output'
    })
    const completed = mergeActivity(withOutput, {
      id: 'command-1',
      kind: 'command',
      title: 'Run command',
      status: 'completed'
    })

    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({
      id: 'command-1',
      kind: 'command',
      title: 'Run command',
      detail: 'bun test',
      output: '12 tests passed',
      status: 'completed'
    })
    expect(completed[0]?.startedAt).toBeNumber()
    expect(completed[0]?.completedAt).toBeNumber()
  })

  it('appends streamed reasoning summaries', () => {
    const first = mergeActivity([], {
      id: 'reasoning-1',
      kind: 'reasoning',
      title: 'Reasoning',
      detail: 'Inspecting ',
      status: 'running',
      append: 'detail'
    })
    const second = mergeActivity(first, {
      id: 'reasoning-1',
      kind: 'reasoning',
      title: 'Reasoning',
      detail: 'callers',
      status: 'running',
      append: 'detail'
    })

    expect(second[0]?.detail).toBe('Inspecting callers')
  })

  it('opens an item from a delta exactly as if it had been appended', () => {
    const opened = mergeActivity([], {
      id: 'claude-reasoning-0',
      kind: 'reasoning',
      title: 'Reasoning',
      detail: 'x'.repeat(25_000),
      status: 'running',
      append: 'detail'
    })

    expect(opened[0]?.detail).toHaveLength(20_000)
    expect(opened[0]).not.toHaveProperty('append')
  })

  it('preserves a useful tool title when a result update has none', () => {
    const result = mergeActivity([{
      id: 'tool-1',
      kind: 'file',
      title: 'Read file',
      detail: 'src/App.tsx',
      status: 'running'
    }], {
      id: 'tool-1',
      kind: 'tool',
      title: '',
      output: 'ok',
      status: 'completed'
    })

    expect(result[0]).toMatchObject({
      kind: 'file', title: 'Read file', detail: 'src/App.tsx', status: 'completed'
    })
  })
})

describe('reduceAgentEvents', () => {
  it('folds a batch exactly like the events folded one at a time', () => {
    const events = [
      { id: 'r', kind: 'text' as const, text: 'Hello ' },
      { id: 'r', kind: 'activity' as const, activity: { id: 'a1', kind: 'file' as const, title: 'Read file', status: 'running' as const } },
      { id: 'r', kind: 'text' as const, text: 'world.' },
      { id: 'r', kind: 'activity' as const, activity: { id: 'a1', kind: 'file' as const, title: 'Read file', status: 'completed' as const } }
    ]
    const batched = reduceAgentEvents(EMPTY_ANSWER, events)
    const oneByOne = events.reduce((state, event) => reduceAgentEvents(state, [event]), EMPTY_ANSWER)

    // Wall-clock fields (startedAt/completedAt/durationMs) come from Date.now() and
    // legitimately differ between a single batched fold and four sequential ones.
    const withoutClock = (items: typeof batched.activity): unknown[] =>
      items.map(({ startedAt: _s, completedAt: _c, durationMs: _d, ...rest }) => rest)

    expect(batched.answer).toBe('Hello world.')
    expect(batched.answer).toBe(oneByOne.answer)
    expect(withoutClock(batched.activity)).toEqual(withoutClock(oneByOne.activity))
    expect(batched.activity).toHaveLength(1)
    expect(batched.activity[0]?.status).toBe('completed')
  })

  it('keeps the settled markdown identity across a batch so blocks can bail out', () => {
    const first = reduceAgentEvents(EMPTY_ANSWER, [{ id: 'r', kind: 'text', text: 'Settled.\n\ntail' }])
    const second = reduceAgentEvents(first, [{ id: 'r', kind: 'text', text: ' grows' }])

    expect(second.parsed.settled[0]).toBe(first.parsed.settled[0]!)
    expect(second.answer).toBe('Settled.\n\ntail grows')
  })

  it('ends the turn on the last event of the batch', () => {
    const streaming = { ...EMPTY_ANSWER, streaming: true }
    const failed = reduceAgentEvents(streaming, [
      { id: 'r', kind: 'text', text: 'partial' },
      { id: 'r', kind: 'error', text: 'Claude stopped responding.' }
    ])

    expect(failed.streaming).toBe(false)
    expect(failed.error).toBe('Claude stopped responding.')
    expect(failed.answer).toBe('partial')
  })
})

// Characters reachable from `value`, counted once per place they appear. The
// fixture reuses one turn's arrays, and real turns share nothing, so a shared
// reference counts as the copy a distinct turn would hold.
function retainedCharacters(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (value == null || typeof value !== 'object') return 0
  let total = 0
  for (const child of Array.isArray(value) ? value : Object.values(value)) total += retainedCharacters(child)
  return total
}

// A turn that hits every live cap: a 200k-character answer and 80 tool calls,
// each with more detail and output than the per-item caps keep.
function worstCaseTurn(turn: number): AgentTurnRecord {
  const paragraph = 'The panel re-renders `useThing` **twice** when it opens, which is *expensive*.\n\n'
  const events: AgentStreamEvent[] = []
  const answer = paragraph.repeat(Math.ceil(260_000 / paragraph.length))
  for (let offset = 0; offset < answer.length; offset += 4_000) {
    events.push({ id: 'turn', kind: 'text', text: answer.slice(offset, offset + 4_000) })
  }
  for (let item = 0; item < 80; item += 1) {
    events.push({ id: 'turn', kind: 'activity', activity: {
      id: `tool-${item}`, kind: 'command', title: 'Run command', status: 'running', detail: 'd'.repeat(25_000)
    } })
    events.push({ id: 'turn', kind: 'activity', activity: {
      id: `tool-${item}`, kind: 'command', title: 'Run command', status: 'completed',
      output: 'o'.repeat(15_000), append: 'output'
    } })
  }
  events.push({ id: 'turn', kind: 'done' })
  const state: AgentAnswerState = reduceAgentEvents(
    { ...EMPTY_ANSWER, streaming: true, question: `question ${turn}`, startedAt: turn },
    events
  )
  return {
    id: `turn-${turn}`,
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

describe('agent history retention', () => {
  const turn = worstCaseTurn(0)
  let history: readonly AgentTurnRecord[] = []
  for (let index = 0; index < 25; index += 1) history = appendTurnToHistory(history, { ...turn, id: `turn-${index}` })

  it('bounds every activity item, whether streamed or sent whole', () => {
    expect(turn.activity).toHaveLength(80)
    for (const item of turn.activity) {
      expect(item.detail?.length).toBe(20_000)
      expect(item.output?.length).toBe(12_000)
    }
  })

  it('keeps twenty turns and the newest three intact', () => {
    expect(history).toHaveLength(20)
    expect(history.map((record) => record.id).at(-1)).toBe('turn-24')
    for (const record of history.slice(-3)) expect(record.activity).toBe(turn.activity)
    for (const record of history.slice(0, -3)) {
      expect(record.answer).toBe(turn.answer)
      expect(record.activity).toHaveLength(80)
      expect(record.activity[0]?.detail?.length).toBeLessThanOrEqual(1_000)
      expect(record.activity[0]?.output?.length).toBeLessThanOrEqual(2_000)
    }
  })

  it('holds a worst-case history in a fraction of what the live caps allow', () => {
    const full = retainedCharacters(Array.from({ length: 20 }, (_, index) => ({ ...turn, id: `turn-${index}` })))
    const retained = retainedCharacters(history)

    // 20 uncompacted worst-case turns are ~61 M characters, 84% of it tool
    // detail and output. Compacted, ~21 M remain: the three intact turns and
    // every answer, which the reader can still scroll back and copy.
    expect(full).toBeGreaterThan(55_000_000)
    expect(retained).toBeLessThan(22_000_000)
  })

  it('leaves an already compact turn as the same record', () => {
    const again = appendTurnToHistory(history, { ...turn, id: 'turn-25' })
    expect(again[0]).toBe(history[1])
  })
})
