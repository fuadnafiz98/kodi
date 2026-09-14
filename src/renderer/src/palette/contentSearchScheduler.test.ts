import { describe, expect, test } from 'bun:test'

import {
  CONTENT_SEARCH_LONG_QUERY_MS,
  CONTENT_SEARCH_MEDIUM_QUERY_MS,
  CONTENT_SEARCH_PATH_PAUSE_MS,
  contentSearchDelay,
  isPathLikeQuery,
  simulateContentSearchSchedule
} from './contentSearchScheduler'

function typingEvents(interval: number): Array<{ at: number; query: string }> {
  const target = 'repository'
  return Array.from(target, (_, index) => ({
    at: index * interval,
    query: target.slice(0, index + 1)
  }))
}

describe('content search scheduling', () => {
  test('shortens the debounce as the query narrows', () => {
    expect(contentSearchDelay('re', 'rep')).toBe(CONTENT_SEARCH_MEDIUM_QUERY_MS)
    expect(contentSearchDelay('rep', 'repo')).toBe(CONTENT_SEARCH_MEDIUM_QUERY_MS)
    expect(contentSearchDelay('repo', 'repos')).toBe(CONTENT_SEARCH_LONG_QUERY_MS)
    expect(contentSearchDelay('repos', 'reposi')).toBe(CONTENT_SEARCH_LONG_QUERY_MS)
    expect(CONTENT_SEARCH_LONG_QUERY_MS).toBeLessThan(CONTENT_SEARCH_MEDIUM_QUERY_MS)
  })

  test('coalesces normal typing into one native search', () => {
    const previous = simulateContentSearchSchedule(typingEvents(60), () => 50)
    const optimized = simulateContentSearchSchedule(typingEvents(60), contentSearchDelay)
    expect(previous.starts).toBeGreaterThan(5)
    expect(optimized.starts).toBe(1)
    expect(optimized.stableQueryDelay).toBe(CONTENT_SEARCH_LONG_QUERY_MS)
  })

  test('a paste searches at once, then the typed tail searches once more', () => {
    const settled = simulateContentSearchSchedule([
      { at: 0, query: 'rende' },
      { at: 40, query: 'render' },
      { at: 80, query: 'renderi' }
    ], contentSearchDelay)

    expect(settled.starts).toBe(2)
    expect(settled.stableQueryDelay).toBe(CONTENT_SEARCH_LONG_QUERY_MS)
  })

  test('keeps paste immediate', () => {
    expect(contentSearchDelay('', 'pasted query')).toBe(0)
  })

  test('does not schedule short or cleared queries', () => {
    const result = simulateContentSearchSchedule([
      { at: 0, query: 'a' },
      { at: 20, query: 'ab' },
      { at: 40, query: '' }
    ], contentSearchDelay)
    expect(result.starts).toBe(0)
  })

  test('waits for a real pause on a path-like query', () => {
    expect(contentSearchDelay('src/App', 'src/App.', true)).toBe(CONTENT_SEARCH_PATH_PAUSE_MS)
    // Even a paste: a pasted path is navigation, and ripgrep would find nothing.
    expect(contentSearchDelay('', 'src/renderer/src/App.tsx', true)).toBe(CONTENT_SEARCH_PATH_PAUSE_MS)
    expect(contentSearchDelay('src/App', 'src/App.', false)).toBe(CONTENT_SEARCH_LONG_QUERY_MS)
  })

  // The measured regression this replaces: 'app' matched enough file names to be
  // called a path, so the first content result landed 419 ms after the last key.
  test('an ordinary word searches on the typing debounce, not the path pause', () => {
    expect(isPathLikeQuery('app')).toBe(false)
    const delay = contentSearchDelay('ap', 'app', isPathLikeQuery('app'))
    expect(delay).toBe(CONTENT_SEARCH_MEDIUM_QUERY_MS)
    // Budget: debounce + a ~30 ms ripgrep has to stay inside 150 ms.
    expect(delay).toBeLessThanOrEqual(120)
  })

  test('the path pause is a pause, not a wait', () => {
    expect(CONTENT_SEARCH_PATH_PAUSE_MS).toBe(250)
  })
})

describe('isPathLikeQuery', () => {
  test('treats a slash as navigation and nothing else', () => {
    expect(isPathLikeQuery('src/App')).toBe(true)
    expect(isPathLikeQuery('render')).toBe(false)
    expect(isPathLikeQuery('App')).toBe(false)
  })

  test('an empty query is not a path', () => {
    expect(isPathLikeQuery('')).toBe(false)
  })
})
