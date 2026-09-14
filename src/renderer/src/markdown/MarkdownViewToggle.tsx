import { IconDiffSplit, IconEye, IconFileCode } from '@pierre/icons'

import type { DocumentView } from '../review/documentView'

export interface MarkdownViewToggleProps {
  documentView: DocumentView
  onDocumentViewChange(view: DocumentView): void
}

/** Source, both, or preview — only offered for a markdown file being read. */
export function MarkdownViewToggle({
  documentView,
  onDocumentViewChange
}: MarkdownViewToggleProps): React.JSX.Element {
  return (
    <div className="markdown-view-toggle" role="group" aria-label="Markdown view">
      <button type="button" aria-label="Source" data-tooltip="Source"
        aria-pressed={documentView === 'source'}
        className={documentView === 'source' ? 'active' : undefined}
        onClick={() => onDocumentViewChange('source')}>
        <IconFileCode />
      </button>
      <button type="button" aria-label="Both" data-tooltip="Source and preview"
        aria-pressed={documentView === 'split'}
        className={documentView === 'split' ? 'active' : undefined}
        onClick={() => onDocumentViewChange('split')}>
        <IconDiffSplit />
      </button>
      <button type="button" aria-label="Preview" data-tooltip="Preview"
        aria-pressed={documentView === 'preview'}
        className={documentView === 'preview' ? 'active' : undefined}
        onClick={() => onDocumentViewChange('preview')}>
        <IconEye />
      </button>
    </div>
  )
}
