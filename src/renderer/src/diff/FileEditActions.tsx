import { IconCheck, IconClockArrow, IconRefresh } from '@pierre/icons'

import type { FileEditControls } from '../app/AppView'
import { UnsavedDraftsPill } from '../review/UnsavedDraftsPill'
import { formatEditorShortcut } from '../editor/editorKeymap'

const SAVE_SHORTCUT = formatEditorShortcut('cmdOrCtrl+s')

export interface FileEditActionsProps {
  fileEdit: FileEditControls
  selectedPath: string | null
}

/**
 * A file is edited by clicking into it, so there is no mode to show: the bar
 * only speaks up once there is something unsaved — here, or in other files.
 * Undo and redo are ⌘Z and ⇧⌘Z in the editor itself.
 */
export function FileEditActions({ fileEdit, selectedPath }: FileEditActionsProps): React.JSX.Element | null {
  const unsaved = fileEdit.mode === 'edit' && (fileEdit.dirty || fileEdit.saving)
  const otherDrafts = fileEdit.unsavedPaths.some((path) => path !== selectedPath)
  // The box stays while the file is editable, empty, so the first keystroke
  // fills space the toolbar already gave it instead of pushing the title over.
  if (!unsaved && !otherDrafts && !fileEdit.available) return null
  return (
    <div className="file-edit-actions" role="group" aria-label="File editing" data-editable={fileEdit.available ? '' : undefined}>
      <UnsavedDraftsPill fileEdit={fileEdit} currentPath={selectedPath} />
      {unsaved ? (
        <>
          <span className="file-edit-state dirty" role="status">Unsaved</span>
          <div className="file-edit-tools">
            <button type="button" aria-label="Discard changes" data-tooltip="Discard changes · ⌘Z brings them back"
              disabled={!fileEdit.dirty || fileEdit.saving} onClick={fileEdit.onRevert}>
              <IconClockArrow />
            </button>
          </div>
          <button className="file-edit-save" type="button" onClick={fileEdit.onSave}
            aria-keyshortcuts="Meta+S Control+S"
            aria-label={`Save (${SAVE_SHORTCUT})`}
            disabled={!fileEdit.dirty || fileEdit.saving}>
            <span className="icon-swap" data-state={fileEdit.saving ? 'alt' : 'base'} aria-hidden="true">
              <IconCheck /><IconRefresh className="spin" />
            </span>
            {/* The spinner says "saving"; a label that grew to say it too pushed the
                whole bar sideways for the length of every save. */}
            <span className="file-edit-save-label" aria-hidden="true">Save</span>
            <kbd className="shortcut-hint" aria-hidden="true">{SAVE_SHORTCUT}</kbd>
          </button>
          <span className="diff-control-divider" aria-hidden="true" />
        </>
      ) : null}
    </div>
  )
}
