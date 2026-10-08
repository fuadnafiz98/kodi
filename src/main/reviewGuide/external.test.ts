import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { contextFromTranscript, readClaudeSessionContext, readGuideFile } from './external.js'

const line = (type: string, role: string, content: unknown, extra: object = {}): string =>
  JSON.stringify({ type, message: { role, content }, ...extra })

describe('readGuideFile', () => {
  test('parses JSON and names what is wrong otherwise', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'kodi-guide-file-'))
    try {
      await writeFile(join(folder, 'g.json'), '{"title":"x"}')
      await writeFile(join(folder, 'bad.json'), '{')
      expect(await readGuideFile(join(folder, 'g.json'))).toEqual({ title: 'x' })
      expect(readGuideFile(join(folder, 'bad.json'))).rejects.toThrow('not valid JSON')
      expect(readGuideFile(join(folder, 'none.json'))).rejects.toThrow('No guide file')
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})

describe('contextFromTranscript', () => {
  test('keeps user and assistant text, skipping tools, meta and command plumbing', () => {
    const transcript = [
      line('user', 'user', 'Make the parser skip comments.'),
      line('assistant', 'assistant', [{ type: 'text', text: 'Done: the lexer drops them.' }, { type: 'tool_use', name: 'Edit' }]),
      line('user', 'user', [{ type: 'tool_result', content: 'ok' }]),
      line('user', 'user', '<command-name>/clear</command-name>'),
      line('user', 'user', 'meta', { isMeta: true }),
      JSON.stringify({ type: 'summary', summary: 'x' }),
      'not json'
    ].join('\n')
    expect(contextFromTranscript(transcript, false)).toEqual([
      { role: 'user', text: 'Make the parser skip comments.' },
      { role: 'assistant', text: 'Done: the lexer drops them.' }
    ])
  })

  test('keeps the newest 18 messages, each and all capped', () => {
    const many = Array.from({ length: 30 }, (_unused, index) => line('user', 'user', `message ${index}`)).join('\n')
    const kept = contextFromTranscript(many, false)
    expect(kept).toHaveLength(18)
    expect(kept.at(-1)!.text).toBe('message 29')
    const long = [line('user', 'user', 'a'.repeat(5_000))].join('\n')
    expect(contextFromTranscript(long, false)[0]!.text).toHaveLength(2_400)
    const heavy = Array.from({ length: 15 }, () => line('user', 'user', 'b'.repeat(2_400))).join('\n')
    expect(contextFromTranscript(heavy, false).length).toBe(11)
  })

  test('drops the partial first line of a tail read', () => {
    expect(contextFromTranscript(`ole": "user"}}\n${line('user', 'user', 'kept')}`, true)).toEqual([{ role: 'user', text: 'kept' }])
  })
})

describe('readClaudeSessionContext', () => {
  test('finds the transcript in any project folder; a bad id reads nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kodi-home-'))
    const id = '1b4e28ba-2fa1-11d2-883f-0016d3cca427'
    try {
      await mkdir(join(home, '.claude', 'projects', '-repo'), { recursive: true })
      await writeFile(join(home, '.claude', 'projects', '-repo', `${id}.jsonl`), line('user', 'user', 'Why?'))
      expect(await readClaudeSessionContext(home, id)).toEqual([{ role: 'user', text: 'Why?' }])
      expect(await readClaudeSessionContext(home, '../../etc/passwd')).toEqual([])
      expect(await readClaudeSessionContext(join(home, 'none'), id)).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
