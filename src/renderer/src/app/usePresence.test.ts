import { describe, expect, test } from 'bun:test'

import { presenceFrom } from './usePresence'

describe('presenceFrom', () => {
  test('an open surface is mounted and not closing', () => {
    expect(presenceFrom(true, true)).toEqual({ mounted: true, closing: false })
  })

  test('the first frame after opening mounts before the retain flag catches up', () => {
    expect(presenceFrom(false, true)).toEqual({ mounted: true, closing: false })
  })

  test('a closed surface stays mounted while it is closing', () => {
    expect(presenceFrom(true, false)).toEqual({ mounted: true, closing: true })
  })

  test('once the exit has run the surface leaves the tree', () => {
    expect(presenceFrom(false, false)).toEqual({ mounted: false, closing: false })
  })
})
