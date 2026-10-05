import type { FileEditControls, WorkspaceView } from '../app/AppView'

export interface ReadOnlyBadgeProps {
  fileEdit: FileEditControls
  workspaceView: WorkspaceView
}

/**
 * Every editable file is edited by clicking into it, so only the exception is
 * named: a quiet word, with the reason — binary, oversized, a review open — as
 * its tooltip.
 */
export function ReadOnlyBadge({ fileEdit, workspaceView }: ReadOnlyBadgeProps): React.JSX.Element | null {
  if (fileEdit.available || fileEdit.unavailableReason == null || workspaceView !== 'file') return null
  return (
    <span className="review-state-pill file-read-only" title={fileEdit.unavailableReason}
      aria-label={`Read-only: ${fileEdit.unavailableReason}`}>
      Read-only
    </span>
  )
}
