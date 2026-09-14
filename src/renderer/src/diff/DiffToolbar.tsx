import { IconArrowLeftBar, IconSidebarLeftOpen } from '@pierre/icons'

import type { FileComparison } from '../../../shared/contracts'
import type { DiffStyle, FileEditControls, WorkspaceView } from '../app/AppView'
import { DiffDisplayControls } from './DiffDisplayControls'
import { diffToolbarLayout } from './diffToolbarModel'
import { DiffToolbarSubject } from './DiffToolbarSubject'
import { FileEditActions } from './FileEditActions'

interface DiffToolbarProps {
  comparison: FileComparison | null
  selectedPath: string | null
  isGitRepository: boolean
  isFilePreview: boolean
  diffStyle: DiffStyle
  workspaceView: WorkspaceView
  reviewFileCount: number
  reviewTitle?: string
  reviewComparison?: string
  wordWrap: boolean
  foldUnchanged: boolean
  fileEdit: FileEditControls
  onCloseExternalReview?(): void
  onDiffStyleChange(style: DiffStyle): void
  onWordWrapToggle(): void
  onFoldUnchangedToggle(): void
  sidebarVisible?: boolean
  onSidebarToggle?(): void
  sidebarShortcut?: string
}

export function DiffToolbar({
  comparison,
  selectedPath,
  isGitRepository,
  isFilePreview,
  diffStyle,
  workspaceView,
  reviewFileCount,
  reviewTitle,
  reviewComparison,
  wordWrap,
  foldUnchanged,
  fileEdit,
  onCloseExternalReview,
  onDiffStyleChange,
  onWordWrapToggle,
  onFoldUnchangedToggle,
  sidebarVisible = true,
  onSidebarToggle,
  sidebarShortcut
}: DiffToolbarProps): React.JSX.Element {
  const subject = {
    selectedPath,
    workspaceView,
    isFilePreview,
    isGitRepository,
    reviewTitle,
    reviewComparison,
    reviewFileCount
  }
  const layout = diffToolbarLayout(subject, fileEdit)

  return (
    <div className="diff-toolbar">
      {onSidebarToggle != null && !sidebarVisible ? (
        <button
          className="icon-button"
          type="button"
          aria-label="Show explorer"
          title={sidebarShortcut == null ? 'Show Explorer' : `Show Explorer (${sidebarShortcut})`}
          onClick={onSidebarToggle}
        >
          <IconSidebarLeftOpen />
        </button>
      ) : null}
      {/* Leaving a pull request belongs beside its title, not in the group of view
          toggles on the right where it read as another display mode. */}
      {onCloseExternalReview != null ? (
        <button className="review-exit-button" type="button" onClick={onCloseExternalReview}
          title="Close this review and go back to the working tree">
          <IconArrowLeftBar />Working tree
        </button>
      ) : null}
      <DiffToolbarSubject subject={subject} comparison={comparison} />
      <div className="diff-controls">
        <FileEditActions fileEdit={fileEdit} selectedPath={selectedPath} />
        <DiffDisplayControls
          fileEdit={fileEdit}
          workspaceView={workspaceView}
          diffStyle={diffStyle}
          wordWrap={wordWrap}
          foldUnchanged={foldUnchanged}
          showDiffLayout={layout.showDiffLayout}
          showEditStart={layout.showEditStart}
          showMarkdownViewToggle={layout.showMarkdownViewToggle}
          markdownPreviewOnly={layout.markdownPreviewOnly}
          onDiffStyleChange={onDiffStyleChange}
          onWordWrapToggle={onWordWrapToggle}
          onFoldUnchangedToggle={onFoldUnchangedToggle}
        />
      </div>
    </div>
  )
}
