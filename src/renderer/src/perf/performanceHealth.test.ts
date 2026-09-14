import { describe, expect, test } from 'bun:test'

import { isHighMemory } from './performanceHealth'
import {
  HIGH_MEMORY_HIDDEN_RELEASE_DELAY_MS,
  HIDDEN_VIEWER_RELEASE_DELAY_MS,
  hiddenViewerReleaseDelayMs
} from '../app/useViewerSuspension'

describe('performance health', () => {
  test('warns when the application working set reaches 1 GB', () => {
    expect(isHighMemory(1024)).toBe(true)
    expect(isHighMemory(1023)).toBe(false)
    expect(isHighMemory(undefined)).toBe(false)
  })

  test('does not warn before the first sample', () => {
    expect(isHighMemory(undefined)).toBe(false)
  })
})

describe('hidden viewer release', () => {
  test('keeps the five-minute delay under normal memory', () => {
    expect(hiddenViewerReleaseDelayMs(512)).toBe(HIDDEN_VIEWER_RELEASE_DELAY_MS)
  })

  test('releases after one minute once the working set is already at 1 GB', () => {
    expect(hiddenViewerReleaseDelayMs(1200)).toBe(HIGH_MEMORY_HIDDEN_RELEASE_DELAY_MS)
  })
})
