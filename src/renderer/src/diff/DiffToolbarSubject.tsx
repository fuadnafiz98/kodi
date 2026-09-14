import { IconFileCode } from '@pierre/icons'

import type { FileComparison } from '../../../shared/contracts'
import {
  diffToolbarComparisonLabel,
  diffToolbarDisplayName,
  formatStatus,
  type DiffToolbarSubject as ToolbarSubject
} from './diffToolbarModel'
import { FilePathBreadcrumbs } from './FilePathBreadcrumbs'

export interface DiffToolbarSubjectProps {
  subject: ToolbarSubject
  comparison: FileComparison | null
}

/** What is open, and what it is being compared against. */
export function DiffToolbarSubject({ subject, comparison }: DiffToolbarSubjectProps): React.JSX.Element {
  const { selectedPath, isFilePreview, workspaceView } = subject
  const showStatusPill = workspaceView === 'file' && comparison != null && comparison.status !== 'unchanged'
  return (
    <div className="diff-toolbar-context">
      {isFilePreview && selectedPath != null ? (
        <FilePathBreadcrumbs path={selectedPath} />
      ) : (
        <div className="diff-file-title" title={selectedPath ?? undefined}>
          <IconFileCode />
          <span>{diffToolbarDisplayName(subject) ?? 'Select a file'}</span>
          {showStatusPill ? (
            <span className={`status-pill status-${comparison.status}`}>{formatStatus(comparison.status)}</span>
          ) : null}
        </div>
      )}
      <span className="comparison-label">{diffToolbarComparisonLabel(subject)}</span>
    </div>
  )
}
