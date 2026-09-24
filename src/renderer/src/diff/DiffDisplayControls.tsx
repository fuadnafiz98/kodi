import type { DiffStyle, FileEditControls, WorkspaceView } from '../app/AppView'
import { EditorOptionControls } from '../settings/EditorOptionControls'
import { FileEditStartButton } from './FileEditStartButton'

export interface DiffDisplayControlsProps {
  fileEdit: FileEditControls
  workspaceView: WorkspaceView
  diffStyle: DiffStyle
  wordWrap: boolean
  foldUnchanged: boolean
  /** Split/unified only makes sense for a git diff that is not a plain preview. */
  showDiffLayout: boolean
  showEditStart: boolean
  showMarkdownViewToggle: boolean
  markdownPreviewOnly: boolean
  onDiffStyleChange(style: DiffStyle): void
  onWordWrapToggle(): void
  onFoldUnchangedToggle(): void
}

/** Everything on the right of the toolbar: edit entry and the view toggles. */
export function DiffDisplayControls({
  fileEdit,
  workspaceView,
  diffStyle,
  wordWrap,
  foldUnchanged,
  showDiffLayout,
  showEditStart,
  showMarkdownViewToggle,
  markdownPreviewOnly,
  onDiffStyleChange,
  onWordWrapToggle,
  onFoldUnchangedToggle
}: DiffDisplayControlsProps): React.JSX.Element {
  const showOptions = showMarkdownViewToggle || !markdownPreviewOnly || showDiffLayout
  return (
    <div className="diff-display-controls">
      <FileEditStartButton fileEdit={fileEdit} workspaceView={workspaceView} />
      {showEditStart && showOptions ? <span className="diff-control-divider" aria-hidden="true" /> : null}
      {showOptions ? (
        <EditorOptionControls
          documentView={fileEdit.documentView}
          diffStyle={diffStyle}
          wordWrap={wordWrap}
          foldUnchanged={foldUnchanged}
          showMarkdownViewToggle={showMarkdownViewToggle}
          markdownPreviewOnly={markdownPreviewOnly}
          showDiffLayout={showDiffLayout}
          onDocumentViewChange={fileEdit.onDocumentViewChange}
          onDiffStyleChange={onDiffStyleChange}
          onWordWrapToggle={onWordWrapToggle}
          onFoldUnchangedToggle={onFoldUnchangedToggle}
        />
      ) : null}
    </div>
  )
}
