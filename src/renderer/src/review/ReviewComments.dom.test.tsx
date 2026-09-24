import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { DraftComment, ReviewThreadCard, SelectionActions } from './ReviewComments'

afterEach(cleanup)

const range = { start: 12, end: 12, side: 'additions' as const }

test('selection actions are Copy, Chat, and Comment, as glyphs in that order', () => {
  const onCopy = mock(() => {})
  render(<SelectionActions range={range} onComment={() => {}} onAskAgent={() => {}} onCopy={onCopy} />)

  const toolbar = screen.getByRole('toolbar', { name: /Actions for Line 12/ })
  const buttons = [...toolbar.querySelectorAll('button')]
  expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
    'Copy selection with file path',
    'Add selection to Chat',
    'Comment'
  ])
  // Icon-only: the names live on aria-label and the tooltip, not in the strip.
  expect(toolbar.textContent).toBe('')

  fireEvent.click(screen.getByRole('button', { name: 'Copy selection with file path' }))
  expect(onCopy).toHaveBeenCalledTimes(1)
})

test('copying answers in the glyph, since an icon-only button has no label to change', () => {
  render(<SelectionActions range={range} onComment={() => {}} onAskAgent={() => {}} onCopy={() => {}} />)

  const copy = screen.getByRole('button', { name: 'Copy selection with file path' })
  expect(copy.getAttribute('data-tooltip')).toBe('Copy with path')
  fireEvent.click(copy)
  expect(copy.getAttribute('data-copied')).toBe('')
  expect(copy.getAttribute('data-tooltip')).toBe('Copied')
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

const thread = {
  id: 'thread-1', body: 'Keep this check.', lineNumber: 8,
  range, replies: [], resolved: false
}

test('edits a local thread through the same composer as a new comment', () => {
  const onEdit = mock(() => {})
  render(<ReviewThreadCard thread={thread}
    onCopy={() => {}} onDelete={() => {}} onEdit={onEdit} onReply={() => {}} onToggleResolved={() => {}}
  />)

  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  const field = screen.getByLabelText('Edit review comment')
  fireEvent.change(field, { target: { value: 'Rename this.' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(onEdit).toHaveBeenCalledWith('Rename this.')
})

test('offers Copy alongside the thread actions, and not while composing', () => {
  const onCopy = mock(() => {})
  render(<ReviewThreadCard thread={thread}
    onCopy={onCopy} onDelete={() => {}} onEdit={() => {}} onReply={() => {}} onToggleResolved={() => {}}
  />)

  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  expect(onCopy).toHaveBeenCalledTimes(1)

  fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
  expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull()
})
