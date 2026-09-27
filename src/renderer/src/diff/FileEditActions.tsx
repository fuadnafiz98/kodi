import {
  IconCheck,
  IconClockArrow,
  IconEye,
  IconRefresh,
  IconX
} from '@pierre/icons'

import type { FileEditControls } from '../app/AppView'
import { UnsavedDraftsPill } from '../review/UnsavedDraftsPill'
import { formatEditorShortcut } from '../editor/editorKeymap'
import { IconRedo, IconUndo } from './editIcons'

const UNDO_SHORTCUT = formatEditorShortcut('cmdOrCtrl+z')
const REDO_SHORTCUT = formatEditorShortcut('cmdOrCtrl+shift+z')
const SAVE_SHORTCUT = formatEditorShortcut('cmdOrCtrl+s')

export interface FileEditActionsProps {
  fileEdit: FileEditControls
  selectedPath: string | null
}

/**
 * Draft state, the draft tools, and Save. One primary action: every other
 * control is a quiet 24px icon with a tooltip, and Save only takes the accent
 * once there is something to save — a filled button that does nothing was the
 * loudest thing in the bar.
 */
export function FileEditActions({ fileEdit, selectedPath }: FileEditActionsProps): React.JSX.Element | null {
  if (!fileEdit.available || fileEdit.mode === 'read') return null
  const previewing = fileEdit.mode === 'preview'
  return (
    <div className="file-edit-actions" role="group" aria-label="File editing">
      <span className={`file-edit-state ${fileEdit.dirty ? 'dirty' : ''}`} role="status">
        {fileEdit.dirty ? 'Unsaved' : 'Saved'}
      </span>
      <UnsavedDraftsPill fileEdit={fileEdit} currentPath={selectedPath} />
      <div className="file-edit-tools" role="group" aria-label="Draft tools">
        <button type="button" aria-label={`Undo (${UNDO_SHORTCUT})`} data-tooltip={`Undo ${UNDO_SHORTCUT}`}
          disabled={!fileEdit.canUndo || fileEdit.saving} onClick={fileEdit.onUndo}>
          <IconUndo />
        </button>
        <button type="button" aria-label={`Redo (${REDO_SHORTCUT})`} data-tooltip={`Redo ${REDO_SHORTCUT}`}
          disabled={!fileEdit.canRedo || fileEdit.saving} onClick={fileEdit.onRedo}>
          <IconRedo />
        </button>
        <button type="button" aria-label="Preview draft" data-tooltip={previewing ? 'Back to editing' : 'Preview draft'}
          aria-pressed={previewing} className={previewing ? 'active' : undefined}
          onClick={() => fileEdit.onModeChange(previewing ? 'edit' : 'preview')} disabled={fileEdit.saving}>
          <IconEye />
        </button>
        <button type="button" aria-label="Discard changes" data-tooltip="Discard changes"
          title="Go back to the file on disk (undoable with ⌘Z)"
          disabled={!fileEdit.dirty || fileEdit.saving} onClick={fileEdit.onRevert}>
          <IconClockArrow />
        </button>
      </div>
      <button className="file-edit-save" type="button" onClick={fileEdit.onSave}
        data-dirty={fileEdit.dirty ? '' : undefined}
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
      <div className="file-edit-tools">
        <button className="file-edit-close" type="button" onClick={fileEdit.onCancel} disabled={fileEdit.saving}
          aria-label="Close editor" data-tooltip="Close editor · draft is kept">
          <IconX />
        </button>
      </div>
      <span className="diff-control-divider" aria-hidden="true" />
    </div>
  )
}
