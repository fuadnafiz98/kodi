import { describe, expect, it } from 'bun:test'

import { EMPTY_ANSWER, mergeActivity, reduceAgentEvents } from './useAgentAnswer'

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
