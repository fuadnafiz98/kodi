import { describe, expect, mock, test } from 'bun:test'

import type { SelectionActionContext } from './selectionAction'
import { createSelectionActionElement } from './selectionActionBar'

function context(close = mock(() => {})): SelectionActionContext {
  return {
    selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    getSelectionText: () => 'abc',
    close
  }
}

describe('createSelectionActionElement', () => {
  test('draws the review bar: icon buttons named by label, tooltip and accent', () => {
    const element = createSelectionActionElement([
      { label: 'Copy selection with file path', tooltip: 'Copy with path', icon: 'copy', run: () => {} },
      { label: 'Add selection to Chat', tooltip: 'Add to Chat ⌘I', icon: 'chat', run: () => {} },
      { label: 'Comment', icon: 'comment', primary: true, run: () => {} }
    ], context())

    // It brings its own styles into the shadow root it lands in.
    expect(element.querySelector('style')?.textContent).toContain('[data-selection-action-popover]')
    const buttons = [...element.querySelectorAll('button')]
    expect(buttons.map((button) => button.getAttribute('aria-label')))
      .toEqual(['Copy selection with file path', 'Add selection to Chat', 'Comment'])
    expect(buttons.map((button) => button.dataset.tooltip)).toEqual(['Copy with path', 'Add to Chat ⌘I', 'Comment'])
    // Icons, not words.
    for (const button of buttons) {
      expect(button.querySelector('svg')).not.toBeNull()
      expect(button.textContent?.trim()).toBe('')
      expect(button.querySelector('svg path[fill="black"]')).toBeNull()
    }
    expect(buttons.map((button) => button.hasAttribute('data-primary'))).toEqual([false, false, true])
  })

  test('a press keeps the editor selection, runs the action and closes the bar', () => {
    const run = mock(() => {})
    const close = mock(() => {})
    const element = createSelectionActionElement([{ label: 'Comment', icon: 'comment', run }], context(close))
    const button = element.querySelector('button')!

    const press = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    button.click()
    expect(run).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
  })
})
