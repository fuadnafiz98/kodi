import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { GutterActions } from './GutterActions'

afterEach(cleanup)

function press(element: Element): { click: Event; pointerdown: PointerEvent } {
  const pointerdown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, composed: true })
  const click = new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true })
  element.dispatchEvent(pointerdown)
  element.dispatchEvent(click)
  return { click, pointerdown }
}

test('the gutter renders a single comment control that carries the utility attribute', () => {
  const onComment = mock(() => {})
  const { container } = render(<GutterActions onComment={onComment} />)

  const buttons = container.querySelectorAll('button')
  expect(buttons).toHaveLength(1)
  // The drag-to-select binding keys off this attribute in the composed path.
  expect(buttons[0]!.hasAttribute('data-utility-button')).toBe(true)

  press(screen.getByRole('button', { name: 'Comment on this line' }))
  expect(onComment).toHaveBeenCalledTimes(1)
})

test('a press landing on the icon still counts: svg targets are SVGElements', () => {
  const onComment = mock(() => {})
  render(<GutterActions onComment={onComment} />)

  const button = screen.getByRole('button', { name: 'Comment on this line' })
  const icon = button.querySelector('svg')
  expect(icon).not.toBeNull()
  expect(icon).not.toBeInstanceOf(HTMLElement)

  press(icon!)
  expect(onComment).toHaveBeenCalledTimes(1)
})

test('presses do not reach the viewer surface behind the button', () => {
  const onComment = mock(() => {})
  const seen: string[] = []
  render(
    <div
      ref={(node) => {
        for (const type of ['pointerdown', 'mousedown', 'click']) {
          node?.addEventListener(type, () => seen.push(type))
        }
      }}
    >
      <GutterActions onComment={onComment} />
    </div>
  )

  const button = screen.getByRole('button', { name: 'Comment on this line' })
  const { click } = press(button)
  button.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true }))

  // pointerdown and click are swallowed; mousedown is left alone so the press
  // still looks like a normal click to anything that only watches that.
  expect(seen).toEqual(['mousedown'])
  expect(click.defaultPrevented).toBe(true)
  expect(onComment).toHaveBeenCalledTimes(1)
})
