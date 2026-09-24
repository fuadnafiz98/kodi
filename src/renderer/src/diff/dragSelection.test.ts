import { describe, expect, test } from 'bun:test'

import {
  codeFromEventPath,
  DRAG_SELECTION_CSS,
  findClosestDragLine,
  measureDragLines,
  type DragLineGeometry
} from './dragSelection'

const lines: DragLineGeometry[] = [
  { index: 10, lineNumber: 100, lineSide: 'additions', top: 0, bottom: 20 },
  { index: 11, lineNumber: 101, lineSide: 'additions', top: 20, bottom: 60 },
  { index: 14, lineNumber: 104, lineSide: 'additions', top: 60, bottom: 80 }
]

function codeWithGutterCells(
  attributes: Record<string, string>,
  cells: Array<{ index: number; number: number; type: string }>
): HTMLElement {
  const code = document.createElement('code')
  code.setAttribute('data-code', '')
  for (const [name, value] of Object.entries(attributes)) code.setAttribute(name, value)
  const gutter = document.createElement('div')
  gutter.setAttribute('data-gutter', '')
  code.append(gutter)
  for (const cell of cells) {
    const element = document.createElement('div')
    element.setAttribute('data-column-number', String(cell.number))
    element.setAttribute('data-line-index', String(cell.index))
    element.setAttribute('data-line-type', cell.type)
    gutter.append(element)
  }
  return code
}

describe('findClosestDragLine', () => {
  test('finds the nearest line center with a binary search', () => {
    expect(findClosestDragLine(lines, 4)).toMatchObject({ index: 10, lineNumber: 100 })
    expect(findClosestDragLine(lines, 35)).toMatchObject({ index: 11, lineNumber: 101 })
    expect(findClosestDragLine(lines, 76)).toMatchObject({ index: 14, lineNumber: 104 })
  })

  test('clamps outside the measured range and handles an empty cache', () => {
    expect(findClosestDragLine(lines, -100)?.index).toBe(10)
    expect(findClosestDragLine(lines, 500)?.index).toBe(14)
    expect(findClosestDragLine([], 10)).toBeNull()
  })
})

describe('DRAG_SELECTION_CSS', () => {
  test('keeps a continuous gutter rail and does not paint over the diff mix', () => {
    expect(DRAG_SELECTION_CSS).toContain('[data-selected-line]::after')
    expect(DRAG_SELECTION_CSS).not.toContain('top: 50%')
    expect(DRAG_SELECTION_CSS).not.toContain('bottom: 50%')
    expect(DRAG_SELECTION_CSS).not.toContain('background: color-mix(in srgb, var(--accent) 16%, transparent) !important')
  })

  test('leaves utility-slot geometry to the viewer lane rules', () => {
    expect(DRAG_SELECTION_CSS).not.toContain('data-gutter-utility-slot')
  })
})

describe('codeFromEventPath', () => {
  test('finds the code column for a slotted button whose closest() cannot cross the shadow boundary', () => {
    const code = document.createElement('code')
    code.setAttribute('data-code', '')
    code.setAttribute('data-additions', '')
    const host = document.createElement('div')
    const button = document.createElement('button')
    // The slotted button's composed path: button -> host -> ... -> code column.
    expect(codeFromEventPath([button, host, code, document.body])).toBe(code)
    expect(button.closest('[data-code]')).toBeNull()
  })

  test('resolves a unified column that carries no side attribute', () => {
    const code = codeWithGutterCells({ 'data-unified': '' }, [])
    const button = document.createElement('button')
    expect(codeFromEventPath([button, code, document.body])).toBe(code)
  })

  test('returns null when the press is not inside a code column', () => {
    const button = document.createElement('button')
    expect(codeFromEventPath([button, document.body])).toBeNull()
  })
})

describe('measureDragLines', () => {
  test('maps unified line types to sides the way Pierre does', () => {
    const code = codeWithGutterCells({ 'data-unified': '' }, [
      { index: 0, number: 10, type: 'change-deletion' },
      { index: 1, number: 10, type: 'change-addition' },
      { index: 2, number: 11, type: 'context' }
    ])
    const { lines } = measureDragLines(code)
    expect(lines.map((line) => line.lineSide)).toEqual(['deletions', 'additions', 'additions'])
  })

  test('lets a split pane side override line types', () => {
    const code = codeWithGutterCells({ 'data-additions': '' }, [
      { index: 0, number: 10, type: 'change-deletion' }
    ])
    expect(measureDragLines(code).lines[0]?.lineSide).toBe('additions')
  })
})
