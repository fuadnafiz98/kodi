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

/**
 * Whether the line a `+` press landed on is already inside the selection the
 * reader made. When it is, the press acts on that selection — collapsing the
 * range to the pressed line would throw away exactly what they are about to
 * comment on or copy.
 */
export function selectionCoversGutterLine(
  selection: CodeViewLineSelection,
  itemId: string,
  lineNumber: number,
  side: 'additions' | 'deletions' | undefined
): boolean {
  if (selection.id !== itemId) return false
  const first = Math.min(selection.range.start, selection.range.end)
  const last = Math.max(selection.range.start, selection.range.end)
  if (lineNumber < first || lineNumber > last) return false
  const selectionSide = selection.range.endSide ?? selection.range.side
  const pressedSide = side ?? selection.range.endSide ?? selection.range.side
  return selectionSide == null || pressedSide == null || selectionSide === pressedSide
}
