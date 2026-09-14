import { describe, expect, test } from 'bun:test'

import {
  clampTerminalHeight,
  resistedTerminalHeight,
  resizedTerminalHeight,
  terminalHeightRange
} from './terminalPanel'

describe('terminal panel sizing', () => {
  test('preserves usable editor space at the minimum supported window size', () => {
    expect(terminalHeightRange(620)).toEqual({ minimum: 150, maximum: 354 })
    expect(clampTerminalHeight(500, 620)).toBe(354)
  })

  test('grows upward and clamps pointer resizing', () => {
    expect(resizedTerminalHeight(260, 600, 540, 900)).toBe(320)
    expect(resizedTerminalHeight(260, 600, 900, 900)).toBe(150)
  })

  test('keeps moving with resistance past a drag limit', () => {
    expect(resistedTerminalHeight(260, 600, 900, 900)).toBeLessThan(150)
    expect(resistedTerminalHeight(260, 600, 0, 900)).toBeGreaterThan(528)
  })
})
