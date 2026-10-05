import { describe, expect, test } from 'bun:test'

import { minimalTextEdit, type TextEdit } from './minimalTextEdit'

function apply(text: string, edit: TextEdit | null): string {
  if (edit == null) return text
  const lines = text.split('\n')
  const offset = ({ line, character }: { line: number; character: number }): number =>
    lines.slice(0, line).reduce((total, current) => total + current.length + 1, 0) + character
  return text.slice(0, offset(edit.range.start)) + edit.newText + text.slice(offset(edit.range.end))
}

describe('minimalTextEdit', () => {
  test('nothing to do for the same text', () => {
    expect(minimalTextEdit('a\nb\n', 'a\nb\n')).toBeNull()
  })

  test('a deleted character comes back as that character, on its line', () => {
    const edit = minimalTextEdit('one\ntw\nthree\n', 'one\ntwo\nthree\n')
    expect(edit).toEqual({ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } }, newText: 'o' })
    expect(apply('one\ntw\nthree\n', minimalTextEdit('one\ntw\nthree\n', 'one\ntwo\nthree\n'))).toBe('one\ntwo\nthree\n')
  })

  test('a joined line is split again', () => {
    const from = 'one\ntwothree\n'
    const to = 'one\ntwo\nthree\n'
    expect(apply(from, minimalTextEdit(from, to))).toBe(to)
  })

  test('repeated text keeps the edit inside the change', () => {
    const from = 'aaaa'
    const to = 'aa'
    const edit = minimalTextEdit(from, to)!
    expect(apply(from, edit)).toBe(to)
    expect(edit.newText).toBe('')
  })

  test('edits at both ends and across lines round-trip', () => {
    const pairs: Array<[string, string]> = [
      ['', 'new\n'],
      ['old\n', ''],
      ['x\ny\nz', 'X\ny\nZ'],
      ['a\n\n\nb', 'a\nb']
    ]
    for (const [from, to] of pairs) expect(apply(from, minimalTextEdit(from, to))).toBe(to)
  })
})
