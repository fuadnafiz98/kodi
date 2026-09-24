import { IconCollapsedRow, IconTypeWord } from '@pierre/icons'

import type { DiffStyle } from '../app/AppView'
import type { DocumentView } from '../review/documentView'
import { DiffLayoutToggle } from '../diff/DiffLayoutToggle'
import { MarkdownViewToggle } from '../markdown/MarkdownViewToggle'

export interface EditorOptionControlsProps {
  documentView: DocumentView
  diffStyle: DiffStyle
  wordWrap: boolean
  foldUnchanged: boolean
  showMarkdownViewToggle: boolean
  /** A markdown preview has no source to wrap. */
  markdownPreviewOnly: boolean
  showDiffLayout: boolean
  onDocumentViewChange(view: DocumentView): void
  onDiffStyleChange(style: DiffStyle): void
  onWordWrapToggle(): void
  onFoldUnchangedToggle(): void
}

export function EditorOptionControls({
  documentView,
  diffStyle,
  wordWrap,
  foldUnchanged,
  showMarkdownViewToggle,
  markdownPreviewOnly,
  showDiffLayout,
  onDocumentViewChange,
  onDiffStyleChange,
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
      {/* Split/unified lives with the other view switches rather than behind its
          own divider: one 24px button alone behind a hairline is an orphan. */}
      {showDiffLayout ? (
        <DiffLayoutToggle diffStyle={diffStyle} onDiffStyleChange={onDiffStyleChange} />
      ) : null}
    </div>
  )
}
