import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { DraftComment, ReviewThreadCard, SelectionActions } from './ReviewComments'

afterEach(cleanup)

const range = { start: 12, end: 12, side: 'additions' as const }

test('selection actions are only Comment and Chat', () => {
  render(<SelectionActions range={range} onComment={() => {}} onAskAgent={() => {}} />)

  const toolbar = screen.getByRole('toolbar', { name: /Actions for Line 12/ })
  expect(screen.getByRole('button', { name: 'Comment' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Add selection to Chat' })).toBeTruthy()
  expect(toolbar.querySelectorAll('button')).toHaveLength(2)
  expect(toolbar.textContent).not.toContain('12 · new')
})

test('Escape on a comment draft is consumed so the git panel stays open', () => {
  const onCancel = mock(() => {})
  render(<DraftComment range={range} onCancel={onCancel} onSave={() => {}} />)

  const textarea = screen.getByLabelText('Review comment')
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  textarea.dispatchEvent(event)

  expect(event.defaultPrevented).toBe(true)
  expect(onCancel).toHaveBeenCalledTimes(1)
})

test('Escape cancels a draft even when the field is not focused', () => {
  const onCancel = mock(() => {})
  render(<DraftComment range={range} onCancel={onCancel} onSave={() => {}} />)

  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  window.dispatchEvent(event)

  expect(event.defaultPrevented).toBe(true)
  expect(onCancel).toHaveBeenCalledTimes(1)
})

test('keeps Send disabled until the draft has text', () => {
  render(<DraftComment range={range} onCancel={() => {}} onSave={() => {}} />)

  const send = screen.getByRole('button', { name: /Send comment/ }) as HTMLButtonElement
  expect(send.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Review comment'), { target: { value: 'Looks good.' } })
  expect(send.disabled).toBe(false)
})

test('Enter sends the comment and Shift+Enter stays in the field', () => {
  const onSave = mock(() => {})
  render(<DraftComment range={range} onCancel={() => {}} onSave={onSave} />)

  const textarea = screen.getByLabelText('Review comment')
  fireEvent.change(textarea, { target: { value: 'Please rename this.' } })

  fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
  expect(onSave).not.toHaveBeenCalled()

  fireEvent.keyDown(textarea, { key: 'Enter' })
  expect(onSave).toHaveBeenCalledTimes(1)
  expect(onSave).toHaveBeenCalledWith('Please rename this.')
})

test('edits a local thread through the same composer as a new comment', () => {
  const onEdit = mock(() => {})
  render(<ReviewThreadCard
    thread={{
      id: 'thread-1', body: 'Keep this check.', lineNumber: 8,
      range, replies: [], resolved: false
    }}
    onDelete={() => {}} onEdit={onEdit} onReply={() => {}} onToggleResolved={() => {}}
  />)

  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  const field = screen.getByLabelText('Edit review comment')
  fireEvent.change(field, { target: { value: 'Rename this.' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(onEdit).toHaveBeenCalledWith('Rename this.')
})
