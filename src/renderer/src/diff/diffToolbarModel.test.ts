import { describe, expect, test } from 'bun:test'

import type { FileEditControls, WorkspaceView } from '../app/AppView'
import {
  diffToolbarComparisonLabel,
  diffToolbarDisplayName,
  diffToolbarLayout,
  formatStatus,
  type DiffToolbarSubject
} from './diffToolbarModel'

function subject(overrides: Partial<DiffToolbarSubject> = {}): DiffToolbarSubject {
  return {
    selectedPath: 'src/renderer/App.tsx',
    workspaceView: 'file' as WorkspaceView,
    isFilePreview: false,
    isGitRepository: true,
    reviewFileCount: 0,
    ...overrides
  }
}

function fileEdit(overrides: Partial<FileEditControls> = {}): FileEditControls {
  return {
    available: false,
    unavailableReason: null,
    startLabel: 'Edit',
    mode: 'read',
    documentView: 'split',
    dirty: false,
    saving: false,
    canUndo: false,
    canRedo: false,
    unsavedPaths: [],
    onStart: () => {},
    onModeChange: () => {},
    onDocumentViewChange: () => {},
    onUndo: () => {},
    onRedo: () => {},
    onCancel: () => {},
    onRevert: () => {},
    onSave: () => {},
    onOpenPath: () => {},
    ...overrides
  }
}

describe('diffToolbarDisplayName', () => {
  test('a review shows its title, falling back to a generic one', () => {
    expect(diffToolbarDisplayName(subject({ workspaceView: 'multi', reviewTitle: '#7 Speed' }))).toBe('#7 Speed')
    expect(diffToolbarDisplayName(subject({ workspaceView: 'multi' }))).toBe('Repository review')
  })

  test('a preview shows the file name, the diff shows the full path', () => {
    expect(diffToolbarDisplayName(subject({ isFilePreview: true }))).toBe('App.tsx')
    expect(diffToolbarDisplayName(subject())).toBe('src/renderer/App.tsx')
    expect(diffToolbarDisplayName(subject({ selectedPath: null }))).toBeUndefined()
  })
})

describe('diffToolbarComparisonLabel', () => {
  test('a review counts files when it has no ref pair', () => {
    expect(diffToolbarComparisonLabel(subject({ workspaceView: 'multi', reviewComparison: 'main → perf' })))
      .toBe('main → perf')
    expect(diffToolbarComparisonLabel(subject({ workspaceView: 'multi', reviewFileCount: 4 })))
      .toBe('4 changed files')
    expect(diffToolbarComparisonLabel(subject({ workspaceView: 'multi', reviewFileCount: 4, isGitRepository: false })))
      .toBe('4 project files')
  })

  test('the file view names the two sides, or says it is read only', () => {
    expect(diffToolbarComparisonLabel(subject())).toBe('HEAD → Working Tree')
    expect(diffToolbarComparisonLabel(subject({ isGitRepository: false }))).toBe('Read-only preview')
  })
})

describe('diffToolbarLayout', () => {
  test('split/unified needs a git repository and something other than a preview', () => {
    expect(diffToolbarLayout(subject(), fileEdit()).showDiffLayout).toBe(true)
    expect(diffToolbarLayout(subject({ isFilePreview: true }), fileEdit()).showDiffLayout).toBe(false)
    expect(diffToolbarLayout(subject({ isFilePreview: true, workspaceView: 'multi' }), fileEdit()).showDiffLayout).toBe(true)
    expect(diffToolbarLayout(subject({ isGitRepository: false }), fileEdit()).showDiffLayout).toBe(false)
  })

  test('the edit entry shows when editing is offered or explained', () => {
    expect(diffToolbarLayout(subject(), fileEdit({ available: true })).showEditStart).toBe(true)
    expect(diffToolbarLayout(subject(), fileEdit({ unavailableReason: 'Binary file' })).showEditStart).toBe(true)
    expect(diffToolbarLayout(subject({ workspaceView: 'multi' }), fileEdit({ unavailableReason: 'Binary file' })).showEditStart).toBe(false)
    expect(diffToolbarLayout(subject(), fileEdit()).showEditStart).toBe(false)
  })

  test('the markdown toggles only apply to a markdown file in the file view', () => {
    const markdown = subject({ selectedPath: 'docs/plan.md' })
    expect(diffToolbarLayout(markdown, fileEdit({ available: true })).showMarkdownViewToggle).toBe(true)
    expect(diffToolbarLayout(subject(), fileEdit({ available: true })).showMarkdownViewToggle).toBe(false)
    expect(diffToolbarLayout(markdown, fileEdit({ available: true, mode: 'edit' })).showMarkdownViewToggle).toBe(false)
  })

  test('preview-only hides the source-side controls', () => {
    const markdown = subject({ selectedPath: 'docs/plan.md' })
    expect(diffToolbarLayout(markdown, fileEdit({ available: true, documentView: 'preview' })).markdownPreviewOnly).toBe(true)
    expect(diffToolbarLayout(markdown, fileEdit({ available: true, mode: 'preview' })).markdownPreviewOnly).toBe(true)
    expect(diffToolbarLayout(markdown, fileEdit({ available: true })).markdownPreviewOnly).toBe(false)
  })
})

describe('formatStatus', () => {
  test('names each status and falls back for an unchanged file', () => {
    expect(formatStatus('added')).toBe('Added')
    expect(formatStatus('renamed')).toBe('Renamed')
    expect(formatStatus('unchanged')).toBe('No changes')
  })
})
