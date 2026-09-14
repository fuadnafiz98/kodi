import {
  IconCheck,
  IconClockArrow,
  IconEye,
  IconPencil,
  IconRefresh,
  IconRepeat,
  IconX
} from '@pierre/icons'

import type { FileEditControls } from '../app/AppView'
import { UnsavedDraftsPill } from '../review/UnsavedDraftsPill'
import { formatEditorShortcut } from '../editor/editorKeymap'

const UNDO_SHORTCUT = formatEditorShortcut('cmdOrCtrl+z')
const REDO_SHORTCUT = formatEditorShortcut('cmdOrCtrl+shift+z')
const SAVE_SHORTCUT = formatEditorShortcut('cmdOrCtrl+s')

export interface FileEditActionsProps {
  fileEdit: FileEditControls
  selectedPath: string | null
}

/** Draft state, undo/redo, edit-or-preview, and the save cluster. */
export function FileEditActions({ fileEdit, selectedPath }: FileEditActionsProps): React.JSX.Element | null {
  if (!fileEdit.available || fileEdit.mode === 'read') return null
  return (
    <div className="file-edit-actions" role="group" aria-label="File editing">
      <span className={`file-edit-state ${fileEdit.dirty ? 'dirty' : ''}`} role="status">
        {fileEdit.dirty ? 'Unsaved' : 'Saved'}
      </span>
      <UnsavedDraftsPill fileEdit={fileEdit} currentPath={selectedPath} />
      <div className="editor-option-controls file-history-controls" role="group" aria-label="Edit history">
        <button type="button" aria-label={`Undo (${UNDO_SHORTCUT})`}
          title={`Undo (${UNDO_SHORTCUT})`}
          disabled={!fileEdit.canUndo || fileEdit.saving} onClick={fileEdit.onUndo}>
          <IconClockArrow />
        </button>
        <button type="button" aria-label={`Redo (${REDO_SHORTCUT})`}
          title={`Redo (${REDO_SHORTCUT})`}
          disabled={!fileEdit.canRedo || fileEdit.saving} onClick={fileEdit.onRedo}>
          <IconRepeat />
        </button>
      </div>
      <div className="segmented-control file-edit-mode" role="group" aria-label="Draft view">
        <button type="button" aria-pressed={fileEdit.mode === 'edit'}
          className={fileEdit.mode === 'edit' ? 'active' : undefined}
          title="Edit" onClick={() => fileEdit.onModeChange('edit')} disabled={fileEdit.saving}>
          <IconPencil /><span>Edit</span>
        </button>
        <button type="button" aria-pressed={fileEdit.mode === 'preview'}
          className={fileEdit.mode === 'preview' ? 'active' : undefined}
          title="Preview" onClick={() => fileEdit.onModeChange('preview')} disabled={fileEdit.saving}>
          <IconEye /><span>Preview</span>
        </button>
      </div>
      <button className="file-edit-cancel" type="button" onClick={fileEdit.onRevert}
        disabled={!fileEdit.dirty || fileEdit.saving}
        title="Discard this draft and go back to the file on disk (undoable with ⌘Z)">
        <IconClockArrow /><span>Revert</span>
      </button>
      <button className="file-edit-cancel" type="button" onClick={fileEdit.onCancel} disabled={fileEdit.saving}
        title="Leave edit mode. An unsaved draft is kept and can be resumed.">
        <IconX /><span>Close</span>
      </button>
      <button className="file-edit-save" type="button" onClick={fileEdit.onSave}
        aria-keyshortcuts="Meta+S Control+S"
        aria-label={`Save (${SAVE_SHORTCUT})`}
        title={`Save (${SAVE_SHORTCUT})`}
        disabled={!fileEdit.dirty || fileEdit.saving}>
        <span className="icon-swap" data-state={fileEdit.saving ? 'alt' : 'base'} aria-hidden="true">
          <IconCheck /><IconRefresh className="spin" />
        </span>
        <span className="file-edit-save-label" aria-hidden="true">{fileEdit.saving ? 'Saving' : 'Save'}</span>
        {fileEdit.saving ? null : (
          <kbd className="shortcut-hint" aria-hidden="true">{SAVE_SHORTCUT}</kbd>
        )}
      </button>
    </div>
  )
}
