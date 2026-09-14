import { afterEach, describe, expect, test } from 'bun:test'

import { syncReviewCaretLifecycle } from './reviewCaret'

const originalCaretPositionFromPoint = document.caretPositionFromPoint
const originalCreateRange = document.createRange.bind(document)

afterEach(() => {
  Object.defineProperty(document, 'caretPositionFromPoint', {
    configurable: true,
    value: originalCaretPositionFromPoint
  })
  Object.defineProperty(document, 'createRange', {
    configurable: true,
    value: originalCreateRange
  })
})

describe('review caret lifecycle', () => {
  test('places one caret at a clicked code position and removes it on scroll', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const content = document.createElement('div')
    content.dataset.content = ''
    const line = document.createElement('div')
    line.dataset.lineIndex = '0'
    const text = document.createTextNode('const value = 1')
    line.append(text)
    content.append(line)
    root.append(content)
    Object.defineProperty(line, 'getBoundingClientRect', {
      value: () => ({ left: 20, top: 8, width: 300, height: 18 } as DOMRect)
    })

    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: text, offset: 6 })
    })
    const rangeBounds = { x: 44, y: 20, width: 0, height: 18 } as DOMRect
    Object.defineProperty(document, 'createRange', {
      configurable: true,
      value: () => {
        const range = originalCreateRange()
        Object.defineProperty(range, 'getBoundingClientRect', { value: () => rangeBounds })
        return range
      }
    })

    syncReviewCaretLifecycle(host, 'mount')
    line.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true, clientX: 44, clientY: 20 }))
    const caret = root.querySelector<HTMLElement>('[data-review-caret]')
    expect(caret?.parentElement).toBe(line)
    expect(caret?.style.left).toBe('24px')
    expect(caret?.style.top).toBe('12px')
    expect(caret?.style.height).toBe('18px')

    window.dispatchEvent(new Event('scroll'))
    expect(root.querySelector('[data-review-caret]')).toBeNull()

    syncReviewCaretLifecycle(host, 'unmount')
  })

  test('ignores gutter clicks', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const gutter = document.createElement('div')
    gutter.dataset.gutter = ''
    const line = document.createElement('div')
    line.dataset.lineIndex = '0'
    gutter.append(line)
    root.append(gutter)

    syncReviewCaretLifecycle(host, 'mount')
    line.click()
    expect(root.querySelector('[data-review-caret]')).toBeNull()
    syncReviewCaretLifecycle(host, 'unmount')
  })

  test('ignores collapsed-context separators', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const content = document.createElement('div')
    content.dataset.content = ''
    const line = document.createElement('div')
    line.dataset.lineIndex = '0'
    const separator = document.createElement('div')
    separator.dataset.separator = 'line-info-basic'
    separator.textContent = '2 unmodified lines'
    line.append(separator)
    content.append(line)
    root.append(content)

    syncReviewCaretLifecycle(host, 'mount')
    separator.click()
    expect(root.querySelector('[data-review-caret]')).toBeNull()
    syncReviewCaretLifecycle(host, 'unmount')
  })

  test('removes a caret when the diff rerenders', () => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const content = document.createElement('div')
    content.dataset.content = ''
    const line = document.createElement('div')
    line.dataset.lineIndex = '0'
    const text = document.createTextNode('value')
    line.append(text)
    content.append(line)
    root.append(content)

    Object.defineProperty(document, 'caretPositionFromPoint', {
      configurable: true,
      value: () => ({ offsetNode: text, offset: 2 })
    })
    Object.defineProperty(document, 'createRange', {
      configurable: true,
      value: () => {
        const range = originalCreateRange()
        Object.defineProperty(range, 'getBoundingClientRect', {
          value: () => ({ x: 20, y: 20, width: 0, height: 18 } as DOMRect)
        })
        return range
      }
    })

    syncReviewCaretLifecycle(host, 'mount')
    line.click()
    expect(root.querySelector('[data-review-caret]')).not.toBeNull()
    syncReviewCaretLifecycle(host, 'update')
    expect(root.querySelector('[data-review-caret]')).toBeNull()
    syncReviewCaretLifecycle(host, 'unmount')
  })
})
