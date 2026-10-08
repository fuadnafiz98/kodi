import { describe, expect, test } from 'bun:test'

import type { StructuredRunRequest } from './agentService.js'
import { fairTruncateDiff, normalizeCommitMessage, suggestCommitMessage } from './commitMessage.js'
import { joinPatch, modifiedFile } from './reviewGuide/testFixtures.js'

const REQUEST = { id: 'c1', root: '/repo', name: 'repo', branch: 'main', provider: 'codex' as const, model: 'm', effort: 'default' }

describe('suggestCommitMessage', () => {
  test('asks the model with the staged diff and maps its answer', async () => {
    const diff = modifiedFile('src/a.ts', [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }])
    const calls: StructuredRunRequest[] = []
    const message = await suggestCommitMessage(REQUEST, {
      stagedDiff: async () => diff,
      runStructured: async (request) => {
        calls.push(request)
        return { json: { title: 'Swap a for b.', body: 'Swap a for b\n\nThe parser wants b.' }, model: 'm', usage: null }
      }
    })
    expect(calls[0]!.prompt).toContain('+b')
    expect(calls[0]!.prompt).toContain('Repository: repo · Branch: main')
    expect(message).toEqual({ title: 'Swap a for b', body: 'The parser wants b.' })
  })

  test('nothing staged is said, not sent', async () => {
    expect(suggestCommitMessage(REQUEST, {
      stagedDiff: async () => '',
      runStructured: async () => { throw new Error('unused') }
    })).rejects.toThrow('Stage changes first')
  })
})

describe('normalizeCommitMessage', () => {
  test('caps the title at 72 and keeps one line', () => {
    const { title } = normalizeCommitMessage({ title: `${'x'.repeat(100)}\nsecond`, body: '' })
    expect(title.length).toBe(72)
    expect(() => normalizeCommitMessage({ title: '', body: 'x' })).toThrow()
  })
})

describe('fairTruncateDiff', () => {
  test('a huge file cannot crowd out a small one', () => {
    const small = modifiedFile('src/small.ts', [{ oldStart: 1, newStart: 1, lines: ['+keep me'] }])
    const huge = modifiedFile('bun.lock', [{ oldStart: 1, newStart: 1, lines: Array.from({ length: 5_000 }, (_unused, index) => `+line ${index}`) }])
    const cut = fairTruncateDiff(joinPatch(huge, small), 4_000)
    expect(cut).toContain('+keep me')
    expect(cut).toContain('…')
    expect(cut.length).toBeLessThan(4_100)
  })
})
