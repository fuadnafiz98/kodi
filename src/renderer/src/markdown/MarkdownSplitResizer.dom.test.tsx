import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

import { MarkdownSplitResizer } from './MarkdownSplitResizer'

afterEach(cleanup)

function splitRect(): DOMRect {
  return {
    bottom: 800,
    height: 800,
    left: 0,
    right: 800,
    top: 0,
    width: 800,
    x: 0,
    y: 0,
    toJSON: () => ({})
  }
}

function renderSplit() {
  const { container } = render(
    <div className="markdown-split">
      <div className="markdown-split-source" />
      <MarkdownSplitResizer />
      <div className="markdown-file-scroll" />
    </div>
  )
  const split = container.querySelector('.markdown-split')
  const resizer = container.querySelector('.markdown-split-resizer')
  if (!(split instanceof HTMLDivElement) || !(resizer instanceof HTMLDivElement)) {
    throw new Error('Markdown split resizer did not render inside a split.')
  }
  return { split, resizer }
}

function capturePointer(resizer: HTMLDivElement): void {
  const captured = new Set<number>()
  resizer.setPointerCapture = (pointerId) => { captured.add(pointerId) }
  resizer.releasePointerCapture = (pointerId) => { captured.delete(pointerId) }
  resizer.hasPointerCapture = (pointerId) => captured.has(pointerId)
}

test('captures split bounds once on pointer-down and never on pointer-move', () => {
  const { split, resizer } = renderSplit()
  let boundReads = 0
  split.getBoundingClientRect = () => {
    boundReads += 1
    return splitRect()
  }
  capturePointer(resizer)

  act(() => {
    resizer.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 400,
      pointerId: 1
    }))
  })
  expect(boundReads).toBe(1)

  act(() => {
    for (let index = 0; index < 20; index += 1) {
      resizer.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 420 + index * 4,
        pointerId: 1
      }))
    }
  })
  expect(boundReads).toBe(1)
})

test('drags the source pane right and clamps at 75 percent', () => {
  const { split, resizer } = renderSplit()
  split.getBoundingClientRect = () => splitRect()
  capturePointer(resizer)

  act(() => {
    resizer.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 400,
      pointerId: 1
    }))
    resizer.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: 560,
      pointerId: 1
    }))
    resizer.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      pointerId: 1
    }))
  })

  const before = split.style.getPropertyValue('--markdown-split-before')
  expect(Number.parseFloat(before)).toBeGreaterThan(50)
  expect(Number.parseFloat(before)).toBeLessThanOrEqual(75)
  expect(split.style.getPropertyValue('--markdown-split-after')).toBe(`${100 - Number.parseFloat(before)}fr`)
})

test('double-click restores a balanced split', () => {
  const { split, resizer } = renderSplit()
  split.getBoundingClientRect = () => splitRect()
  capturePointer(resizer)

  act(() => {
    resizer.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 400,
      pointerId: 1
    }))
    resizer.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: 560,
      pointerId: 1
    }))
    resizer.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      pointerId: 1
    }))
  })
  act(() => {
    fireEvent.doubleClick(resizer)
  })

  expect(split.style.getPropertyValue('--markdown-split-before')).toBe('50fr')
  expect(split.style.getPropertyValue('--markdown-split-after')).toBe('50fr')
})

test('ArrowLeft decreases the announced split value', () => {
  renderSplit()
  const resizer = screen.getByRole('separator', { name: 'Resize source and preview' })
  expect(resizer.getAttribute('aria-valuenow')).toBe('50')

  act(() => {
    resizer.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      key: 'ArrowLeft'
    }))
  })

  expect(resizer.getAttribute('aria-valuenow')).toBe('48')
})
