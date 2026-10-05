import type { Range } from '@pierre/diffs/edit'

/**
 * The subset of the library's `SelectionActionContext` this app uses. The type
 * is not re-exported from `@pierre/diffs/edit`, and the callback is supplied
 * structurally.
 */
export interface SelectionActionContext {
  selection: Range
  getSelectionText(): string
  close(): void
}

export interface SelectionAction {
  /** The button's name, read out and shown as its tooltip. */
  label: string
  tooltip?: string
  icon: 'copy' | 'chat' | 'comment'
  /** The action the selection is for (Comment): its glyph carries the accent. */
  primary?: boolean
  run(context: SelectionActionContext): void
}

/**
 * One-based inclusive line range for a selection. A selection that ends at
 * character zero stops on the previous line's break, so the trailing line is
 * not part of what the user highlighted.
 */
export function selectionLineRange(selection: Range): { startLine: number; endLine: number } {
  const startLine = selection.start.line + 1
  const endLine = selection.end.character === 0 && selection.end.line > selection.start.line
    ? selection.end.line
    : selection.end.line + 1
  return { startLine, endLine }
}
