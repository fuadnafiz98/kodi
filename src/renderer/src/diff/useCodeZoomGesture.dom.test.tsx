import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'

import { LIVE_CODE_FONT_SIZE_PROPERTY, LIVE_CODE_LINE_HEIGHT_PROPERTY } from './codeZoom'
import { useCodeZoomGesture } from './useCodeZoomGesture'

afterEach(cleanup)

test('updates zoom through CSS during a gesture and commits React state once on settle', async () => {
  let renderCount = 0

  function ZoomSurface(): React.JSX.Element {
    renderCount += 1
    const zoom = useCodeZoomGesture(13, 20)
    return (
      <section ref={zoom.surfaceRef} data-font-size={zoom.codeFontSize}>
        Code
      </section>
    )
  }

  const { container } = render(<ZoomSurface />)
  const surface = container.querySelector('section')
  if (!(surface instanceof HTMLElement)) throw new Error('Zoom surface did not render.')

  act(() => {
    for (let index = 0; index < 3; index += 1) {
      const wheel = new window.Event('wheel', { bubbles: true, cancelable: true })
      Object.defineProperties(wheel, {
        clientX: { value: 0 }, clientY: { value: 0 }, ctrlKey: { value: true },
        deltaMode: { value: 0 }, deltaY: { value: -1 }
      })
      surface.dispatchEvent(wheel)
    }
  })

  expect(surface.dataset.fontSize).toBe('13')
  expect(surface.style.getPropertyValue(LIVE_CODE_FONT_SIZE_PROPERTY)).toBe('13.39px')
  expect(surface.style.getPropertyValue(LIVE_CODE_LINE_HEIGHT_PROPERTY)).toBe('20.6px')
  expect(renderCount).toBe(1)

  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 150))
  })

  expect(surface.dataset.fontSize).toBe('13.39')
  expect(surface.style.getPropertyValue(LIVE_CODE_FONT_SIZE_PROPERTY)).toBe('')
  expect(surface.style.getPropertyValue(LIVE_CODE_LINE_HEIGHT_PROPERTY)).toBe('')
  expect(renderCount).toBe(2)
})
