import { describe, expect, test } from 'bun:test'

import {
  GUTTER_DOUBLE_CLICK_INTERVAL_MS,
  isGutterDoubleClick,
  selectionCoversGutterLine
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

describe('selectionCoversGutterLine', () => {
  const ranged = { id: 'review:file.ts', range: { start: 12, end: 18, side: 'additions' as const } }

  test('a press inside the selected range is covered, outside is not', () => {
    expect(selectionCoversGutterLine(ranged, 'review:file.ts', 15, 'additions')).toBe(true)
    expect(selectionCoversGutterLine(ranged, 'review:file.ts', 12, 'additions')).toBe(true)
    expect(selectionCoversGutterLine(ranged, 'review:file.ts', 18, 'additions')).toBe(true)
    expect(selectionCoversGutterLine(ranged, 'review:file.ts', 19, 'additions')).toBe(false)
  })

  test('a press on another file or the opposite side is not covered', () => {
    expect(selectionCoversGutterLine(ranged, 'review:other.ts', 15, 'additions')).toBe(false)
    expect(selectionCoversGutterLine(ranged, 'review:file.ts', 15, 'deletions')).toBe(false)
  })

  test('a press with no reported side is covered by whatever side the range is on', () => {
    expect(selectionCoversGutterLine(ranged, 'review:file.ts', 15, undefined)).toBe(true)
  })
})
