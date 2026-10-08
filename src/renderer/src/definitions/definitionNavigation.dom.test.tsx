import { afterEach, expect, mock, test } from 'bun:test'

import type { DefinitionCandidate } from '../../../shared/contracts'
import { createDefinitionNavigation, identifierAround } from './definitionNavigation'

const originalCaret = document.caretPositionFromPoint
const RangeClass = document.createRange().constructor as typeof Range
const originalRect = RangeClass.prototype.getBoundingClientRect
let disposers: Array<() => void> = []

afterEach(() => {
  Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: originalCaret })
  RangeClass.prototype.getBoundingClientRect = originalRect
  for (const dispose of disposers) dispose()
  disposers = []
  document.body.replaceChildren()
  delete (window as { repository?: unknown }).repository
})

test('identifierAround takes the whole word, and nothing on punctuation or a number', () => {
  const line = 'const x = parseFileUri(uri) + 42'
  expect(identifierAround(line, line.indexOf('File'))).toEqual({ start: 10, end: 22 })
  expect(identifierAround(line, line.indexOf('('))).toEqual({ start: 10, end: 22 })
  expect(identifierAround(line, line.indexOf('+') + 1)).toBeNull()
  expect(identifierAround(line, line.length - 1)).toBeNull()
  expect(identifierAround('a $el b', 3)).toEqual({ start: 2, end: 5 })
})

/** A review row: its tokens split over spans, as the highlighter draws them. */
function codeRow(): { host: HTMLElement; token: Text } {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = '<div data-title>src/app.ts</div><div data-content><div data-line-index="0"><span>const x = </span><span>parseFile</span><span>Uri(y)</span></div></div>'
  document.body.append(host)
  const spans = root.querySelectorAll('span')
  return { host, token: spans[1]!.firstChild as Text }
}

test('⌘-click on a token lists its definitions and a row opens the file there', async () => {
  const { token } = codeRow()
  Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: token, offset: 3 }) })
  RangeClass.prototype.getBoundingClientRect = () => ({ left: 100, right: 180, top: 20, bottom: 36, width: 80, height: 16, x: 100, y: 20 }) as DOMRect
  const candidates: DefinitionCandidate[] = [{ path: 'src/parse.ts', line: 3, kind: 'function', preview: 'export function parseFileUri(uri: string) {' }]
  const findDefinitions = mock(async () => candidates)
  ;(window as { repository?: unknown }).repository = { findDefinitions }
  const openFile = mock(() => {})
  disposers.push(createDefinitionNavigation(() => ({ openFile, openInEditor: () => {}, currentPath: () => null })).dispose)

  const press = new PointerEvent('pointerdown', { bubbles: true, composed: true, cancelable: true, metaKey: true, button: 0, clientX: 120, clientY: 28 })
  token.parentElement!.dispatchEvent(press)
  expect(press.defaultPrevented).toBe(true)
  expect(findDefinitions).toHaveBeenCalledWith('parseFileUri', 'src/app.ts')
  await Bun.sleep(0)
  const jump = document.querySelector<HTMLButtonElement>('.definition-popover [data-definition-jump]')
  expect(jump?.dataset.definitionJump).toBe('src/parse.ts:3')
  expect(document.activeElement).toBe(jump)
  jump!.click()
  expect(openFile).toHaveBeenCalledWith('src/parse.ts', 3)
  expect(document.querySelector('.definition-popover')).toBeNull()
})

test('a click without ⌘ is left to the viewer, and Escape closes the popover', async () => {
  const { token } = codeRow()
  Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: token, offset: 3 }) })
  RangeClass.prototype.getBoundingClientRect = () => ({ left: 100, right: 180, top: 20, bottom: 36, width: 80, height: 16, x: 100, y: 20 }) as DOMRect
  ;(window as { repository?: unknown }).repository = { findDefinitions: async () => [] }
  disposers.push(createDefinitionNavigation(() => ({ openFile: () => {}, openInEditor: () => {}, currentPath: () => null })).dispose)

  const plain = new PointerEvent('pointerdown', { bubbles: true, composed: true, cancelable: true, button: 0, clientX: 120, clientY: 28 })
  token.parentElement!.dispatchEvent(plain)
  expect(plain.defaultPrevented).toBe(false)
  expect(document.querySelector('.definition-popover')).toBeNull()

  token.parentElement!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true, cancelable: true, metaKey: true, button: 0, clientX: 120, clientY: 28 }))
  await Bun.sleep(0)
  expect(document.querySelector('.definition-popover-status')?.textContent).toBe('No definition of parseFileUri found.')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('.definition-popover')).toBeNull()
})
