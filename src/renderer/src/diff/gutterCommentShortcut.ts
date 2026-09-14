import type { CodeViewLineSelection } from '@pierre/diffs'

export const GUTTER_DOUBLE_CLICK_INTERVAL_MS = 500

interface GutterActivation {
  selection: CodeViewLineSelection
  timestamp: number
}

function sameSelection(
  first: CodeViewLineSelection,
  second: CodeViewLineSelection
): boolean {
  return first.id === second.id &&
    first.range.start === second.range.start &&
    first.range.end === second.range.end &&
    first.range.side === second.range.side
}

export function isGutterDoubleClick(
  previous: GutterActivation | null,
  selection: CodeViewLineSelection,
  timestamp: number
): boolean {
  if (previous == null || !sameSelection(previous.selection, selection)) return false
  const elapsed = timestamp - previous.timestamp
  return elapsed >= 0 && elapsed <= GUTTER_DOUBLE_CLICK_INTERVAL_MS
}
