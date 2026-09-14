import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import type { ContentSearchResult, RepositoryApi, RepositorySnapshot } from '../../../shared/contracts'
import { EMPTY_SEARCH_RESULTS, getSearchResults } from './searchResultsStore'
import { useRepositorySearch } from './useRepositorySearch'

afterEach(() => {
  cleanup()
  delete window.repository
})

const snapshot: RepositorySnapshot = {
  root: '/repo',
  name: 'repo',
  kind: 'git',
  branch: 'main',
  head: null,
  paths: [
    'src/App.tsx',
    'src/fileSearch.ts',
    'docs/notes.md'
  ],
  statuses: []
}

const onError = (): void => {}

interface SearchStub {
  cancels: number
  queries: string[]
  results: ContentSearchResult[]
}

function stubRepositoryApi(results: ContentSearchResult[] = []): SearchStub {
  const stub: SearchStub = { cancels: 0, queries: [], results }
  window.repository = {
    cancelContentSearch: () => { stub.cancels += 1 },
    searchContent: async (query: string) => {
      stub.queries.push(query)
      return stub.results
    }
  } as unknown as RepositoryApi
  return stub
}

test('file search ranks snapshot paths before git status finishes', async () => {
  stubRepositoryApi()
  const { result } = renderHook(() => useRepositorySearch(snapshot, onError))

  act(() => {
    result.current.changeQuery('file')
  })

  await waitFor(() => {
    expect(result.current.fileResults.map((match) => match.path)).toContain('src/fileSearch.ts')
  })
  expect(result.current.fileResults.map((match) => match.path)).not.toContain('docs/notes.md')
})

test('offers files and folders before anything is typed', () => {
  stubRepositoryApi()
  const { result } = renderHook(() => useRepositorySearch(snapshot, onError, null, ['docs/notes.md']))

  expect(result.current.fileResults[0]).toEqual({ path: 'docs/notes.md', kind: 'file' })
  expect(result.current.fileResults.some((match) => match.kind === 'dir')).toBe(true)
})

test('does not cancel a content search that was never started', async () => {
  const stub = stubRepositoryApi()
  const { result } = renderHook(() => useRepositorySearch(snapshot, onError))

  act(() => { result.current.changeQuery('a') })
  act(() => { result.current.changeQuery('ab') })
  act(() => { result.current.changeQuery('') })

  await waitFor(() => {
    expect(result.current.searchingContent).toBe(false)
  })
  expect(stub.cancels).toBe(0)
  expect(stub.queries).toEqual([])
})

test('publishes settled results for the diff viewer and clears them on unmount', async () => {
  const hit: ContentSearchResult = { path: 'src/App.tsx', line: 3, column: 1, preview: 'render()' }
  stubRepositoryApi([hit])
  const { result, unmount } = renderHook(() => useRepositorySearch(snapshot, onError))

  act(() => { result.current.changeQuery('render') })

  await waitFor(() => {
    expect(getSearchResults().results).toEqual([hit])
  })
  expect(getSearchResults().query).toBe('render')

  unmount()
  expect(getSearchResults()).toBe(EMPTY_SEARCH_RESULTS)
})

test('holds a path-like query back until the reader stops, and Enter runs it now', async () => {
  const stub = stubRepositoryApi()
  const { result } = renderHook(() => useRepositorySearch(snapshot, onError))

  act(() => { result.current.changeQuery('src/fil') })
  await waitFor(() => {
    expect(result.current.searchingContent).toBe(true)
  })
  expect(stub.queries).toEqual([])

  act(() => { result.current.flushContentSearch() })
  await waitFor(() => {
    expect(stub.queries).toEqual(['src/fil'])
  })
})

// P17 called a query with five or more file-name hits "navigation" and held it
// for the path pause; 'app' is an ordinary word in a repository full of app*.ts.
test('a word that matches many file names is still a content search', async () => {
  const stub = stubRepositoryApi()
  const appSnapshot: RepositorySnapshot = {
    ...snapshot,
    paths: Array.from({ length: 6 }, (_, index) => `src/app-${index}.ts`)
  }
  const { result } = renderHook(() => useRepositorySearch(appSnapshot, onError))

  act(() => { result.current.changeQuery('app') })

  await waitFor(() => {
    expect(stub.queries).toEqual(['app'])
  }, { timeout: 250 })
})

test('resets content results to one shared instance', () => {
  stubRepositoryApi()
  const { result } = renderHook(() => useRepositorySearch(snapshot, onError))
  const initial = result.current.contentResults

  act(() => { result.current.changeQuery('ab') })

  expect(result.current.contentResults).toBe(initial)
  expect(initial).toBe(EMPTY_SEARCH_RESULTS.results)
})
