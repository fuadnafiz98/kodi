import type { DocumentView } from '../review/documentView'
import type { CaretReadout } from './caret'

export type EditorStatusMode = 'read' | 'edit' | 'preview'

/** What the status bar calls the current mode, left of everything else. */
export function editorStatusLabel(mode: EditorStatusMode, documentView: DocumentView): string {
  if (mode === 'edit') return 'Editing'
  if (mode === 'preview') return 'Draft preview'
  if (documentView === 'preview') return 'Preview'
  if (documentView === 'split') return 'Source and preview'
  return 'Read only'
}

/** Lines win over characters; `null` means nothing is selected worth reporting. */
export function caretSelectionLabel(caret: CaretReadout): string | null {
  if (caret.selectedLines > 0) return `${caret.selectedLines} lines selected`
  if (caret.selectedCharacters > 0) return `${caret.selectedCharacters} selected`
  return null
}
