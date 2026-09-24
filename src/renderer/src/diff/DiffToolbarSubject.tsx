import { IconArrowUpRight, IconFileCode } from '@pierre/icons'

import type { FileComparison } from '../../../shared/contracts'
import {
  diffToolbarComparisonLabel,
  diffToolbarDisplayName,
  formatStatus,
  type DiffToolbarSubject as ToolbarSubject
} from './diffToolbarModel'
import { ComparisonLabel } from './ComparisonRefs'
import { FilePathBreadcrumbs } from './FilePathBreadcrumbs'

export interface DiffToolbarSubjectProps {
  subject: ToolbarSubject
  comparison: FileComparison | null
  /** Where the open review lives on the web: shown as a link beside its title. */
  externalLink?: { href: string; label: string }
  children?: React.ReactNode
}

/** What is open, and what it is being compared against. */
export function DiffToolbarSubject({ subject, comparison, externalLink, children }: DiffToolbarSubjectProps): React.JSX.Element {
  const { selectedPath, isFilePreview, workspaceView } = subject
  const showStatusPill = workspaceView === 'file' && comparison != null && comparison.status !== 'unchanged'
  const comparisonLabel = diffToolbarComparisonLabel(subject)
  return (
    <div className="diff-toolbar-context">
      {isFilePreview && selectedPath != null ? (
        <FilePathBreadcrumbs path={selectedPath} />
      ) : (
        <div className="diff-file-title" title={selectedPath ?? undefined}>
          <IconFileCode />
          <span>{diffToolbarDisplayName(subject) ?? 'Select a file'}</span>
          {externalLink == null ? null : (
            // The main process routes https window-opens to the default browser.
            <a className="diff-title-link" href={externalLink.href} target="_blank" rel="noreferrer"
              aria-label={externalLink.label} title={externalLink.label}>
              <IconArrowUpRight aria-hidden="true" />
            </a>
          )}
          {showStatusPill ? (
            <span className={`status-pill status-${comparison.status}`}>{formatStatus(comparison.status)}</span>
          ) : null}
        </div>
      )}
      <span className="comparison-label" title={comparisonLabel}><ComparisonLabel label={comparisonLabel} /></span>
      {children}
    </div>
  )
}
