import { afterEach, describe, expect, test } from 'bun:test'

import {
  clearSearchResults,
  EMPTY_SEARCH_RESULTS,
  getSearchResults,
  publishSearchResults,
  subscribeSearchResults
} from './searchResultsStore'

afterEach(clearSearchResults)

describe('searchResultsStore', () => {
  test('starts empty and hands out the same frozen instance', () => {
    expect(getSearchResults()).toBe(EMPTY_SEARCH_RESULTS)
    clearSearchResults()
    expect(getSearchResults()).toBe(EMPTY_SEARCH_RESULTS)
    expect(Object.isFrozen(EMPTY_SEARCH_RESULTS)).toBe(true)
  })

  test('notifies subscribers when a search settles', () => {
    const seen: string[] = []
    const stop = subscribeSearchResults(() => seen.push(getSearchResults().query))

    publishSearchResults({ query: 'render', results: [] })
    publishSearchResults({ query: 'render', results: [] })

    stop()
    publishSearchResults({ query: 'later', results: [] })

    expect(seen).toEqual(['render', 'render'])
    expect(getSearchResults().query).toBe('later')
  })

  test('bails out when the same snapshot is published twice', () => {
    let notifications = 0
    const stop = subscribeSearchResults(() => { notifications += 1 })
    const settled = { query: 'render', results: [] }

    publishSearchResults(settled)
    publishSearchResults(settled)
    publishSearchResults({ query: settled.query, results: settled.results })

    stop()
    expect(notifications).toBe(1)
  })

  test('clearing restores the shared empty snapshot', () => {
    publishSearchResults({ query: 'render', results: [] })
    clearSearchResults()
    expect(getSearchResults()).toBe(EMPTY_SEARCH_RESULTS)
  })
})
