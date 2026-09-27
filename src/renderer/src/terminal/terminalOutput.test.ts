import { describe, expect, test } from 'bun:test'
import { TERMINAL_WRITE_CHUNK, writeTerminalOutput } from './TerminalDock'

function recorder(): { writes: string[]; write(data: string): void } {
  return {
    writes: [],
    write(data: string) { this.writes.push(data) }
  }
}

describe('writeTerminalOutput', () => {
  test('passes ordinary output through as one write', () => {
    const terminal = recorder()
    writeTerminalOutput(terminal, 'ls -la\r\n')
    expect(terminal.writes).toEqual(['ls -la\r\n'])
  })

  test('splits the replay of a hidden dock into bounded slices, in order', () => {
    // What main replays after `yes | head -c 2M` behind a closed dock: its cap.
    const replay = 'y\n'.repeat(256 * 1_024)
    const terminal = recorder()

    writeTerminalOutput(terminal, replay)

    expect(terminal.writes).toHaveLength(8)
    expect(Math.max(...terminal.writes.map((chunk) => chunk.length))).toBe(TERMINAL_WRITE_CHUNK)
    expect(terminal.writes.join('')).toBe(replay)
  })

  test('never splits a surrogate pair across two writes', () => {
    const replay = `${'a'.repeat(9)}😀${'b'.repeat(20)}`
    const terminal = recorder()

    writeTerminalOutput(terminal, replay, 10)

    expect(terminal.writes.join('')).toBe(replay)
    for (const chunk of terminal.writes) {
      const last = chunk.charCodeAt(chunk.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
  })
})
