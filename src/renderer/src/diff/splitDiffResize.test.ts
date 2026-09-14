import { describe, expect, it } from 'bun:test'

import { CENTERED_COLLAPSED_SEPARATOR_CSS } from './collapsedSeparator'
import {
  clampSplitPercentage,
  resistedSplitPercentage,
  splitPercentageFromPointer,
  syncSplitDiffResizeLifecycle
} from './splitDiffResize'

describe('split diff resizing', () => {
  it('keeps both code panes within useful limits', () => {
    expect(clampSplitPercentage(10)).toBe(25)
    expect(clampSplitPercentage(42)).toBe(42)
    expect(clampSplitPercentage(90)).toBe(75)
  })

  it('maps the pointer position to the diff surface', () => {
    expect(splitPercentageFromPointer(400, 200, 800)).toBe(25)
    expect(splitPercentageFromPointer(600, 200, 800)).toBe(50)
    expect(splitPercentageFromPointer(1_000, 200, 800)).toBe(75)
  })

  it('uses the balanced split when the surface has no width', () => {
    expect(splitPercentageFromPointer(400, 200, 0)).toBe(50)
  })

  it('answers overshoot with resistance during a drag', () => {
    expect(resistedSplitPercentage(15, 1_000)).toBeGreaterThan(15)
    expect(resistedSplitPercentage(85, 1_000)).toBeLessThan(85)
  })

  it('centres unmodified-line labels in the code column, not on the host', () => {
    expect(CENTERED_COLLAPSED_SEPARATOR_CSS).toContain(
      '[data-content] [data-separator="line-info-basic"] [data-separator-wrapper]'
    )
    expect(CENTERED_COLLAPSED_SEPARATOR_CSS).toContain(
      '[data-gutter] [data-separator="line-info-basic"] [data-separator-content]'
    )
    expect(CENTERED_COLLAPSED_SEPARATOR_CSS).not.toContain('width: 100cqi')
    expect(CENTERED_COLLAPSED_SEPARATOR_CSS).not.toContain('--kodi-split-before-width')
  })

  it('keeps expand chevrons on the unmodified-lines seam', () => {
    expect(CENTERED_COLLAPSED_SEPARATOR_CSS).toContain(
      '[data-gutter] [data-separator="line-info-basic"] [data-expand-button]'
    )
    expect(CENTERED_COLLAPSED_SEPARATOR_CSS).toContain(
      '[data-content] [data-separator="line-info-basic"] [data-expand-button]'
    )
    expect(CENTERED_COLLAPSED_SEPARATOR_CSS).toContain(
      'grid-template-columns: 28px 28px minmax(0, 1fr)'
    )
  })

  it('keeps one unmodified-line count in split view', () => {
    expect(CENTERED_COLLAPSED_SEPARATOR_CSS).toContain(
      '[data-diff-type="split"] [data-additions] [data-unmodified-lines]'
    )
    expect(CENTERED_COLLAPSED_SEPARATOR_CSS).toContain('display: none')
  })

  it('updates the split track when the handle moves', () => {
    const surface = document.createElement('div')
    surface.className = 'diff-panel'
    const viewer = document.createElement('div')
    surface.append(viewer)
    const root = viewer.attachShadow({ mode: 'open' })
    const splitDiff = document.createElement('pre')
    splitDiff.dataset.diffType = 'split'
    root.append(splitDiff)

    syncSplitDiffResizeLifecycle(viewer, 'mount')
    const handle = root.querySelector<HTMLElement>('[data-split-resize-handle]')
    handle?.dispatchEvent(new KeyboardEvent('keydown', {
      bubbles: true,
      composed: true,
      key: 'ArrowLeft'
    }))

    expect(surface.style.getPropertyValue('--kodi-split-before')).toBe('48fr')
    syncSplitDiffResizeLifecycle(viewer, 'unmount')
  })

  it('coalesces pointer moves and commits the final position on pointer-up', () => {
    const surface = document.createElement('div')
    surface.className = 'diff-panel'
    const viewer = document.createElement('div')
    surface.append(viewer)
    const root = viewer.attachShadow({ mode: 'open' })
    const splitDiff = document.createElement('pre')
    splitDiff.dataset.diffType = 'split'
    root.append(splitDiff)
    viewer.getBoundingClientRect = () => ({
      bottom: 400,
      height: 400,
      left: 0,
      right: 800,
      top: 0,
      width: 800,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })

    const originalRequestAnimationFrame = window.requestAnimationFrame
    const originalCancelAnimationFrame = window.cancelAnimationFrame
    let frame: FrameRequestCallback | null = null
    let nextFrame = 0
    const cancelled: number[] = []
    window.requestAnimationFrame = (callback) => {
      frame = callback
      nextFrame += 1
      return nextFrame
    }
    window.cancelAnimationFrame = (id) => { cancelled.push(id) }

    try {
      syncSplitDiffResizeLifecycle(viewer, 'mount')
      const handle = root.querySelector<HTMLElement>('[data-split-resize-handle]')!
      handle.setPointerCapture = () => undefined
      handle.hasPointerCapture = () => true
      handle.releasePointerCapture = () => undefined
      const pointer = (type: string, clientX: number) => new PointerEvent(type, {
        bubbles: true,
        composed: true,
        pointerId: 7,
        button: 0,
        clientX
      })

      handle.dispatchEvent(pointer('pointerdown', 400))
      handle.dispatchEvent(pointer('pointermove', 480))
      handle.dispatchEvent(pointer('pointermove', 560))
      expect(surface.style.getPropertyValue('--kodi-split-before')).toBe('')

      const queuedFrame = frame as FrameRequestCallback | null
      expect(queuedFrame).not.toBeNull()
      queuedFrame?.(0)
      expect(surface.style.getPropertyValue('--kodi-split-before')).toBe('70fr')

      handle.dispatchEvent(pointer('pointermove', 600))
      handle.dispatchEvent(pointer('pointerup', 600))
      expect(cancelled).toEqual([2])
      expect(surface.style.getPropertyValue('--kodi-split-before')).toBe('75fr')
    } finally {
      syncSplitDiffResizeLifecycle(viewer, 'unmount')
      window.requestAnimationFrame = originalRequestAnimationFrame
      window.cancelAnimationFrame = originalCancelAnimationFrame
    }
  })
})
