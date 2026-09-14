import type { DocumentView } from '../review/documentView'

// The vocabulary the app shell, the workspace and the viewers share. The
// components that used to live here are one per file now (Titlebar,
// ReviewLocator, ReviewFolderChip, ErrorBanner, DiffToolbar,
// FilePathBreadcrumbs, UnsavedDraftsPill); only the types stayed, because a
// dozen modules import them and moving them would churn every one.

export type DiffStyle = 'split' | 'unified'
export type WorkspaceView = 'file' | 'multi'

export interface FileEditControls {
  available: boolean
  /** Why the Edit button is disabled: binary, oversized, or a review is open. */
  unavailableReason: string | null
  startLabel: 'Edit' | 'Resume draft'
  mode: 'read' | 'edit' | 'preview'
  documentView: DocumentView
  dirty: boolean
  saving: boolean
  canUndo: boolean
  canRedo: boolean
  unsavedPaths: readonly string[]
  onStart(): void
  onModeChange(mode: 'edit' | 'preview'): void
  onDocumentViewChange(view: DocumentView): void
  onUndo(): void
  onRedo(): void
  onCancel(): void
  onRevert(): void
  onSave(): void
  onOpenPath(path: string): void
}
