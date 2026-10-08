import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render, screen, within } from '@testing-library/react'

import type { DiffStyle, FileEditControls } from '../app/AppView'
import { DiffToolbar } from './DiffToolbar'
import { formatEditorShortcut } from '../editor/editorKeymap'

afterEach(cleanup)

function editControls(overrides: Partial<FileEditControls> = {}): FileEditControls {
  return {
    available: false,
    unavailableReason: 'Editing is unavailable for this file.',
    mode: 'read',
    documentView: 'split',
    dirty: false,
    saving: false,
    unsavedPaths: [],
    onStart: () => {},
    onDocumentViewChange: () => {},
    onRevert: () => {},
    onSave: () => {},
    onOpenPath: () => {},
    ...overrides
  }
}

test('DiffToolbar says why a file is read-only', () => {
  render(<DiffToolbar comparison={null} selectedPath="image.png" isGitRepository isFilePreview
    diffStyle="split" workspaceView="file" reviewFileCount={0} wordWrap={false} foldUnchanged
    fileEdit={editControls({ unavailableReason: 'Binary files cannot be edited.' })}
    onDiffStyleChange={() => {}} onWordWrapToggle={() => {}} onFoldUnchangedToggle={() => {}} />)

  const badge = screen.getByText('Read-only')
  expect(badge.getAttribute('title')).toBe('Binary files cannot be edited.')
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
})

describe('DiffToolbar editing controls', () => {
  const toolbar = (fileEdit: FileEditControls) => (
    <DiffToolbar comparison={null} selectedPath="src/app.ts" isGitRepository isFilePreview={false}
      diffStyle="split" workspaceView="file" reviewFileCount={1} wordWrap={false} foldUnchanged
      fileEdit={fileEdit}
      onDiffStyleChange={() => {}} onWordWrapToggle={() => {}} onFoldUnchangedToggle={() => {}} />
  )

  // Scoped to the container: other suites in the same run can leave their own
  // Save buttons in the shared document.
  test('an editable file shows no editing controls until something is unsaved', () => {
    const { container, rerender } = render(toolbar(editControls({ available: true })))
    const view = within(container)
    expect(view.queryByRole('button', { name: /Save/ })).toBeNull()
    rerender(toolbar(editControls({ available: true, mode: 'edit' })))
    expect(view.queryByRole('button', { name: /Save/ })).toBeNull()
    expect(view.queryByRole('status')).toBeNull()
    // The space Save will need is held from the start, so typing never moves the title.
    expect(view.getByRole('group', { name: 'File editing' }).hasAttribute('data-editable')).toBe(true)
  })

  test('unsaved changes bring Save and Discard', () => {
    let saved = false
    let reverted = false
    const { container } = render(toolbar(editControls({ available: true, mode: 'edit', dirty: true,
      onSave: () => { saved = true }, onRevert: () => { reverted = true } })))
    const view = within(container)
    const save = view.getByRole('button', { name: /Save/ }) as HTMLButtonElement
    expect(save.disabled).toBe(false)
    expect(save.textContent).toContain(formatEditorShortcut('cmdOrCtrl+s'))
    expect(view.getByRole('status').textContent).toBe('Unsaved')
    save.click()
    view.getByRole('button', { name: 'Discard changes' }).click()
    expect(saved).toBe(true)
    expect(reverted).toBe(true)
  })

  test('drafts in other files are offered from any file', () => {
    const opened: string[] = []
    render(toolbar(editControls({ unsavedPaths: ['src/other.ts'], onOpenPath: (path) => { opened.push(path) } })))
    screen.getByRole('button', { name: '1 unsaved' }).click()
    expect(opened).toEqual(['src/other.ts'])
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

  // Same control as the sidebar heading's, so it carries the same name in both
  // places and only aria-expanded says which way it goes.
  const toggle = screen.getByRole('button', { name: 'Toggle explorer' })
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  toggle.click()
  expect(shown).toBe(true)
})

// Split view is a toggle beside wrap and folding, pressed while the diff is split.
test('the diff layout control toggles split view', () => {
  const styles: DiffStyle[] = []
  render(<DiffToolbar comparison={null} selectedPath="src/app.ts" isGitRepository isFilePreview={false}
    diffStyle="split" workspaceView="multi" reviewFileCount={4} wordWrap={false} foldUnchanged
    fileEdit={editControls()} onDiffStyleChange={(style) => { styles.push(style) }}
    onWordWrapToggle={() => {}} onFoldUnchangedToggle={() => {}} />)

  const toggle = screen.getByRole('button', { name: 'Split view' })
  expect(toggle.getAttribute('aria-pressed')).toBe('true')

  toggle.click()
  expect(styles).toEqual(['unified'])
})
