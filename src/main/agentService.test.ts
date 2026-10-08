import { describe, expect, test } from 'bun:test'

import type { AgentActivityUpdate, AgentStreamEvent } from '../shared/contracts.js'
import { interpretAgentEnvelope } from './agentRequest.js'
import { coalesceAgentTextEvents, composeAgentPrompt, getClaudeAccessConfig } from './agentService.js'
import { interpretCodexNotification } from './codexProtocol.js'

interface FoldedAnswer {
  answer: string
  activity: readonly AgentActivityUpdate[]
}

// The renderer's reducer is the contract a merged stream has to honour, but it
// belongs to the web project, so it is loaded by a path the node project's
// typecheck does not follow.
async function loadRendererReducer(): Promise<{
  EMPTY_ANSWER: FoldedAnswer
  reduceAgentEvents(state: FoldedAnswer, events: readonly AgentStreamEvent[]): FoldedAnswer
}> {
  const path = '../renderer/src/agent/useAgentAnswer.ts'
  return await import(path)
}

function reasoningDelta(itemId: string, delta: string): AgentStreamEvent {
  const chunk = interpretCodexNotification({ method: 'item/reasoning/summaryTextDelta', params: { itemId, delta } })
  if (chunk?.activity == null) throw new Error('expected a reasoning delta')
  return { id: 'r', kind: 'activity', activity: chunk.activity }
}

function commandOutputDelta(itemId: string, delta: string): AgentStreamEvent {
  const chunk = interpretCodexNotification({ method: 'item/commandExecution/outputDelta', params: { itemId, delta } })
  if (chunk?.activity == null) throw new Error('expected a command output delta')
  return { id: 'r', kind: 'activity', activity: chunk.activity }
}

function claudeThinkingDelta(index: number, thinking: string): AgentStreamEvent {
  const chunk = interpretAgentEnvelope({
    type: 'stream_event',
    event: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } }
  })
  if (chunk?.activity == null) throw new Error('expected a thinking delta')
  return { id: 'r', kind: 'activity', activity: chunk.activity }
}

function itemEvent(method: 'item/started' | 'item/completed', item: Record<string, unknown>): AgentStreamEvent {
  const chunk = interpretCodexNotification({ method, params: { item } })
  if (chunk?.activity == null) throw new Error('expected an item activity')
  return { id: 'r', kind: 'activity', activity: chunk.activity }
}

// startedAt/completedAt/durationMs come from the renderer's own Date.now() at
// fold time, so they are not part of what the stream decides.
function withoutClock(items: readonly AgentActivityUpdate[]): unknown[] {
  return items.map(({ startedAt: _s, completedAt: _c, durationMs: _d, ...rest }) => rest)
}

describe('getClaudeAccessConfig', () => {
  test('allows Bash in a write-blocked review sandbox', () => {
    const config = getClaudeAccessConfig('review', '/work/repository')

    expect(config.permissionMode).toBe('dontAsk')
    expect(config.tools).toContain('Read')
    expect(config.tools).toContain('Bash')
    expect(config.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: ['/work/repository'] }
    })
  })

  test('lets auto mode use the Claude Code tools with provider checks', () => {
    const config = getClaudeAccessConfig('auto')

    expect(config.permissionMode).toBe('auto')
    expect(config.tools).toEqual({ type: 'preset', preset: 'claude_code' })
    expect(config.allowDangerouslySkipPermissions).toBeUndefined()
  })

  test('makes full access explicit', () => {
    const config = getClaudeAccessConfig('full-access')

    expect(config.permissionMode).toBe('bypassPermissions')
    expect(config.allowDangerouslySkipPermissions).toBe(true)
  })
})

describe('composeAgentPrompt', () => {
  test('tells the agent to use the loaded review instead of GitHub', () => {
    const prompt = composeAgentPrompt('Explain this change', 'Repository root: /repo-a')
    expect(prompt).toContain('Do not fetch remotes')
    expect(prompt).toContain('mermaid')
    expect(prompt).toContain('Repository root: /repo-a')
    expect(prompt).not.toContain('Use repository search and Git commands')
  })
})

describe('coalesceAgentTextEvents', () => {
  test('sends one message per frame instead of one per token delta', async () => {
    const sent: AgentStreamEvent[] = []
    const stream = coalesceAgentTextEvents((event) => sent.push(event))

    for (const text of ['He', 'llo', ' world']) stream.emit({ id: 'r', kind: 'text', text })
    expect(sent).toHaveLength(0)

    await Bun.sleep(40)
    expect(sent).toEqual([{ id: 'r', kind: 'text', text: 'Hello world' }])
  })

  test('flushes pending text before any other event so order survives', () => {
    const sent: AgentStreamEvent[] = []
    const stream = coalesceAgentTextEvents((event) => sent.push(event))

    stream.emit({ id: 'r', kind: 'text', text: 'before' })
    stream.emit({ id: 'r', kind: 'activity', activity: { id: 'a', kind: 'file', title: 'Read file', status: 'running' } })
    stream.emit({ id: 'r', kind: 'text', text: 'after' })
    stream.emit({ id: 'r', kind: 'done' })

    expect(sent.map((event) => event.kind)).toEqual(['text', 'activity', 'text', 'done'])
    expect(sent[0]).toEqual({ id: 'r', kind: 'text', text: 'before' })
    expect(sent[2]).toEqual({ id: 'r', kind: 'text', text: 'after' })
  })

  test('never merges text across requests, and flush drains what is buffered', () => {
    const sent: AgentStreamEvent[] = []
    const stream = coalesceAgentTextEvents((event) => sent.push(event))

    stream.emit({ id: 'first', kind: 'text', text: 'one' })
    stream.emit({ id: 'second', kind: 'text', text: 'two' })
    stream.flush()

    expect(sent).toEqual([
      { id: 'first', kind: 'text', text: 'one' },
      { id: 'second', kind: 'text', text: 'two' }
    ])
  })

  test('joins interleaved text and reasoning deltas into one message each', async () => {
    const sent: AgentStreamEvent[] = []
    const stream = coalesceAgentTextEvents((event) => sent.push(event))

    for (let index = 0; index < 500; index += 1) {
      stream.emit({ id: 'r', kind: 'text', text: `t${index} ` })
      stream.emit(reasoningDelta('reasoning-1', `r${index} `))
    }
    expect(sent).toHaveLength(0)

    await Bun.sleep(40)
    expect(sent).toHaveLength(2)
    expect(sent[0]).toEqual({
      id: 'r',
      kind: 'text',
      text: Array.from({ length: 500 }, (_, index) => `t${index} `).join('')
    })
    expect(sent[1]?.activity).toEqual({
      id: 'reasoning-1',
      kind: 'reasoning',
      title: 'Reasoning',
      status: 'running',
      detail: Array.from({ length: 500 }, (_, index) => `r${index} `).join(''),
      append: 'detail'
    })
  })

  test('merged deltas fold to the same answer and activity as the raw stream', async () => {
    const { EMPTY_ANSWER, reduceAgentEvents } = await loadRendererReducer()
    const raw: AgentStreamEvent[] = [
      itemEvent('item/started', { id: 'reasoning-1', type: 'reasoning' }),
      ...Array.from({ length: 300 }, (_, index) => index % 2 === 0
        ? { id: 'r', kind: 'text' as const, text: `word${index} ` }
        : reasoningDelta('reasoning-1', `thought${index} `)),
      itemEvent('item/completed', { id: 'reasoning-1', type: 'reasoning', summary: ['Final summary'] }),
      itemEvent('item/started', { id: 'command-1', type: 'commandExecution', command: 'bun test' }),
      // Two items streaming at once, a delta that opens its own item, and output
      // long enough to hit the renderer's cap all have to fold identically.
      ...Array.from({ length: 400 }, (_, index) => index % 5 === 0
        ? claudeThinkingDelta(1, `aside${index} `)
        : commandOutputDelta('command-1', `line ${index} ${'x'.repeat(40)}\n`)),
      ...Array.from({ length: 200 }, (_, index) => claudeThinkingDelta(2, 'y'.repeat(150) + String(index))),
      { id: 'r', kind: 'text', text: 'tail' },
      itemEvent('item/completed', { id: 'command-1', type: 'commandExecution', command: 'bun test', status: 'completed' })
    ]
    const sent: AgentStreamEvent[] = []
    const stream = coalesceAgentTextEvents((event) => sent.push(event))
    for (const event of raw) stream.emit(event)
    stream.flush()

    const merged = reduceAgentEvents(EMPTY_ANSWER, sent)
    const unmerged = raw.reduce((state, event) => reduceAgentEvents(state, [event]), EMPTY_ANSWER)

    expect(sent.length).toBeLessThan(raw.length / 4)
    expect(merged.answer).toBe(unmerged.answer)
    expect(withoutClock(merged.activity)).toEqual(withoutClock(unmerged.activity))
    expect(merged.activity.map((item) => item.id))
      .toEqual(['reasoning-1', 'command-1', 'claude-reasoning-1', 'claude-reasoning-2'])
    expect(merged.activity.find((item) => item.id === 'claude-reasoning-2')?.detail).toHaveLength(20_000)
  })

  test('sends approval and done at once, after every delta batched before them', async () => {
    const sent: AgentStreamEvent[] = []
    const stream = coalesceAgentTextEvents((event) => sent.push(event))

    stream.emit({ id: 'r', kind: 'text', text: 'Checking ' })
    stream.emit(reasoningDelta('reasoning-1', 'Look at '))
    stream.emit(reasoningDelta('reasoning-1', 'the tests'))
    stream.emit(commandOutputDelta('command-1', 'ok\n'))
    stream.emit({ id: 'r', kind: 'text', text: 'the tests.' })
    stream.emit({
      id: 'r',
      kind: 'approval',
      approval: { requestId: 'q', itemId: 'command-1', type: 'command', title: 'Run', detail: 'bun test' }
    })

    expect(sent.map((event) => event.kind)).toEqual(['text', 'activity', 'activity', 'approval'])
    expect(sent[0]?.text).toBe('Checking the tests.')
    expect(sent[1]?.activity?.detail).toBe('Look at the tests')
    expect(sent[2]?.activity?.output).toBe('ok\n')

    stream.emit(commandOutputDelta('command-1', 'done\n'))
    stream.emit({ id: 'r', kind: 'done' })
    expect(sent.slice(4).map((event) => event.kind)).toEqual(['activity', 'done'])

    await Bun.sleep(40)
    expect(sent).toHaveLength(6)
  })

  test('sends a lifecycle update after the deltas of the item it replaces', () => {
    const sent: AgentStreamEvent[] = []
    const stream = coalesceAgentTextEvents((event) => sent.push(event))

    stream.emit(reasoningDelta('reasoning-1', 'partial'))
    stream.emit(itemEvent('item/completed', { id: 'reasoning-1', type: 'reasoning', summary: ['Whole'] }))

    expect(sent.map((event) => event.activity?.status)).toEqual(['running', 'completed'])
    expect(sent[1]?.activity?.detail).toBe('Whole')
  })

  test('never writes a merged delta into the event it was given', () => {
    const stream = coalesceAgentTextEvents(() => {})
    const first = reasoningDelta('reasoning-1', 'one')

    stream.emit(first)
    stream.emit(reasoningDelta('reasoning-1', ' two'))
    stream.flush()

    expect(first.activity?.detail).toBe('one')
  })
})

describe('runStructured', () => {
  const connected = (provider: 'claude' | 'codex'): Promise<import('../shared/contracts.js').AgentProviderStatus> =>
    Promise.resolve({ provider, installed: true, authenticated: true, label: 'Connected', detail: '' })

  // A stand-in for the SDK's query(): an async iterable with close().
  function fakeClaude(
    script: (model: string | undefined) => Record<string, unknown>[],
    calls: Array<Record<string, unknown>> = []
  ): () => Promise<never> {
    return () => Promise.resolve(((args: { prompt: string; options: Record<string, unknown> }) => {
      calls.push(args.options)
      const messages = script(args.options.model as string | undefined)
      let closed = false
      return {
        close() { closed = true },
        async *[Symbol.asyncIterator]() {
          for (const message of messages) {
            if (closed) return
            if (message.type === 'wait') {
              await new Promise((resolve) => setTimeout(resolve, message.ms as number))
              continue
            }
            yield message
          }
        }
      }
    }) as never)
  }

  const streamEvent = (event: Record<string, unknown>): Record<string, unknown> => ({ type: 'stream_event', event })
  const request = (overrides: Partial<import('./agentService.js').StructuredRunRequest> = {}): import('./agentService.js').StructuredRunRequest => ({
    id: 'run-1',
    provider: 'claude',
    model: 'default',
    effort: '',
    prompt: 'Return JSON.',
    schema: { type: 'object' },
    cwd: '/work/repository',
    timeoutMs: 30_000,
    ...overrides
  })

  test('returns the structured output and reports thinking, then writing', async () => {
    const { AgentService } = await import('./agentService.js')
    const calls: Array<Record<string, unknown>> = []
    const service = new AgentService({
      providerStatus: connected,
      resolveExecutable: () => Promise.resolve('/bin/claude'),
      loadClaudeQuery: fakeClaude(() => [
        streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
        streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }),
        streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
        { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { a: 1 } }
      ], calls)
    })
    const phases: string[] = []

    const result = await service.runStructured(request({ onPhase: (phase) => { if (phases.at(-1) !== phase) phases.push(phase) } }))

    expect(result.json).toEqual({ a: 1 })
    expect(result.model).toBe('default')
    expect(phases).toEqual(['thinking', 'writing'])
    expect(calls[0]).toMatchObject({
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      tools: [],
      persistSession: false,
      settingSources: []
    })
    expect(calls[0]?.model).toBeUndefined()
    expect(service.busyCount).toBe(0)
  })

  test('falls back once to the default model when the named one is unavailable', async () => {
    const { AgentService } = await import('./agentService.js')
    const calls: Array<Record<string, unknown>> = []
    const service = new AgentService({
      providerStatus: connected,
      resolveExecutable: () => Promise.resolve('/bin/claude'),
      loadClaudeQuery: fakeClaude((model) => model === 'opus'
        ? [{ type: 'result', subtype: 'success', is_error: true, result: 'model_not_found: opus' }]
        : [{ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { ok: true } }], calls)
    })

    const result = await service.runStructured(request({ model: 'opus' }))

    expect(result).toMatchObject({ json: { ok: true }, model: 'default' })
    expect(calls.map((call) => call.model ?? 'default')).toEqual(['opus', 'default'])
  })

  test('a second availability error is not retried again', async () => {
    const { AgentService } = await import('./agentService.js')
    const calls: Array<Record<string, unknown>> = []
    const service = new AgentService({
      providerStatus: connected,
      resolveExecutable: () => Promise.resolve('/bin/claude'),
      loadClaudeQuery: fakeClaude(() => [{ type: 'result', subtype: 'success', is_error: true, result: 'model_not_found' }], calls)
    })

    await expect(service.runStructured(request({ model: 'opus' }))).rejects.toThrow('model_not_found')
    expect(calls).toHaveLength(2)
  })

  test('a result with neither structured output nor JSON text is rejected', async () => {
    const { AgentService } = await import('./agentService.js')
    const service = new AgentService({
      providerStatus: connected,
      resolveExecutable: () => Promise.resolve('/bin/claude'),
      loadClaudeQuery: fakeClaude(() => [{ type: 'result', subtype: 'success', is_error: false, result: 'Sure! Here you go.' }])
    })

    await expect(service.runStructured(request())).rejects.toThrow('The model did not return JSON.')
  })

  test('refuses to run when the provider is signed out', async () => {
    const { AgentService } = await import('./agentService.js')
    const service = new AgentService({
      providerStatus: (provider) => Promise.resolve({ provider, installed: true, authenticated: false, label: 'Sign-in required', detail: '' }),
      resolveExecutable: () => Promise.resolve('/bin/claude'),
      loadClaudeQuery: fakeClaude(() => [])
    })

    await expect(service.runStructured(request())).rejects.toThrow('Claude Code is not connected.')
  })

  test('cancel stops a running Claude run and forgets it', async () => {
    const { AgentService, StructuredRunCancelled } = await import('./agentService.js')
    const service = new AgentService({
      providerStatus: connected,
      resolveExecutable: () => Promise.resolve('/bin/claude'),
      loadClaudeQuery: fakeClaude(() => [
        streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
        { type: 'wait', ms: 200 },
        { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: { late: true } }
      ])
    })
    const running = service.runStructured(request({ id: 'cancel-me' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(service.busyCount).toBe(1)

    service.cancel('cancel-me')

    await expect(running).rejects.toBeInstanceOf(StructuredRunCancelled)
    expect(service.busyCount).toBe(0)
  })

  test('a cancel while the CLI is still being found is not lost', async () => {
    const { AgentService, StructuredRunCancelled } = await import('./agentService.js')
    let started = 0
    let release!: (path: string) => void
    const service = new AgentService({
      providerStatus: connected,
      resolveExecutable: () => new Promise((resolve) => { release = resolve }),
      loadClaudeQuery: () => { started += 1; return fakeClaude(() => [])() }
    })
    const running = service.runStructured(request({ id: 'early' }))
    expect(service.busyCount).toBe(1)
    service.cancel('early')
    release('/bin/claude')

    await expect(running).rejects.toBeInstanceOf(StructuredRunCancelled)
    expect(started).toBe(0)
    expect(service.busyCount).toBe(0)
  })

  test('Codex runs on its own server and parses the final message', async () => {
    const { AgentService } = await import('./agentService.js')
    const received: Array<Record<string, unknown>> = []
    let stopped = 0
    const service = new AgentService({
      providerStatus: connected,
      resolveExecutable: () => Promise.resolve('/bin/codex'),
      createCodexServer: () => ({
        runStructured: (options) => {
          received.push(options as unknown as Record<string, unknown>)
          options.onPhase?.('writing')
          return Promise.resolve('```json\n{"a":1}\n```')
        },
        interrupt() {},
        stop() { stopped += 1 }
      })
    })

    const result = await service.runStructured(request({ provider: 'codex', model: 'gpt-x', effort: 'low' }))

    expect(result).toMatchObject({ json: { a: 1 }, model: 'gpt-x' })
    expect(received[0]).toMatchObject({ model: 'gpt-x', effort: 'low', schema: { type: 'object' } })
    expect(stopped).toBeGreaterThan(0)
  })
})

describe('parseJsonLoose and extractStructuredJson', () => {
  test('reads bare, fenced and embedded objects', async () => {
    const { parseJsonLoose } = await import('./agentService.js')
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonLoose('Here:\n```json\n{"a":2}\n```')).toEqual({ a: 2 })
    expect(parseJsonLoose('Sure {"a":{"b":"}"}} trailing')).toEqual({ a: { b: '}' } })
    expect(parseJsonLoose('no json here')).toBeUndefined()
  })

  test('an error result throws its text', async () => {
    const { extractStructuredJson } = await import('./agentService.js')
    expect(() => extractStructuredJson({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'] }))
      .toThrow('too many turns')
    expect(extractStructuredJson({ type: 'result', subtype: 'success', is_error: false, result: '{"x":1}' })).toEqual({ x: 1 })
  })
})
