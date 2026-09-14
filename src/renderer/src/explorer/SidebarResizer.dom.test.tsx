import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'

import { SidebarResizer } from './SidebarResizer'

afterEach(cleanup)

function workspaceRect(): DOMRect {
  return {
    bottom: 800,
    height: 800,
    left: 0,
    right: 1_200,
    top: 0,
    width: 1_200,
    x: 0,
    y: 0,
    toJSON: () => ({})
  }
}

interface Harness {
  workspace: HTMLDivElement
  resizer: HTMLDivElement
  reads: () => number
  writes: () => number
  resetCounts: () => void
}

function mountResizer(): Harness {
  const { container } = render(
    <div className="workspace">
      <SidebarResizer />
    </div>
  )
  const workspace = container.querySelector('.workspace')
  const resizer = container.querySelector('.sidebar-resizer')
  if (!(workspace instanceof HTMLDivElement) || !(resizer instanceof HTMLDivElement)) {
    throw new Error('Sidebar resizer did not render inside a workspace.')
  }

  let boundReads = 0
  workspace.getBoundingClientRect = () => {
    boundReads += 1
    return workspaceRect()
  }
  let widthWrites = 0
  const setProperty = workspace.style.setProperty.bind(workspace.style)
  workspace.style.setProperty = (property, value, priority) => {
    if (property === '--sidebar-width') widthWrites += 1
    setProperty(property, value, priority)
  }
  const captured = new Set<number>()
  resizer.setPointerCapture = (pointerId) => { captured.add(pointerId) }
  resizer.releasePointerCapture = (pointerId) => { captured.delete(pointerId) }
  resizer.hasPointerCapture = (pointerId) => captured.has(pointerId)

  return {
    workspace,
    resizer,
    reads: () => boundReads,
    writes: () => widthWrites,
    resetCounts: () => {
      boundReads = 0
      widthWrites = 0
    }
  }
}

test('captures workspace bounds once on pointer-down and never on pointer-move', () => {
  const { resizer, reads, resetCounts } = mountResizer()
  const boundReadsAt = reads
  resetCounts()
  act(() => {
    resizer.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 280,
      pointerId: 1
    }))
  })
  expect(boundReadsAt()).toBe(1)

  act(() => {
    for (let index = 0; index < 20; index += 1) {
      resizer.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 300 + index * 4,
        pointerId: 1
      }))
    }
  })
  expect(boundReadsAt()).toBe(1)
})

test('writes the sidebar width once per pixel the divider actually moves', () => {
  const { resizer, writes, resetCounts } = mountResizer()

  act(() => {
    resizer.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 280,
      pointerId: 1
    }))
  })
  resetCounts()

  act(() => {
    for (let index = 0; index < 8; index += 1) {
      // Four events land on each of two pointer positions, as a high-rate
      // pointer delivers them within one frame.
      resizer.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: 300 + Math.floor(index / 4) * 10,
        pointerId: 1
      }))
    }
  })

  expect(writes()).toBe(2)
})

test('commits the dragged width without measuring or writing it again', () => {
  const { workspace, resizer, reads, writes, resetCounts } = mountResizer()

  act(() => {
    resizer.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      clientX: 280,
      pointerId: 1
    }))
    resizer.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      clientX: 340,
      pointerId: 1
    }))
  })
  const dragged = workspace.style.getPropertyValue('--sidebar-width')
  resetCounts()

  act(() => {
    resizer.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 340, pointerId: 1 }))
  })

  expect(workspace.style.getPropertyValue('--sidebar-width')).toBe(dragged)
  expect(reads()).toBe(0)
  expect(writes()).toBe(1)
})
