import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { ReviewSummary, type ReviewSummaryEntry } from './ReviewSummary'

afterEach(cleanup)

const note = (id: string, path: string, orphaned = false): ReviewSummaryEntry => ({
  path,
  thread: {
    id, body: 'Keep this check.', lineNumber: 8,
    range: { start: 8, end: 8, side: 'additions' }, replies: [],
    resolved: false, orphaned
  }
})

const orphan = note('thread-1', 'src/app.ts', true)

function openNotes(): void {
  fireEvent.click(screen.getByRole('button', { name: /Review notes/ }))
}

test('keeps the notes list out of the document flow until opened', () => {
  render(<ReviewSummary entries={[orphan]} reattachingThreadId={null}
    onBeginReattach={() => {}} onCancelReattach={() => {}}
    onDrop={() => {}} onDropAll={() => {}} />)

  const list = document.getElementById('review-notes-list')
  expect(list?.hidden).toBe(true)
  expect(screen.getByRole('button', { name: /Review notes/ }).getAttribute('aria-expanded'))
    .toBe('false')
  expect(screen.queryByRole('button', { name: 'Reattach' })).toBeNull()
})

test('keeps an orphan visible and requires reattach', () => {
  const beginReattach = mock(() => {})
  render(<ReviewSummary entries={[orphan]} reattachingThreadId={null}
    onBeginReattach={beginReattach} onCancelReattach={() => {}}
    onDrop={() => {}} onDropAll={() => {}} />)

  openNotes()
  expect(screen.getByText('Orphaned')).toBeTruthy()
  expect(screen.getByText('The original lines no longer have one safe match.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Reattach' }))
  expect(beginReattach).toHaveBeenCalledWith(orphan)
})

test('shows selection guidance while an orphan is being reattached', () => {
  const cancel = mock(() => {})
  render(<ReviewSummary entries={[orphan]} reattachingThreadId="thread-1"
    onBeginReattach={() => {}} onCancelReattach={cancel}
    onDrop={() => {}} onDropAll={() => {}} />)

  openNotes()
  expect(screen.getByText('Select replacement lines in any file.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(cancel).toHaveBeenCalledTimes(1)
})

test('shows a compact range next to the file name', () => {
  render(<ReviewSummary entries={[orphan]} reattachingThreadId={null}
    onBeginReattach={() => {}} onCancelReattach={() => {}}
    onDrop={() => {}} onDropAll={() => {}} />)

  openNotes()
  expect(screen.getByText('8 · new')).toBeTruthy()
  expect(screen.queryByText('Line 8 · new')).toBeNull()
})

test('deletes one comment from its row', () => {
  const drop = mock(() => {})
  render(<ReviewSummary entries={[orphan]} reattachingThreadId={null}
    onBeginReattach={() => {}} onCancelReattach={() => {}}
    onDrop={drop} onDropAll={() => {}} />)

  openNotes()
  fireEvent.click(screen.getByRole('button', { name: 'Delete comment on app.ts' }))
  expect(drop).toHaveBeenCalledWith(orphan)
})

test('deletes a single note immediately from Delete all', () => {
  const dropAll = mock(() => {})
  render(<ReviewSummary entries={[orphan]} reattachingThreadId={null}
    onBeginReattach={() => {}} onCancelReattach={() => {}}
    onDrop={() => {}} onDropAll={dropAll} />)

  fireEvent.click(screen.getByRole('button', { name: 'Delete all' }))
  expect(dropAll).toHaveBeenCalledTimes(1)
})

test('asks once before deleting every note', () => {
  const dropAll = mock(() => {})
  render(<ReviewSummary
    entries={[orphan, note('thread-2', 'src/lib.ts')]}
    reattachingThreadId={null}
    onBeginReattach={() => {}} onCancelReattach={() => {}}
    onDrop={() => {}} onDropAll={dropAll} />)

  fireEvent.click(screen.getByRole('button', { name: 'Delete all' }))
  expect(dropAll).toHaveBeenCalledTimes(0)
  fireEvent.click(screen.getByRole('button', { name: 'Delete 2 notes' }))
  expect(dropAll).toHaveBeenCalledTimes(1)
})

test('Escape closes the notes overlay', () => {
  render(<ReviewSummary entries={[orphan]} reattachingThreadId={null}
    onBeginReattach={() => {}} onCancelReattach={() => {}}
    onDrop={() => {}} onDropAll={() => {}} />)

  openNotes()
  expect(document.getElementById('review-notes-list')?.hidden).toBe(false)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(document.getElementById('review-notes-list')?.hidden).toBe(true)
})
