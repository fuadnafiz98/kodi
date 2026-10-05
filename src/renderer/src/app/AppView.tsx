import type { DocumentView } from '../review/documentView'

// The vocabulary the app shell, the workspace and the viewers share. The
// components that used to live here are one per file now (Titlebar,
// ReviewLocator, ReviewFolderChip, ErrorBanner, DiffToolbar,
// FilePathBreadcrumbs, UnsavedDraftsPill); only the types stayed, because a
// dozen modules import them and moving them would churn every one.

export type DiffStyle = 'split' | 'unified'
export type WorkspaceView = 'file' | 'multi'

/** Where a click in the code put the caret: one-based line, zero-based column. */
export interface EditCaretPosition {
  lineNumber: number
  character: number
}

export interface FileEditControls {
  /** The open file can be edited in place: a click in its code starts editing. */
  available: boolean
  /** Why it cannot: binary, oversized, or a review is open. */
  unavailableReason: string | null
  mode: 'read' | 'edit'
  documentView: DocumentView
  dirty: boolean
  saving: boolean
  unsavedPaths: readonly string[]
  onStart(position?: EditCaretPosition): void
  onDocumentViewChange(view: DocumentView): void
  onRevert(): void
  onSave(): void
  onOpenPath(path: string): void
}
