import { describe, expect, it } from 'bun:test'

import { COLLAPSED_SEPARATOR_CSS } from './collapsedSeparator'
import {
  clampSplitPercentage,
  resistedSplitPercentage,
  splitPercentageFromPointer,
  syncSplitDiffResizeLifecycle
} from './splitDiffResize'

/**
 * The declarations of the rule whose selector list contains `selector` exactly.
 * `toContain` on the whole sheet cannot tell "this rule sets it" from "some
 * longer selector elsewhere does", which is the distinction these grid
 * placements turn on.
 */
function declarationsFor(css: string, selector: string): string {
  for (const block of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
    const parts = block.split('{')
    if (parts.length < 2) continue
    const selectors = (parts.at(-2) ?? '').split(',').map((entry) => entry.trim())
    if (selectors.includes(selector)) return parts.at(-1) ?? ''
  }
  return ''
}

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

  it('renders the unmodified-line label in the code column, not on the host', () => {
    expect(COLLAPSED_SEPARATOR_CSS).toContain(
      '[data-content] [data-separator="line-info-basic"] [data-separator-wrapper]'
    )
    expect(COLLAPSED_SEPARATOR_CSS).toContain(
      '[data-gutter] [data-separator="line-info-basic"] [data-separator-content]'
    )
    expect(COLLAPSED_SEPARATOR_CSS).not.toContain('width: 100cqi')
    expect(COLLAPSED_SEPARATOR_CSS).not.toContain('--kodi-split-before-width')
  })

  it('keeps expand chevrons on the unmodified-lines seam', () => {
    expect(COLLAPSED_SEPARATOR_CSS).toContain(
      '[data-gutter] [data-separator="line-info-basic"] [data-expand-button]'
    )
    expect(COLLAPSED_SEPARATOR_CSS).toContain(
      '[data-content] [data-separator="line-info-basic"] [data-expand-button]'
    )
    expect(COLLAPSED_SEPARATOR_CSS).toContain(
      'grid-template-columns: 28px 28px minmax(0, 1fr)'
    )
  })

  // Pierre pins the label to grid column 2, which is the second button's track
  // as soon as a hunk can expand both ways: the count and the down chevron drew
  // in one 28px cell.
  it('keeps the unmodified-line count out of the expand buttons’ tracks', () => {
    expect(declarationsFor(
      COLLAPSED_SEPARATOR_CSS,
      '[data-content] [data-separator="line-info-basic"] [data-separator-content]'
    )).toContain('grid-column: -2 / -1')
    expect(declarationsFor(
      COLLAPSED_SEPARATOR_CSS,
      '[data-diff-type="split"] [data-additions] [data-content] [data-separator="line-info-basic"] [data-separator-content]'
    )).toContain('grid-column: 1 / -1')
  })

  // The code column is as wide as the file's longest line, so a centred label
  // sits past the right edge of the pane on anything but a narrow file.
  it('leads the seam with the count instead of centring it', () => {
    const seam = declarationsFor(
      COLLAPSED_SEPARATOR_CSS,
      '[data-separator="line-info-basic"] [data-separator-content]'
    )
    expect(seam).toContain('justify-content: flex-start')
    expect(seam).not.toContain('justify-content: center')
    expect(COLLAPSED_SEPARATOR_CSS).not.toContain('[data-separator-content]::before')
  })

  it('keeps one unmodified-line count in split view', () => {
    expect(COLLAPSED_SEPARATOR_CSS).toContain(
      '[data-diff-type="split"] [data-additions] [data-unmodified-lines]'
    )
    expect(COLLAPSED_SEPARATOR_CSS).toContain('display: none')
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
