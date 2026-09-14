import { useState } from 'react'
import type { Editor } from '@pierre/diffs/edit'

import type { ReviewAnnotationMetadata } from '../review/ReviewComments'
import type { DocumentView } from '../review/documentView'
import { EditorShortcutsSheet } from './EditorShortcutsSheet'
import { caretSelectionLabel, editorStatusLabel, type EditorStatusMode } from './editorStatus'
import { formatEditorShortcut } from './editorKeymap'
import { useCaretReadout } from './useCaretReadout'

interface EditorStatusBarProps {
  mode: EditorStatusMode
  documentView?: DocumentView
  dirty: boolean
  fileExtension?: string
  getEditor(): Editor<ReviewAnnotationMetadata> | null
}

export function EditorStatusBar({
  mode,
  documentView = 'source',
  dirty,
  fileExtension,
  getEditor
}: EditorStatusBarProps): React.JSX.Element {
  const editing = mode === 'edit'
  const caret = useCaretReadout(editing, getEditor)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const selection = editing ? caretSelectionLabel(caret) : null

  return (
    <footer className="editor-statusbar">
      <span>{editorStatusLabel(mode, documentView)}</span>
      {editing ? <span>{dirty ? 'Unsaved' : 'Saved'}</span> : null}
      {editing ? <span>Ln {caret.line}, Col {caret.column}</span> : null}
      {selection == null ? null : <span>{selection}</span>}
      <span>UTF-8</span>
      <span>LF</span>
      {fileExtension != null ? <span>{fileExtension}</span> : null}
      {editing ? (
        <>
          <span>{formatEditorShortcut('cmdOrCtrl+f')} find</span>
          <span>⌘S save</span>
          <button type="button" onClick={() => setShortcutsOpen(true)}>Shortcuts…</button>
        </>
      ) : null}
      <EditorShortcutsSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </footer>
  )
}
