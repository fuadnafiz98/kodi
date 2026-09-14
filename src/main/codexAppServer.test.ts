import { describe, expect, test } from 'bun:test'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CodexAppServer, getCodexThreadAccess, getCodexTurnSandbox } from './codexAppServer.js'

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
