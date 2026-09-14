import { describe, expect, it } from 'bun:test'

import { getSearchNavigationDirection, moveSearchResultIndex } from './searchNavigation'

const plainEvent = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }

describe('search result keyboard navigation', () => {
  it('maps arrows and Command-J/K to a direction', () => {
    expect(getSearchNavigationDirection({ ...plainEvent, key: 'ArrowDown' })).toBe(1)
    expect(getSearchNavigationDirection({ ...plainEvent, key: 'ArrowUp' })).toBe(-1)
    expect(getSearchNavigationDirection({ ...plainEvent, key: 'j', metaKey: true })).toBe(1)
    expect(getSearchNavigationDirection({ ...plainEvent, key: 'k', metaKey: true })).toBe(-1)
  })

  it('leaves modified arrows and ordinary typing alone', () => {
    expect(getSearchNavigationDirection({ ...plainEvent, key: 'ArrowDown', altKey: true })).toBe(0)
    expect(getSearchNavigationDirection({ ...plainEvent, key: 'j' })).toBe(0)
  })

  it('wraps through the available results', () => {
    expect(moveSearchResultIndex(0, 3, -1)).toBe(2)
    expect(moveSearchResultIndex(2, 3, 1)).toBe(0)
    expect(moveSearchResultIndex(-1, 3, 1)).toBe(0)
    expect(moveSearchResultIndex(-1, 0, 1)).toBe(-1)
  })
})
