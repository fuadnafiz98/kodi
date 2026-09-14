import { describe, expect, it } from 'bun:test'

import {
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth
} from './sidebarWidth'

describe('clampSidebarWidth', () => {
  it('keeps the sidebar within its standard limits', () => {
    expect(clampSidebarWidth(120)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(340)).toBe(340)
    expect(clampSidebarWidth(900)).toBe(MAX_SIDEBAR_WIDTH)
  })

  it('preserves space for the diff surface in a narrow workspace', () => {
    expect(clampSidebarWidth(400, 700)).toBe(340)
  })
})
