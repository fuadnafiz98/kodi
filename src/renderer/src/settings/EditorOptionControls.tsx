import { IconCollapsedRow, IconTypeWord } from '@pierre/icons'

import type { DocumentView } from '../review/documentView'
import { MarkdownViewToggle } from '../markdown/MarkdownViewToggle'

export interface EditorOptionControlsProps {
  documentView: DocumentView
  wordWrap: boolean
  foldUnchanged: boolean
  showMarkdownViewToggle: boolean
  /** A markdown preview has no source to wrap. */
  markdownPreviewOnly: boolean
  showDiffLayout: boolean
  onDocumentViewChange(view: DocumentView): void
  onWordWrapToggle(): void
  onFoldUnchangedToggle(): void
}

export function EditorOptionControls({
  documentView,
  wordWrap,
  foldUnchanged,
  showMarkdownViewToggle,
  markdownPreviewOnly,
  showDiffLayout,
  onDocumentViewChange,
  onWordWrapToggle,
  onFoldUnchangedToggle
}: EditorOptionControlsProps): React.JSX.Element {
  return (
    <div className="editor-option-controls" role="group" aria-label="Editor display options">
      {showMarkdownViewToggle ? (
        <MarkdownViewToggle documentView={documentView} onDocumentViewChange={onDocumentViewChange} />
      ) : null}
      {markdownPreviewOnly ? null : (
        <button type="button" aria-label="Toggle word wrap" aria-pressed={wordWrap}
          data-tooltip="Word wrap" className={wordWrap ? 'active' : undefined} onClick={onWordWrapToggle}>
          <IconTypeWord />
        </button>
      )}
      {showDiffLayout ? (
        <button type="button" aria-label="Toggle unchanged context folding" aria-pressed={foldUnchanged}
          data-tooltip="Context folding" className={foldUnchanged ? 'active' : undefined} onClick={onFoldUnchangedToggle}>
          <IconCollapsedRow />
        </button>
      ) : null}
    </div>
  )
}
