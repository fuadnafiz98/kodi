import { describe, expect, test } from 'bun:test'

import type { ReviewMatch } from './reviewSearch'
import { rangeInRow, rangesForItem, rowForMatch } from './reviewSearchHighlights'

// Rows as the viewer draws them: token spans inside a numbered row. A unified
// diff numbers a deleted row by the old file; a split one draws each side in
// its own column.
function unifiedRoot(): ShadowRoot {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <pre data-diff-type="single"><code data-content>
      <div data-line="5" data-line-type="change-deletion"><span>old </span><span>needle</span></div>
      <div data-line="5" data-line-type="change-addition"><span>const </span><span>nee</span><span>dle = needle</span></div>
      <div data-line="6" data-line-type="context"><span>plain</span></div>
    </code></pre>`
  document.body.append(host)
  return root
}

function splitRoot(): ShadowRoot {
  const host = document.createElement('div')
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `
    <pre data-diff-type="split">
      <code data-deletions><div data-content><div data-line="5" data-line-type="change-deletion"><span>left needle</span></div></div></code>
      <code data-additions><div data-content><div data-line="5" data-line-type="change-addition"><span>right needle</span></div></div></code>
    </pre>`
  document.body.append(host)
  return root
}

const match = (side: ReviewMatch['side'], lineNumber: number, column: number): ReviewMatch =>
  ({ itemId: 'review:a.ts', side, lineNumber, column, length: 6 })

describe('rowForMatch', () => {
  test('tells a deleted row from an added one with the same number', () => {
    const root = unifiedRoot()
    expect(rowForMatch(root, match('deletions', 5, 4))?.textContent).toBe('old needle')
    expect(rowForMatch(root, match('additions', 5, 6))?.textContent).toBe('const needle = needle')
    expect(rowForMatch(root, match('additions', 9, 0))).toBeNull()
  })

  test('picks the column of its side in a split diff', () => {
    const root = splitRoot()
    expect(rowForMatch(root, match('deletions', 5, 5))?.textContent).toBe('left needle')
    expect(rowForMatch(root, match('additions', 5, 6))?.textContent).toBe('right needle')
  })
})

describe('rangeInRow', () => {
  test('spans token boundaries', () => {
    const row = rowForMatch(unifiedRoot(), match('additions', 5, 6))!
    expect(rangeInRow(row, 6, 6)?.toString()).toBe('needle')
    expect(rangeInRow(row, 15, 6)?.toString()).toBe('needle')
    expect(rangeInRow(row, 30, 6)).toBeNull()
  })
})

describe('rangesForItem', () => {
  test('marks every occurrence in drawn rows and singles out the active one', () => {
    const root = unifiedRoot()
    const matches = [match('deletions', 5, 4), match('additions', 5, 6), match('additions', 5, 15)]
    const painted = rangesForItem(root, matches, 'needle', match('additions', 5, 15))
    expect(painted.matches.map((range) => range.toString())).toEqual(['needle', 'needle'])
    expect(painted.active?.toString()).toBe('needle')
    expect(painted.active?.startOffset).toBe(6)
  })

  test('re-finds the text in the drawn row, smart-cased', () => {
    const root = unifiedRoot()
    const painted = rangesForItem(root, [match('additions', 5, 6)], 'NEEDLE', null)
    expect(painted.matches).toHaveLength(0)
    expect(rangesForItem(root, [match('additions', 5, 6)], 'needle', null).matches).toHaveLength(2)
  })
})
