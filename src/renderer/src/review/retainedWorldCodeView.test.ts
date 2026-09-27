import { expect, test } from 'bun:test'
import type { CodeViewHandle } from '@pierre/diffs/react'

import type { ReviewAnnotationMetadata } from './ReviewComments'
import { createExactScroller } from './retainedWorldCodeView'

/** Pierre's `position` scroll: lands the sticky header short, unless clamped at the top. */
function fakeViewer(stickyHeader: number) {
  let scrollTop = 0
  const viewer = {
    scrollTo: ({ position }: { position: number }) => {
      scrollTop = Math.max(0, position - stickyHeader)
    }
  } as unknown as CodeViewHandle<ReviewAnnotationMetadata>
  return { viewer, scrollTop: () => scrollTop }
}

test('a restore lands on the exact offset after one correction', () => {
  const { viewer, scrollTop } = fakeViewer(44)
  const scrollExactly = createExactScroller()
  scrollExactly(viewer, 30_016, null)
  expect(scrollTop()).toBe(29_972)
  scrollExactly(viewer, 30_016, scrollTop())
  expect(scrollTop()).toBe(30_016)
  // Settled: asking again keeps it there instead of drifting.
  scrollExactly(viewer, 30_016, scrollTop())
  expect(scrollTop()).toBe(30_016)
})

test('a viewer that lands where it was asked needs no correction', () => {
  const { viewer, scrollTop } = fakeViewer(0)
  const scrollExactly = createExactScroller()
  scrollExactly(viewer, 5_000, null)
  scrollExactly(viewer, 5_000, scrollTop())
  expect(scrollTop()).toBe(5_000)
})
