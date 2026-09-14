import type { FileComparison } from '../../../shared/contracts'
import { isMarkdownPath } from '../../../shared/markdownPreview'

export type DocumentView = 'source' | 'split' | 'preview'

export function markdownSource(comparison: FileComparison): string | null {
  return comparison.newFile?.contents ?? comparison.oldFile?.contents ?? null
}

const YAML_FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n)*/

export function stripMarkdownFrontmatter(source: string): string {
  return source.replace(YAML_FRONTMATTER, '')
}

export function markdownPreviewSource(comparison: FileComparison): string | null {
  const raw = markdownSource(comparison)
  return raw == null ? null : stripMarkdownFrontmatter(raw)
}

export function canRenderMarkdown(comparison: FileComparison): boolean {
  return !comparison.binary
    && !comparison.oversized
    && isMarkdownPath(comparison.path)
    && markdownSource(comparison) != null
}

export function markdownSurface(
  comparison: FileComparison,
  editMode: 'read' | 'edit' | 'preview',
  documentView: DocumentView
): DocumentView {
  if (!canRenderMarkdown(comparison) || editMode === 'edit') return 'source'
  if (editMode === 'preview') return 'preview'
  return documentView
}

export function shouldShowMarkdownPreview(
  comparison: FileComparison,
  editMode: 'read' | 'edit' | 'preview',
  documentView: DocumentView
): boolean {
  return markdownSurface(comparison, editMode, documentView) === 'preview'
}
