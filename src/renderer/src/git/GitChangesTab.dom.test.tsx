import { afterEach, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { RepositoryStatusEntry } from '../../../shared/contracts'
import { GitChangesTab, ROW_LIMIT, ROW_PAGE, type GitChangesTabProps } from './GitChangesTab'

afterEach(cleanup)

function props(overrides: Partial<GitChangesTabProps> = {}): GitChangesTabProps {
  return {
    root: '/repo',
    branch: 'main',
    statuses: [{ path: 'src/a.ts', status: 'modified' }],
    lastCommitSubject: 'Initial',
    committing: false,
    blocked: false,
    onConfirmStage: async () => true,
    onStage: async () => true,
    onUnstage: async () => true,
    onDiscard: async () => true,
    onCommit: async () => true,
    onOpenFile: () => {},
    ...overrides
  }
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement
}

test('row actions and their keys do nothing while a commit holds the index', () => {
  const onStage = mock(async () => true)
  const onDiscard = mock(async () => true)
  const onConfirmStage = mock(async () => true)
  const onOpenFile = mock(() => {})
  render(<GitChangesTab {...props({ committing: true, onStage, onDiscard, onConfirmStage, onOpenFile })} />)

  const stage = button('Stage src/a.ts')
  const discard = button('Discard changes to src/a.ts')
  expect(stage.disabled).toBe(true)
  expect(discard.disabled).toBe(true)
  expect(button('Discard all changes').disabled).toBe(true)
  expect((screen.getByTitle('Stage every change, new files included') as HTMLButtonElement).disabled).toBe(true)

  const row = screen.getByTitle('src/a.ts')
  fireEvent.keyDown(row, { key: ' ' })
  fireEvent.keyDown(row, { key: 'Backspace' })

  expect(onConfirmStage).not.toHaveBeenCalled()
  expect(onStage).not.toHaveBeenCalled()
  expect(onDiscard).not.toHaveBeenCalled()
  expect(onOpenFile).not.toHaveBeenCalled()
})

test('another action holding HEAD locks the rows too, and they come back after', async () => {
  const onConfirmStage = mock(async () => true)
  const { rerender } = render(<GitChangesTab {...props({ blocked: true, onConfirmStage })} />)
  expect(button('Stage src/a.ts').disabled).toBe(true)

  rerender(<GitChangesTab {...props({ onConfirmStage })} />)
  expect(button('Stage src/a.ts').disabled).toBe(false)
  await act(async () => { fireEvent.keyDown(screen.getByTitle('src/a.ts'), { key: ' ' }) })
  expect(onConfirmStage).toHaveBeenCalledWith(['src/a.ts'])
})

test('Show more reveals one page at a time and keeps counting what is left', () => {
  const total = ROW_LIMIT + ROW_PAGE + 100
  const statuses: RepositoryStatusEntry[] = Array.from({ length: total }, (_, index) => ({
    path: `build/file-${index}.js`,
    status: 'untracked'
  }))
  render(<GitChangesTab {...props({ statuses })} />)
  const rows = (): number => document.querySelectorAll('#scm-unstaged .scm-row').length

  expect(rows()).toBe(ROW_LIMIT)
  fireEvent.click(button(`Show ${ROW_PAGE} more of ${(total - ROW_LIMIT).toLocaleString()}`))
  expect(rows()).toBe(ROW_LIMIT + ROW_PAGE)
  fireEvent.click(button('Show 100 more'))
  expect(rows()).toBe(total)
  expect(document.querySelector('.scm-more')).toBeNull()
})

test('a draft typed for one repository does not follow the panel to another', () => {
  const { rerender } = render(<GitChangesTab {...props({ root: '/repo-a' })} />)
  const message = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Commit message' }) as HTMLTextAreaElement
  fireEvent.change(message(), { target: { value: 'Fix the thing in A' } })
  expect(message().value).toBe('Fix the thing in A')

  rerender(<GitChangesTab {...props({ root: '/repo-b' })} />)
  expect(message().value).toBe('')

  rerender(<GitChangesTab {...props({ root: '/repo-a' })} />)
  expect(message().value).toBe('Fix the thing in A')
})

test('an intent-to-add file counts as deleted in the discard confirmation', () => {
  const onDiscard = mock(async () => true)
  render(<GitChangesTab {...props({
    statuses: [{ path: 'new.ts', previousPath: 'old.ts', status: 'renamed' }, { path: 'fresh.ts', status: 'added' }],
    onDiscard
  })} />)

  fireEvent.click(button('Discard changes to new.ts'))
  fireEvent.click(button('Discard changes to fresh.ts'))

  // Main deletes both: neither has anything staged to go back to.
  expect(onDiscard.mock.calls as unknown[]).toEqual([[['new.ts'], 1], [['fresh.ts'], 1]])
})
