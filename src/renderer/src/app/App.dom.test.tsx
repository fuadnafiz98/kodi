import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { DraftComment } from '../review/ReviewComments'

afterEach(cleanup)

test('Escape on a comment draft is consumed so the git panel stays open', () => {
  const onCancel = mock(() => {})
  render(<DraftComment
    range={{ start: 1, end: 1, side: 'additions' }}
    onCancel={onCancel}
    onSave={() => {}}
  />)

  const textarea = screen.getByLabelText('Review comment')
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  textarea.dispatchEvent(event)

  expect(event.defaultPrevented).toBe(true)
  expect(onCancel).toHaveBeenCalledTimes(1)
})
