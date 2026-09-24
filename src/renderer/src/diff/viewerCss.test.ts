import { describe, expect, test } from 'bun:test'

import { VIEWER_BASE_CSS } from './viewerCss'

describe('VIEWER_BASE_CSS gutter utility lane', () => {
  test('widens the number-cell padding into a dedicated utility lane', () => {
    expect(VIEWER_BASE_CSS).toContain('[data-column-number]')
    expect(VIEWER_BASE_CSS).toContain('padding-left: 26px')
  })

  test('pins the utility slot to the lane and parks the button beside the digits', () => {
    const slot = VIEWER_BASE_CSS.match(/\[data-gutter-utility-slot\]\s*{([^}]*)}/)?.[1] ?? ''
    expect(slot).toContain('left: 0')
    expect(slot).toContain('right: auto')
    expect(slot).toContain('width: 26px')
    expect(slot).toContain('justify-content: flex-end')
    expect(slot).not.toContain('justify-content: center')
  })
})
