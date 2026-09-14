import { IconPencil } from '@pierre/icons'

import type { FileEditControls, WorkspaceView } from '../app/AppView'

export interface FileEditStartButtonProps {
  fileEdit: FileEditControls
  workspaceView: WorkspaceView
}

/** The way into edit mode, or a disabled button that says why there isn't one. */
export function FileEditStartButton({ fileEdit, workspaceView }: FileEditStartButtonProps): React.JSX.Element | null {
  if (fileEdit.available) {
    if (fileEdit.mode !== 'read') return null
    return (
      <button className="file-edit-start" type="button" onClick={fileEdit.onStart}>
        <IconPencil /><span>{fileEdit.startLabel}</span>
      </button>
    )
  }
  if (fileEdit.unavailableReason == null || workspaceView !== 'file') return null
  return (
    <button className="file-edit-start" type="button" disabled
      title={fileEdit.unavailableReason} aria-describedby="file-edit-unavailable">
      <IconPencil /><span>Edit</span>
      <span id="file-edit-unavailable" hidden>{fileEdit.unavailableReason}</span>
    </button>
  )
}
