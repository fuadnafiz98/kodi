import { useSyncExternalStore } from 'react'

import type { ContentSearchResult } from '../../../shared/contracts'

export interface SearchResultsSnapshot {
  query: string
  results: readonly ContentSearchResult[]
}

/**
 * One frozen instance for "nothing to mark". The diff viewer compares marker
 * arrays by identity, so a fresh `[]` per keystroke would re-push markers into
 * the editor for a search that has not produced anything.
 */
export const EMPTY_SEARCH_RESULTS: SearchResultsSnapshot = Object.freeze({
  query: '',
  results: Object.freeze([]) as readonly ContentSearchResult[]
})

let snapshot: SearchResultsSnapshot = EMPTY_SEARCH_RESULTS
const listeners = new Set<() => void>()

export function getSearchResults(): SearchResultsSnapshot {
  return snapshot
}

export function subscribeSearchResults(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The palette publishes here when a content search settles or when it closes.
 * Keystrokes do not: the workspace must not re-render while the reader types,
 * and half-finished result sets would only make the markers flicker.
 */
export function publishSearchResults(next: SearchResultsSnapshot): void {
  if (next.query === snapshot.query && next.results === snapshot.results) return
  snapshot = next
  for (const listener of listeners) listener()
}

export function clearSearchResults(): void {
  publishSearchResults(EMPTY_SEARCH_RESULTS)
}

export function useSearchResults(): SearchResultsSnapshot {
  return useSyncExternalStore(subscribeSearchResults, getSearchResults, getSearchResults)
}
