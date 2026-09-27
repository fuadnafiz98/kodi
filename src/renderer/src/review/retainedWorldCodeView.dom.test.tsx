import { afterEach, expect, test } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import type { CodeViewHandle } from '@pierre/diffs/react'

import type { ReviewAnnotationMetadata } from './ReviewComments'
import { useRetainedScrollRestore } from './retainedWorldCodeView'

afterEach(cleanup)

// Stands in for Pierre's handle: `rebuild` is what a hide does to the real one,
// a new instance that starts at the top.
function fakeViewer() {
  const scrolls: number[] = []
  let scrollTop = 0
  const handle = {
    getInstance: () => ({ getScrollTop: () => scrollTop }),
    scrollTo: (target: { position: number }) => {
      scrolls.push(target.position)
      scrollTop = target.position
    }
  } as unknown as CodeViewHandle<ReviewAnnotationMetadata>
  return {
    handle,
    scrolls,
    readerScroll(position: number) { scrollTop = position },
    rebuild() { scrollTop = 0 }
  }
}

test('a retained viewer is scrolled back to where its reader left it on every return', () => {
  const viewer = fakeViewer()
  const viewerRef = { current: viewer.handle }
  const containerRef = { current: document.createElement('div') }
  const { result, rerender } = renderHook(
    ({ active }: { active: boolean }) => useRetainedScrollRestore({
      active,
      loading: false,
      itemCount: 2,
      getInitialScrollTop: () => 120,
      viewerRef,
      containerRef
    }),
    { initialProps: { active: true } }
  )
  expect(viewer.scrolls).toEqual([120])

  viewer.readerScroll(640)
  result.current(640)
  rerender({ active: false })
  viewer.rebuild()
  rerender({ active: true })
  expect(viewer.scrolls).toEqual([120, 640])
})

test('a viewer that never scrolled returns to its first target', () => {
  const viewer = fakeViewer()
  const viewerRef = { current: viewer.handle }
  const containerRef = { current: document.createElement('div') }
  const { rerender } = renderHook(
    ({ active }: { active: boolean }) => useRetainedScrollRestore({
      active,
      loading: false,
      itemCount: 2,
      getInitialScrollTop: () => 120,
      viewerRef,
      containerRef
    }),
    { initialProps: { active: true } }
  )
  rerender({ active: false })
  viewer.rebuild()
  rerender({ active: true })
  expect(viewer.scrolls).toEqual([120, 120])
})
