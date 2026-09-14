import type { FileComparison } from '../../../shared/contracts'
import { isMarkdownPath } from '../../../shared/markdownPreview'
import type { FileEditControls, WorkspaceView } from '../app/AppView'

export function formatStatus(status: FileComparison['status']): string {
  switch (status) {
    case 'added': return 'Added'
    case 'conflicted': return 'Conflicted'
    case 'deleted': return 'Deleted'
    case 'modified': return 'Modified'
    case 'renamed': return 'Renamed'
    case 'untracked': return 'Untracked'
    default: return 'No changes'
  }
}

export interface DiffToolbarSubject {
  selectedPath: string | null
  workspaceView: WorkspaceView
  isFilePreview: boolean
  isGitRepository: boolean
  reviewTitle?: string
  reviewComparison?: string
  reviewFileCount: number
}

/** The name in the middle of the toolbar; `undefined` when nothing is open. */
export function diffToolbarDisplayName({
  selectedPath,
  workspaceView,
  isFilePreview,
  reviewTitle
}: DiffToolbarSubject): string | undefined {
  if (workspaceView === 'multi') return reviewTitle ?? 'Repository review'
  if (isFilePreview) return selectedPath?.split('/').at(-1)
  return selectedPath ?? undefined
}

/** The small line under the name: what is being compared with what. */
export function diffToolbarComparisonLabel({
  workspaceView,
  isGitRepository,
  reviewComparison,
  reviewFileCount
}: DiffToolbarSubject): string {
  if (workspaceView === 'multi') {
    return reviewComparison ?? `${reviewFileCount} ${isGitRepository ? 'changed' : 'project'} files`
  }
  return isGitRepository ? 'HEAD → Working Tree' : 'Read-only preview'
}

export interface DiffToolbarLayout {
  showDiffLayout: boolean
  showEditStart: boolean
  showMarkdownViewToggle: boolean
  markdownPreviewOnly: boolean
}

/** Which control groups the toolbar shows for the surface currently open. */
export function diffToolbarLayout(
  { selectedPath, workspaceView, isFilePreview, isGitRepository }: DiffToolbarSubject,
  fileEdit: FileEditControls
): DiffToolbarLayout {
  const markdownPath = selectedPath != null && isMarkdownPath(selectedPath)
  return {
    showDiffLayout: isGitRepository && (workspaceView === 'multi' || !isFilePreview),
    showEditStart: (fileEdit.available && fileEdit.mode === 'read')
      || (!fileEdit.available && fileEdit.unavailableReason != null && workspaceView === 'file'),
    showMarkdownViewToggle: markdownPath && workspaceView === 'file' && fileEdit.mode === 'read',
    markdownPreviewOnly: markdownPath && (
      fileEdit.mode === 'preview'
      || (fileEdit.mode === 'read' && fileEdit.documentView === 'preview')
    )
  }
}
