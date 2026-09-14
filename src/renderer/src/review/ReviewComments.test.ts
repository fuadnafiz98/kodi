import { describe, expect, test } from 'bun:test'

import {
  consumeComposerEscape,
  consumeSelectionChromeKey,
  formatCompactSelectedRange,
  formatSelectedRange,
  nextPendingSelection
} from './ReviewComments'

describe('nextPendingSelection', () => {
  const live = { id: 'review:src/install.sh', range: { start: 81, end: 84, side: 'deletions' as const } }
  const pending = { id: 'review:src/install.sh', range: { start: 40, end: 42, side: 'deletions' as const } }

  test('hides the action bar when a new drag starts', () => {
    expect(nextPendingSelection('start', live, pending)).toBeNull()
  })

  test('leaves a committed bar alone while the range is still changing', () => {
    expect(nextPendingSelection('change', live, pending)).toBe(pending)
    expect(nextPendingSelection('change', live, null)).toBeNull()
  })

  test('shows the action bar only when the gesture ends', () => {
    expect(nextPendingSelection('end', live, null)).toBe(live)
    expect(nextPendingSelection('end', null, pending)).toBeNull()
  })
})

describe('review selection range labels', () => {
  test('keeps the full range for accessible context', () => {
    expect(formatSelectedRange({ start: 379, end: 378, side: 'deletions' }))
      .toBe('Lines 378–379 · old')
  })

  test('uses a compact visual range in the action bar', () => {
    expect(formatCompactSelectedRange({ start: 379, end: 378, side: 'deletions' }))
      .toBe('378–379 · old')
    expect(formatCompactSelectedRange({ start: 42, end: 42, side: 'additions' }))
      .toBe('42 · new')
  })
})

describe('consumeComposerEscape', () => {
  test('cancels when Escape is not in another field', () => {
    const cancelled: string[] = []
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    expect(consumeComposerEscape(event, {
      field: null,
      onCancel: () => cancelled.push('cancel')
    })).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(cancelled).toEqual(['cancel'])
  })

  test('leaves Escape alone when another text field is focused', () => {
    const field = document.createElement('textarea')
    const other = document.createElement('textarea')
    document.body.append(field, other)
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    Object.defineProperty(event, 'target', { value: other })
    expect(consumeComposerEscape(event, { field, onCancel: () => {} })).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    field.remove()
    other.remove()
  })
})

describe('consumeSelectionChromeKey', () => {
  test('Escape dismisses the selection and stops the event', () => {
    const dismissed: string[] = []
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    const consumed = consumeSelectionChromeKey(event, {
      onDismiss: () => dismissed.push('dismiss'),
      onAskAgent: () => dismissed.push('agent')
    })
    expect(consumed).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(dismissed).toEqual(['dismiss'])
  })

  test('⌘I asks the agent without dismissing', () => {
    const dismissed: string[] = []
    const event = new KeyboardEvent('keydown', { key: 'i', metaKey: true, cancelable: true })
    expect(consumeSelectionChromeKey(event, {
      onDismiss: () => dismissed.push('dismiss'),
      onAskAgent: () => dismissed.push('agent')
    })).toBe(true)
    expect(dismissed).toEqual(['agent'])
  })

  test('other keys leave the selection alone', () => {
    const event = new KeyboardEvent('keydown', { key: 'a', cancelable: true })
    expect(consumeSelectionChromeKey(event, { onDismiss: () => {}, onAskAgent: () => {} })).toBe(false)
    expect(event.defaultPrevented).toBe(false)
  })
})
