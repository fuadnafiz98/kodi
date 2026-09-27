import { afterEach, describe, expect, test } from 'bun:test'

import {
  codeFromEventPath,
  collectDragLines,
  DRAG_SELECTION_CSS,
  findClosestDragLine,
  syncDragGuideLifecycle,
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

describe('collectDragLines', () => {
  test('maps unified line types to sides the way Pierre does', () => {
    const code = codeWithGutterCells({ 'data-unified': '' }, [
      { index: 0, number: 10, type: 'change-deletion' },
      { index: 1, number: 10, type: 'change-addition' },
      { index: 2, number: 11, type: 'context' }
    ])
    const { cells } = collectDragLines(code)
    expect(cells.map((cell) => cell.lineSide)).toEqual(['deletions', 'additions', 'additions'])
  })

  test('lets a split pane side override line types', () => {
    const code = codeWithGutterCells({ 'data-additions': '' }, [
      { index: 0, number: 10, type: 'change-deletion' }
    ])
    expect(collectDragLines(code).cells[0]?.lineSide).toBe('additions')
  })
})

describe('syncDragGuideLifecycle at scale', () => {
  const LINE_HEIGHT = 20
  const LINE_COUNT = 5_000

  // A long file's gutter inside a scrolled viewer. happy-dom has no layout, so
  // the rect read stands in for it — each row's top minus the scroll offset —
  // and counts calls. The count is what is asserted, not happy-dom's speed.
  function scrolledDrag() {
    const scroller = document.createElement('div')
    scroller.className = 'multi-file-code-view'
    const host = document.createElement('div')
    scroller.append(host)
    document.body.append(scroller)
    const root = host.attachShadow({ mode: 'open' })
    const code = codeWithGutterCells({ 'data-additions': '' }, [])
    const gutter = code.querySelector<HTMLElement>('[data-gutter]')!
    const addRows = (from: number, to: number): void => {
      for (let index = from; index < to; index += 1) {
        const cell = document.createElement('div')
        cell.setAttribute('data-column-number', String(index + 1))
        cell.setAttribute('data-line-index', String(index))
        gutter.append(cell)
      }
    }
    addRows(0, LINE_COUNT)
    const button = document.createElement('button')
    button.setAttribute('data-utility-button', '')
    code.append(button)
    root.append(code)

    let scrollTop = 0
    let reads = 0
    // Shadowed on HTMLElement and deleted afterwards, which uncovers the
    // Element implementation again.
    const prototype = HTMLElement.prototype
    Object.defineProperty(prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) {
        reads += 1
        const top = Number(this.dataset.lineIndex ?? 0) * LINE_HEIGHT - scrollTop
        return { top, bottom: top + LINE_HEIGHT }
      }
    })

    const selected: unknown[] = []
    syncDragGuideLifecycle(host, 'mount', (range) => selected.push(range))
    const pointer = (type: string, clientY: number): void => {
      button.dispatchEvent(new PointerEvent(type, { pointerId: 7, clientY, bubbles: true, composed: true, cancelable: true }))
    }
    return {
      selected,
      pointer,
      reads: () => reads,
      scrollBy(pixels: number) {
        scrollTop += pixels
        scroller.dispatchEvent(new Event('scroll'))
      },
      rerender(rows: number) {
        addRows(LINE_COUNT, LINE_COUNT + rows)
        syncDragGuideLifecycle(host, 'update', (range) => selected.push(range))
      },
      restore() {
        syncDragGuideLifecycle(host, 'unmount', () => {})
        delete (prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect
        scroller.remove()
      }
    }
  }

  let active: ReturnType<typeof scrolledDrag> | null = null
  afterEach(() => {
    active?.restore()
    active = null
  })

  // Re-measuring every row after a scroll read 5,000 rects per move here.
  const READ_BUDGET = 2 * Math.ceil(Math.log2(LINE_COUNT)) + 2

  test('a scrolling drag reads a bounded number of rows per move', () => {
    const drag = scrolledDrag()
    active = drag
    drag.pointer('pointerdown', 100 * LINE_HEIGHT + 5)
    const readsPerMove: number[] = []
    const msPerMove: number[] = []
    for (let step = 0; step < 40; step += 1) {
      drag.scrollBy(LINE_HEIGHT * 3)
      const before = drag.reads()
      const startedAt = performance.now()
      drag.pointer('pointermove', 400 + (step % 5) * 7)
      msPerMove.push(performance.now() - startedAt)
      readsPerMove.push(drag.reads() - before)
    }
    drag.pointer('pointerup', 400)

    const sorted = [...msPerMove].sort((left, right) => left - right)
    console.info(`drag guide after scroll: ${Math.max(...readsPerMove)} rect reads per move (max), `
      + `median ${sorted[20]!.toFixed(2)} ms, max ${sorted[39]!.toFixed(2)} ms`)
    expect(Math.max(...readsPerMove)).toBeLessThanOrEqual(READ_BUDGET)
    // Forty steps of three rows put the last move (y 428) on row 141, line 142.
    expect(drag.selected).toEqual([{ start: 101, end: 142, side: 'additions', endSide: 'additions' }])
  })

  test('rows the viewer renders mid-drag are picked up on the next move', () => {
    const drag = scrolledDrag()
    active = drag
    drag.pointer('pointerdown', 5)
    drag.rerender(20)
    const before = drag.reads()
    drag.pointer('pointermove', (LINE_COUNT + 10) * LINE_HEIGHT + 5)
    expect(drag.reads() - before).toBeLessThanOrEqual(READ_BUDGET)
    drag.pointer('pointerup', 0)
    expect(drag.selected).toEqual([{ start: 1, end: LINE_COUNT + 11, side: 'additions', endSide: 'additions' }])
  })
})
