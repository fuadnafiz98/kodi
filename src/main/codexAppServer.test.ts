import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CODEX_TOOLLESS_CONFIG, CodexAppServer, codexServerArgs, getCodexThreadAccess, getCodexTurnSandbox } from './codexAppServer.js'

describe('codex access mapping', () => {
  test('review is read-only with no network and no approvals', () => {
    expect(getCodexThreadAccess('review')).toEqual({ sandbox: 'read-only', approvalPolicy: 'never' })
    expect(getCodexTurnSandbox('review', '/work/repository'))
      .toEqual({ type: 'readOnly', networkAccess: false })
  })

  test('auto writes only inside the repository and asks for anything more', () => {
    expect(getCodexThreadAccess('auto')).toEqual({ sandbox: 'workspace-write', approvalPolicy: 'on-request' })
    expect(getCodexTurnSandbox('auto', '/work/repository'))
      .toMatchObject({ type: 'workspaceWrite', writableRoots: ['/work/repository'] })
  })
})

describe('CodexAppServer', () => {
  // A missing binary used to emit an unhandled 'error' on the child, which takes
  // the whole main process down. If that listener goes away this test does not
  // fail — the test runner dies with it.
  test('surfaces a missing codex binary as a rejection, not a process crash', async () => {
    const server = new CodexAppServer()

    await expect(server.listModels('/nonexistent/kodi-codex-binary', process.cwd())).rejects.toThrow()

    server.stop()
  })

  test('stop rejects an initialize request that is still pending', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-codex-test-'))
    const executable = join(directory, 'codex-stub')
    await writeFile(executable, '#!/bin/sh\nwhile IFS= read -r line; do :; done\n', 'utf8')
    await chmod(executable, 0o755)
    const server = new CodexAppServer()
    try {
      const pending = server.listModels(executable, directory)
      await new Promise((resolve) => setTimeout(resolve, 20))
      server.stop()
      await expect(pending).rejects.toThrow('Codex was stopped.')
    } finally {
      server.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('CodexAppServer.runStructured', () => {
  // A scripted app-server: answers initialize, thread/start and turn/start, then
  // streams one agent message and completes the turn. Every request is logged.
  async function scriptedServer(turnScript: string): Promise<{ executable: string; log: string; directory: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-codex-structured-'))
    const executable = join(directory, 'codex-stub')
    const log = join(directory, 'requests.jsonl')
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('fs')
const rl = require('readline').createInterface({ input: process.stdin })
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method == null) return
  fs.appendFileSync(${JSON.stringify(log)}, line + '\\n')
  if (message.method === 'initialize') send({ id: message.id, result: {} })
  else if (message.method === 'thread/start') send({ id: message.id, result: { thread: { id: 't1' } } })
  else if (message.method === 'turn/interrupt') send({ id: message.id, result: {} })
  else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'u1' } } })
    ${turnScript}
  }
})
`, 'utf8')
    await chmod(executable, 0o755)
    return { executable, log, directory }
  }

  test('asks for the schema on an ephemeral read-only thread and returns the final message', async () => {
    const { executable, log, directory } = await scriptedServer(`
    send({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'r1', delta: 'thinking' } })
    send({ method: 'item/agentMessage/delta', params: { itemId: 'm1', delta: '{"a"' } })
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'm1', text: '{"a":1}' } } })
    send({ method: 'turn/completed', params: { turn: { id: 'u1', status: 'completed' } } })`)
    const server = new CodexAppServer()
    const phases: string[] = []
    try {
      const text = await server.runStructured({
        executable,
        cwd: directory,
        prompt: 'Return JSON.',
        model: 'gpt-x',
        effort: 'low',
        schema: { type: 'object' },
        timeoutMs: 10_000,
        onPhase: (phase) => { if (phases.at(-1) !== phase) phases.push(phase) }
      })
      expect(JSON.parse(text)).toEqual({ a: 1 })
      expect(phases).toEqual(['thinking', 'writing'])
      const requests = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> })
      const thread = requests.find((entry) => entry.method === 'thread/start')
      const turn = requests.find((entry) => entry.method === 'turn/start')
      expect(thread?.params).toMatchObject({ ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', model: 'gpt-x' })
      expect(turn?.params).toMatchObject({
        outputSchema: { type: 'object' },
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        approvalPolicy: 'never',
        effort: 'low'
      })
    } finally {
      server.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('a turn that completes as failed rejects with the provider message', async () => {
    const { executable, directory } = await scriptedServer(`
    send({ method: 'turn/completed', params: { turn: { id: 'u1', status: 'failed', error: { message: JSON.stringify({ type: 'error', error: { message: 'The model is not supported.' } }) } } } })`)
    const server = new CodexAppServer()
    try {
      await expect(server.runStructured({
        executable, cwd: directory, prompt: 'x', model: '', effort: '', schema: { type: 'object' }, timeoutMs: 10_000
      })).rejects.toThrow('The model is not supported.')
    } finally {
      server.stop()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

test('a structured run starts its server with no MCP servers and no shell', () => {
  const args = codexServerArgs(CODEX_TOOLLESS_CONFIG)
  expect(args[0]).toBe('app-server')
  expect(args).toContain('mcp_servers={}')
  expect(args).toContain('features.shell_tool=false')
  expect(args).toContain('features.unified_exec=false')
  expect(args.filter((arg) => arg === '-c').length).toBe(CODEX_TOOLLESS_CONFIG.length)
  expect(codexServerArgs([])).toEqual(['app-server'])
})
