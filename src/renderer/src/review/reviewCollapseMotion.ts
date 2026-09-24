import type { CodeView as CodeViewInstance } from '@pierre/diffs'

// Collapsing a file is done tens of times per review, so the motion only has to
// say what happened, not perform it: a few pixels and a short fade. The layout
// itself changes instantly — the virtualizer owns heights, and animating them
// would fight it — and these run on the settled result, transform and opacity
// only, so they cost nothing but compositing.
const OFFSET_PX = 6
const FROM_OPACITY = 0.35

function motionTiming(): KeyframeAnimationOptions {
  const style = getComputedStyle(document.documentElement)
  return {
    duration: Number.parseFloat(style.getPropertyValue('--duration-panel')) || 180,
    easing: style.getPropertyValue('--ease-out').trim() || 'ease-out'
  }
}

function keyframes(offset: number): Keyframe[] {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  return reduce || offset === 0
    ? [{ opacity: FROM_OPACITY }, { opacity: 1 }]
    : [{ opacity: FROM_OPACITY, transform: `translateY(${offset}px)` }, { opacity: 1, transform: 'none' }]
}

/**
 * Expanding lets the file's code settle down out of its header; collapsing lets
 * the files below rise into the space it gave up. Both read as the same fold,
 * in opposite directions, from the header the reader just clicked.
 */
export function animateReviewItemToggle<Annotation>(
  viewer: CodeViewInstance<Annotation>,
  itemId: string,
  collapsing: boolean
): void {
  if (typeof Element.prototype.animate !== 'function') return
  const rendered = viewer.getRenderedItems()
  const index = rendered.findIndex((item) => item.id === itemId)
  if (index < 0) return
  const timing = motionTiming()

  if (!collapsing) {
    const code = rendered[index]!.element.shadowRoot?.querySelector('pre')
    code?.animate(keyframes(-OFFSET_PX), timing)
    return
  }

  const viewportBottom = window.innerHeight
  for (const item of rendered.slice(index + 1)) {
    if (item.element.getBoundingClientRect().top > viewportBottom) break
    item.element.animate(keyframes(OFFSET_PX * 2), timing)
  }
}
