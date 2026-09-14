import { describe, expect, test } from 'bun:test'

import {
  GUTTER_DOUBLE_CLICK_INTERVAL_MS,
  isGutterDoubleClick
} from './gutterCommentShortcut'

const selection = (id = 'review:file.ts', start = 12, end = start) => ({
  id,
  range: { start, end, side: 'additions' as const }
})

describe('gutter comment shortcut', () => {
  test('recognizes a second activation on the same range', () => {
    const current = selection()
    expect(isGutterDoubleClick({ selection: current, timestamp: 100 }, current, 240)).toBe(true)
  })

  test('does not combine activations on different ranges or files', () => {
    const previous = { selection: selection(), timestamp: 100 }
    expect(isGutterDoubleClick(previous, selection('review:file.ts', 13), 200)).toBe(false)
    expect(isGutterDoubleClick(previous, selection('review:other.ts'), 200)).toBe(false)
  })

  test('expires after the double-click interval', () => {
    const current = selection()
    expect(isGutterDoubleClick(
      { selection: current, timestamp: 100 },
      current,
      100 + GUTTER_DOUBLE_CLICK_INTERVAL_MS + 1
    )).toBe(false)
  })
})
