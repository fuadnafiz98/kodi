import { IconSidebarLeft } from '@pierre/icons'

import type { FileComparison } from '../../../shared/contracts'
import type { DiffStyle, FileEditControls, WorkspaceView } from '../app/AppView'
import { DiffDisplayControls } from './DiffDisplayControls'
import { diffToolbarLayout } from './diffToolbarModel'
import { DiffToolbarSubject } from './DiffToolbarSubject'
import { FileEditActions } from './FileEditActions'
import { ReviewGuideSwitch } from '../review/ReviewGuideSwitch'

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
  onDiffStyleChange(style: DiffStyle): void
  onWordWrapToggle(): void
  onFoldUnchangedToggle(): void
  sidebarVisible?: boolean
  onSidebarToggle?(): void
  sidebarShortcut?: string
  /** Beside the comparison: why a review is read-only, when it is. */
  reviewBadge?: React.ReactNode
  /** The open review's page on the web, linked beside its title. */
  reviewLink?: { href: string; label: string }
  /** Before the display controls: the review session's status and actions. */
  reviewActions?: React.ReactNode
  /** The review tab whose Diff | Guide switch this toolbar shows. */
  reviewWorldId?: string | null
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
  onDiffStyleChange,
  onWordWrapToggle,
  onFoldUnchangedToggle,
  sidebarVisible = true,
  onSidebarToggle,
  sidebarShortcut,
  reviewBadge,
  reviewLink,
  reviewActions,
  reviewWorldId
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
      {/* The same button the sidebar heading carries, so closing the panel moves
          the control rather than replacing it with a different one. */}
      {onSidebarToggle != null && !sidebarVisible ? (
        <button
          className="sidebar-toggle"
          type="button"
          aria-label="Toggle explorer"
          aria-expanded={false}
          aria-controls="repository-explorer"
          title={sidebarShortcut == null ? 'Show Explorer' : `Show Explorer (${sidebarShortcut})`}
          onClick={onSidebarToggle}
        >
          <IconSidebarLeft />
        </button>
      ) : null}
      <DiffToolbarSubject subject={subject} comparison={comparison} externalLink={reviewLink}>{reviewBadge}</DiffToolbarSubject>
      {reviewActions == null ? null : <div className="diff-review-actions">{reviewActions}</div>}
      <div className="diff-controls">
        {workspaceView === 'multi' && reviewWorldId != null && reviewFileCount > 0
          ? <ReviewGuideSwitch worldId={reviewWorldId} />
          : null}
        <FileEditActions fileEdit={fileEdit} selectedPath={selectedPath} />
        <DiffDisplayControls
          fileEdit={fileEdit}
          workspaceView={workspaceView}
          diffStyle={diffStyle}
          wordWrap={wordWrap}
          foldUnchanged={foldUnchanged}
          showDiffLayout={layout.showDiffLayout}
          showReadOnly={layout.showReadOnly}
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
