import { describe, expect, test } from 'bun:test'

import type { FileComparison } from '../../../shared/contracts'
import {
  markdownPreviewSource,
  markdownSource,
  markdownSurface,
  shouldShowMarkdownPreview,
  stripMarkdownFrontmatter
} from './documentView'

function comparison(overrides: Partial<FileComparison> = {}): FileComparison {
  return {
    path: 'docs/plan.md',
    mode: 'file',
    status: 'unchanged',
    oldFile: null,
    newFile: { name: 'docs/plan.md', contents: '# Hello\n', cacheKey: 'one' },
    binary: false,
    oversized: false,
    ...overrides
  }
}

describe('markdownSurface', () => {
  test('keeps source, preview, and split as requested', () => {
    expect(markdownSurface(comparison(), 'read', 'source')).toBe('source')
    expect(markdownSurface(comparison(), 'read', 'preview')).toBe('preview')
    expect(markdownSurface(comparison(), 'read', 'split')).toBe('split')
  })

  test('editing keeps the view, and opens preview-only beside its source', () => {
    expect(markdownSurface(comparison(), 'edit', 'split')).toBe('split')
    expect(markdownSurface(comparison(), 'edit', 'source')).toBe('source')
    expect(markdownSurface(comparison(), 'edit', 'preview')).toBe('split')
  })

  test('does not steal image, binary, or TypeScript surfaces', () => {
    expect(markdownSurface(comparison({ binary: true }), 'read', 'split')).toBe('source')
    expect(markdownSurface(comparison({ path: 'src/app.ts' }), 'read', 'split')).toBe('source')
  })
})

describe('shouldShowMarkdownPreview', () => {
  test('is true only for the preview-only surface', () => {
    expect(shouldShowMarkdownPreview(comparison(), 'read', 'preview')).toBe(true)
    expect(shouldShowMarkdownPreview(comparison(), 'read', 'split')).toBe(false)
    expect(shouldShowMarkdownPreview(comparison(), 'read', 'source')).toBe(false)
  })
})

describe('markdownSource', () => {
  test('prefers the working file and falls back to the old side', () => {
    expect(markdownSource(comparison())).toBe('# Hello\n')
    expect(markdownSource(comparison({
      newFile: null,
      oldFile: { name: 'docs/plan.md', contents: '# Gone\n', cacheKey: 'old' }
    }))).toBe('# Gone\n')
    expect(markdownSource(comparison({ newFile: null, oldFile: null }))).toBeNull()
  })
})

describe('stripMarkdownFrontmatter', () => {
  test('drops an opening YAML fence and keeps the title', () => {
    expect(stripMarkdownFrontmatter(
      '---\nname: add-dark-mode\ndescription: Add dark mode.\n---\n\n# Add Dark Mode\n'
    )).toBe('# Add Dark Mode\n')
  })

  test('leaves a file without a fence unchanged', () => {
    expect(stripMarkdownFrontmatter('# Add Dark Mode\n')).toBe('# Add Dark Mode\n')
  })

  test('leaves a later thematic break alone', () => {
    expect(stripMarkdownFrontmatter('# Title\n\n---\n\nAfter\n')).toBe('# Title\n\n---\n\nAfter\n')
  })

  test('accepts Windows newlines', () => {
    expect(stripMarkdownFrontmatter('---\r\nname: add-dark-mode\r\n---\r\n\r\n# Add Dark Mode\r\n'))
      .toBe('# Add Dark Mode\r\n')
  })

  test('returns an empty string when only a fence remains', () => {
    expect(stripMarkdownFrontmatter('---\nname: add-dark-mode\n---\n')).toBe('')
  })
})

describe('markdownPreviewSource', () => {
  test('strips frontmatter from the working file', () => {
    expect(markdownPreviewSource(comparison({
      newFile: {
        name: 'SKILL.md',
        contents: '---\nname: add-dark-mode\n---\n\n# Add Dark Mode\n',
        cacheKey: 'skill'
      }
    }))).toBe('# Add Dark Mode\n')
  })

  test('returns null when neither side has contents', () => {
    expect(markdownPreviewSource(comparison({ newFile: null, oldFile: null }))).toBeNull()
  })
})
