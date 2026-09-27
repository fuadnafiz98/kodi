import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { quarantineFile, writeFileAtomic, writeFileAtomicSync } from './atomicWrite.js'

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export interface ScreenArea {
  x: number
  y: number
  width: number
  height: number
}

// A saved window has to overlap a work area by more than a hairline before it is
// worth restoring: a display that was unplugged since the last session leaves
// coordinates that open the window somewhere the user cannot drag it back from.
const MIN_VISIBLE_PIXELS = 80

const FILE_NAME = 'window-state.json'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function parseWindowState(raw: unknown): WindowState | null {
  if (typeof raw !== 'object' || raw == null) return null
  const { x, y, width, height, maximized } = raw as Record<string, unknown>
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null
  if (width < 1 || height < 1) return null
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    maximized: maximized === true
  }
}

/**
 * Overlap rather than containment, so a window the user deliberately nudged part
 * way off an edge still comes back exactly where they left it.
 */
export function isReachable(state: WindowState, workAreas: readonly ScreenArea[]): boolean {
  return workAreas.some((area) => {
    const overlapX = Math.min(state.x + state.width, area.x + area.width) - Math.max(state.x, area.x)
    const overlapY = Math.min(state.y + state.height, area.y + area.height) - Math.max(state.y, area.y)
    return overlapX >= MIN_VISIBLE_PIXELS && overlapY >= MIN_VISIBLE_PIXELS
  })
}

/**
 * Synchronous on purpose: the bounds are constructor arguments for the first
 * BrowserWindow, so there is nothing useful to overlap the read with.
 */
export function loadWindowState(directory: string, workAreas: readonly ScreenArea[]): WindowState | null {
  const path = join(directory, FILE_NAME)
  try {
    const state = parseWindowState(JSON.parse(readFileSync(path, 'utf8')))
    return state != null && isReachable(state, workAreas) ? state : null
  } catch {
    try {
      readFileSync(path)
      quarantineFile(path)
    } catch {
      // A missing file is the normal first-launch case.
    }
    return null
  }
}

// Bumped by every save, so a debounced write still on its way to disk yields to
// a newer one — above all to the synchronous save on close, which would
// otherwise be overwritten by older bounds renamed into place after it.
let latestSave = 0

/**
 * Synchronous for `close` and quit, where the process may be gone before an
 * asynchronous write lands. Everything else uses `saveWindowStateAsync`.
 */
export function saveWindowState(directory: string, state: WindowState): void {
  latestSave += 1
  const path = join(directory, FILE_NAME)
  try {
    writeFileAtomicSync(path, JSON.stringify(state, null, 2))
  } catch (error) {
    console.error('Could not persist window geometry:', error)
  }
}

/**
 * The debounced save after a drag or resize. Two fsyncs on the main thread
 * stalled input for the length of a disk flush on every settle of the window.
 */
export async function saveWindowStateAsync(directory: string, state: WindowState): Promise<void> {
  const save = ++latestSave
  const path = join(directory, FILE_NAME)
  try {
    await writeFileAtomic(path, JSON.stringify(state, null, 2), () => save === latestSave)
  } catch (error) {
    console.error('Could not persist window geometry:', error)
  }
}
