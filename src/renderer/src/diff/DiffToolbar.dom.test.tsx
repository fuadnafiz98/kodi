import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import type { FileEditControls } from '../app/AppView'
import { DiffToolbar } from './DiffToolbar'
import { formatEditorShortcut } from '../editor/editorKeymap'

afterEach(cleanup)

function editControls(overrides: Partial<FileEditControls> = {}): FileEditControls {
  return {
    available: false,
    unavailableReason: 'Editing is unavailable for this file.',
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

test('DiffToolbar explains why editing is unavailable', () => {
  render(<DiffToolbar comparison={null} selectedPath="image.png" isGitRepository isFilePreview
    diffStyle="split" workspaceView="file" reviewFileCount={0} wordWrap={false} foldUnchanged
    fileEdit={editControls({ unavailableReason: 'Binary files cannot be edited.' })}
    onDiffStyleChange={() => {}} onWordWrapToggle={() => {}} onFoldUnchangedToggle={() => {}} />)

  const button = screen.getByRole('button', { name: 'Edit' })
  expect((button as HTMLButtonElement).disabled).toBe(true)
  expect(button.getAttribute('title')).toBe('Binary files cannot be edited.')
})

describe('DiffToolbar editing controls', () => {
  test('keeps Save disabled until the draft is dirty', () => {
    render(<DiffToolbar comparison={null} selectedPath="src/app.ts" isGitRepository isFilePreview={false}
      diffStyle="split" workspaceView="file" reviewFileCount={1} wordWrap={false} foldUnchanged
      fileEdit={editControls({ available: true, mode: 'edit' })}
      onDiffStyleChange={() => {}} onWordWrapToggle={() => {}} onFoldUnchangedToggle={() => {}} />)

    const save = screen.getByRole('button', { name: /Save/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(save.textContent).toContain(formatEditorShortcut('cmdOrCtrl+s'))
    expect(screen.getByRole('button', { name: `Undo (${formatEditorShortcut('cmdOrCtrl+z')})` })).toBeTruthy()
    expect(screen.getByRole('button', { name: `Redo (${formatEditorShortcut('cmdOrCtrl+shift+z')})` })).toBeTruthy()
  })
})

test('DiffToolbar offers Source, Both, and Preview for a markdown file', () => {
  render(<DiffToolbar comparison={null} selectedPath="docs/plan.md" isGitRepository isFilePreview
    diffStyle="split" workspaceView="file" reviewFileCount={0} wordWrap={false} foldUnchanged
    fileEdit={editControls({ available: true, documentView: 'split' })}
    onDiffStyleChange={() => {}} onWordWrapToggle={() => {}} onFoldUnchangedToggle={() => {}} />)

  expect(screen.getByRole('button', { name: 'Both' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: 'Source' }).getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole('button', { name: 'Preview' }).getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole('group', { name: 'Markdown view' })).toBeTruthy()
  expect(screen.queryByText('Source')).toBeNull()
  expect(screen.getByRole('button', { name: 'Toggle word wrap' })).toBeTruthy()
})

test('DiffToolbar keeps the markdown view switch in preview-only', () => {
  render(<DiffToolbar comparison={null} selectedPath="docs/plan.md" isGitRepository isFilePreview
    diffStyle="split" workspaceView="file" reviewFileCount={0} wordWrap={false} foldUnchanged
    fileEdit={editControls({ available: true, documentView: 'preview' })}
    onDiffStyleChange={() => {}} onWordWrapToggle={() => {}} onFoldUnchangedToggle={() => {}} />)

  expect(screen.getByRole('group', { name: 'Markdown view' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Preview' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByRole('button', { name: 'Toggle word wrap' })).toBeNull()
})

test('DiffToolbar keeps TypeScript files on the source viewer', () => {
  render(<DiffToolbar comparison={null} selectedPath="src/app.ts" isGitRepository isFilePreview
    diffStyle="split" workspaceView="file" reviewFileCount={0} wordWrap={false} foldUnchanged
    fileEdit={editControls({ available: true })}
    onDiffStyleChange={() => {}} onWordWrapToggle={() => {}} onFoldUnchangedToggle={() => {}} />)

  expect(screen.queryByRole('group', { name: 'Markdown view' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Toggle word wrap' })).toBeTruthy()
})

test('DiffToolbar reveals the explorer when the sidebar is hidden', () => {
  let shown = false
  render(<DiffToolbar comparison={null} selectedPath="src/app.ts" isGitRepository isFilePreview={false}
    diffStyle="split" workspaceView="multi" reviewFileCount={4} wordWrap={false} foldUnchanged
    fileEdit={editControls()} sidebarVisible={false} onSidebarToggle={() => { shown = true }}
    sidebarShortcut="⌘B"
    onDiffStyleChange={() => {}} onWordWrapToggle={() => {}} onFoldUnchangedToggle={() => {}} />)

  screen.getByRole('button', { name: 'Show explorer' }).click()
  expect(shown).toBe(true)
})
