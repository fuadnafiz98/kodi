import { describe, expect, it } from 'bun:test'

import { msUntilIdleAdoption, shouldAdoptNewRevision } from './useNewRevisionWatch'

describe('shouldAdoptNewRevision', () => {
  it('adopts silently when nobody is looking', () => {
    expect(shouldAdoptNewRevision({ hidden: true, msSinceInteraction: 0 })).toBe(true)
    expect(shouldAdoptNewRevision({ hidden: false, msSinceInteraction: 30_000 })).toBe(true)
  })

  // Swapping the hunks under a reader loses their place, their scroll position
  // and the meaning of every file they had marked viewed.
  it('asks first while the review is being read', () => {
    expect(shouldAdoptNewRevision({ hidden: false, msSinceInteraction: 0 })).toBe(false)
    expect(shouldAdoptNewRevision({ hidden: false, msSinceInteraction: 9_999 })).toBe(false)
  })

  it('takes the idle window from the caller', () => {
    expect(shouldAdoptNewRevision({ hidden: false, msSinceInteraction: 500, idleMs: 100 })).toBe(true)
  })

  // A caret in a comment field is the one kind of stillness that is not absence.
  it('never adopts under a caret, unless the window is hidden anyway', () => {
    expect(shouldAdoptNewRevision({ hidden: false, typing: true, msSinceInteraction: 60_000 })).toBe(false)
    expect(shouldAdoptNewRevision({ hidden: true, typing: true, msSinceInteraction: 0 })).toBe(true)
  })
})

describe('msUntilIdleAdoption', () => {
  it('reports how long a still reader has left', () => {
    expect(msUntilIdleAdoption(0)).toBe(10_000)
    expect(msUntilIdleAdoption(9_000)).toBe(1_000)
    expect(msUntilIdleAdoption(15_000)).toBe(0)
    expect(msUntilIdleAdoption(50, 100)).toBe(50)
  })
})
