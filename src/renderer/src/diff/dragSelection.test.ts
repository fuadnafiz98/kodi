import { describe, expect, test } from 'bun:test'

import { DRAG_SELECTION_CSS, findClosestDragLine, type DragLineGeometry } from './dragSelection'

const lines: DragLineGeometry[] = [
  { index: 10, lineNumber: 100, top: 0, bottom: 20 },
  { index: 11, lineNumber: 101, top: 20, bottom: 60 },
  { index: 14, lineNumber: 104, top: 60, bottom: 80 }
]

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

  test('keeps the gutter add control a squircle', () => {
    expect(DRAG_SELECTION_CSS).toContain('corner-shape: squircle !important')
    expect(DRAG_SELECTION_CSS).not.toContain('corner-shape: round')
    expect(DRAG_SELECTION_CSS).not.toContain('border-radius: 50%')
  })

  test('keeps the gutter add control in the number column, between rows', () => {
    expect(DRAG_SELECTION_CSS).toContain('[data-gutter] [data-utility-button]')
    expect(DRAG_SELECTION_CSS).toContain('margin-right: 0 !important')
    expect(DRAG_SELECTION_CSS).toContain('transform: translateY(50%)')
  })
})
