import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  isReachable,
  loadWindowState,
  parseWindowState,
  saveWindowState,
  type ScreenArea,
  type WindowState
} from './windowState.js'

const LAPTOP: ScreenArea = { x: 0, y: 25, width: 1728, height: 1080 }
const EXTERNAL: ScreenArea = { x: 1728, y: 0, width: 2560, height: 1440 }

function state(overrides: Partial<WindowState> = {}): WindowState {
  return { x: 120, y: 80, width: 1440, height: 920, maximized: false, ...overrides }
}

describe('parseWindowState', () => {
  it('rounds a valid rect and defaults maximized to false', () => {
    expect(parseWindowState({ x: 12.4, y: 80.6, width: 1440.2, height: 920 })).toEqual({
      x: 12,
      y: 81,
      width: 1440,
      height: 920,
      maximized: false
    })
  })

  it('rejects anything that is not a usable rect', () => {
    expect(parseWindowState(null)).toBeNull()
    expect(parseWindowState('{}')).toBeNull()
    expect(parseWindowState({ x: 0, y: 0, width: 1440 })).toBeNull()
    expect(parseWindowState({ x: 0, y: 0, width: 0, height: 920 })).toBeNull()
    expect(parseWindowState({ x: Number.NaN, y: 0, width: 1440, height: 920 })).toBeNull()
  })
})

describe('isReachable', () => {
  it('accepts a window on either display', () => {
    expect(isReachable(state(), [LAPTOP, EXTERNAL])).toBe(true)
    expect(isReachable(state({ x: 2000, y: 200 }), [LAPTOP, EXTERNAL])).toBe(true)
  })

  it('rejects a window left on a display that is gone', () => {
    expect(isReachable(state({ x: 2000, y: 200 }), [LAPTOP])).toBe(false)
  })

  it('keeps a window nudged part way off an edge', () => {
    expect(isReachable(state({ x: -1340 }), [LAPTOP])).toBe(true)
  })

  it('rejects a window with only a sliver on screen', () => {
    expect(isReachable(state({ x: -1400 }), [LAPTOP])).toBe(false)
  })
})

describe('loadWindowState', () => {
  it('round-trips through disk and drops an unreachable rect', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-window-'))
    try {
      saveWindowState(directory, state({ x: 2000, y: 200, maximized: true }))
      expect(loadWindowState(directory, [LAPTOP, EXTERNAL])).toEqual(state({ x: 2000, y: 200, maximized: true }))
      expect(loadWindowState(directory, [LAPTOP])).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns null when nothing was ever saved', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-window-'))
    try {
      expect(loadWindowState(directory, [LAPTOP])).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
