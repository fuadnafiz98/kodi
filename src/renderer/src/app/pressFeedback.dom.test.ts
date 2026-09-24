import { afterEach, expect, test } from 'bun:test'

import { installPressFeedback, PRESS_ROW_MIN_WIDTH } from './pressFeedback'

let uninstall = (): void => {}

afterEach(() => {
  uninstall()
  document.body.innerHTML = ''
})

function buttonOfWidth(width: number): HTMLButtonElement {
  const button = document.createElement('button')
  button.innerHTML = '<span>label</span>'
  Object.defineProperty(button, 'offsetWidth', { configurable: true, get: () => width })
  document.body.append(button)
  return button
}

test('marks a row-wide button so its press tints instead of scaling', () => {
  uninstall = installPressFeedback()
  const row = buttonOfWidth(PRESS_ROW_MIN_WIDTH + 400)

  row.firstElementChild!.dispatchEvent(new Event('pointerdown', { bubbles: true }))

  expect(row.dataset.press).toBe('row')
})

test('leaves a compact button on the scale press', () => {
  uninstall = installPressFeedback()
  const icon = buttonOfWidth(28)

  icon.dispatchEvent(new Event('pointerdown', { bubbles: true }))

  expect(icon.dataset.press).toBeUndefined()
})

test('a keyboard press is measured too', () => {
  uninstall = installPressFeedback()
  const row = buttonOfWidth(PRESS_ROW_MIN_WIDTH)

  row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))

  expect(row.dataset.press).toBe('row')
})
