import { describe, expect, test } from 'bun:test'

import { customEditorCommand, defaultEditorCommands, openInEditor, runDetached, tokenizeCommand, type EditorCommand } from './editorOpener.js'

const TARGET = { file: '/repo/src/my app.ts', line: 7, repo: '/repo' }

describe('tokenizeCommand', () => {
  test('splits on whitespace and keeps quoted runs, escapes included', () => {
    expect(tokenizeCommand(`subl "{repo}" "{file}:{line}"`)).toEqual(['subl', '{repo}', '{file}:{line}'])
    expect(tokenizeCommand(`open -a 'Sublime Text'  {file}`)).toEqual(['open', '-a', 'Sublime Text', '{file}'])
    expect(tokenizeCommand(`zed "a \\"b\\"" ''`)).toEqual(['zed', 'a "b"', ''])
  })
})

describe('customEditorCommand', () => {
  test('fills the placeholders, a path with spaces staying one argument', () => {
    expect(customEditorCommand(`subl "{repo}" "{file}:{line}"`, TARGET))
      .toEqual({ executable: 'subl', args: ['/repo', '/repo/src/my app.ts:7'] })
  })

  test('appends the file when the command never names it', () => {
    expect(customEditorCommand('zed --wait', TARGET)).toEqual({ executable: 'zed', args: ['--wait', '/repo/src/my app.ts'] })
  })

  test('drops `:{line}` when the line is unknown, and an empty command means the default', () => {
    expect(customEditorCommand('code -g {file}:{line}', { ...TARGET, line: null }))
      .toEqual({ executable: 'code', args: ['-g', '/repo/src/my app.ts'] })
    expect(customEditorCommand('   ', TARGET)).toBeNull()
  })
})

describe('openInEditor', () => {
  test('tries the VS Code chain in order until one exits 0', async () => {
    const tried: EditorCommand[] = []
    const opened = await openInEditor('', TARGET, async (command) => {
      tried.push(command)
      return command.executable === 'code'
    })
    expect(opened).toBe(true)
    expect(tried.map((command) => command.executable)).toEqual(['/opt/homebrew/bin/code', '/usr/local/bin/code', 'code'])
    expect(tried[0]!.args).toEqual(['-g', '/repo/src/my app.ts:7'])
  })

  test('a custom command is tried alone; false when it fails', async () => {
    const tried: EditorCommand[] = []
    expect(await openInEditor('nope {file}', TARGET, async (command) => { tried.push(command); return false })).toBe(false)
    expect(tried).toHaveLength(1)
  })

  test('the chain ends in macOS opening the file', () => {
    expect(defaultEditorCommands(TARGET).at(-1)).toEqual({ executable: 'open', args: ['-t', '/repo/src/my app.ts'] })
  })
})

describe('runDetached', () => {
  test('a command that keeps running (an editor that waits) counts as opened and is not killed', async () => {
    const started = Date.now()
    expect(await runDetached({ executable: 'sleep', args: ['5'] }, 200)).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('a quick failure and a missing command do not', async () => {
    expect(await runDetached({ executable: 'false', args: [] }, 2_000)).toBe(false)
    expect(await runDetached({ executable: 'kodi-no-such-editor', args: [] }, 2_000)).toBe(false)
    expect(await runDetached({ executable: 'true', args: [] }, 2_000)).toBe(true)
  })
})
