export const DEFAULT_TERMINAL_HEIGHT = 260
export const MIN_TERMINAL_HEIGHT = 150

const TITLEBAR_HEIGHT = 48
const MIN_WORKSPACE_HEIGHT = 180
const MAX_VIEWPORT_SHARE = 0.62

export function terminalHeightRange(viewportHeight: number): { minimum: number; maximum: number } {
  const usableHeight = Math.max(MIN_TERMINAL_HEIGHT, viewportHeight - TITLEBAR_HEIGHT)
  const maximum = Math.max(
    MIN_TERMINAL_HEIGHT,
    Math.min(usableHeight - MIN_WORKSPACE_HEIGHT, Math.floor(usableHeight * MAX_VIEWPORT_SHARE))
  )
  return { minimum: MIN_TERMINAL_HEIGHT, maximum }
}

export function clampTerminalHeight(height: number, viewportHeight: number): number {
  const range = terminalHeightRange(viewportHeight)
  if (!Number.isFinite(height)) return Math.min(DEFAULT_TERMINAL_HEIGHT, range.maximum)
  return Math.round(Math.min(range.maximum, Math.max(range.minimum, height)))
}

export function resizedTerminalHeight(
  initialHeight: number,
  initialPointerY: number,
  pointerY: number,
  viewportHeight: number
): number {
  return clampTerminalHeight(initialHeight + initialPointerY - pointerY, viewportHeight)
}

export function resistedTerminalHeight(
  initialHeight: number,
  initialPointerY: number,
  pointerY: number,
  viewportHeight: number
): number {
  const range = terminalHeightRange(viewportHeight)
  const raw = initialHeight + initialPointerY - pointerY
  return Math.round(withResistance(raw, range.minimum, range.maximum, viewportHeight))
}
import { withResistance } from '../diff/rubberband'
