import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import type { ContentSearchResult, RepositoryReview, RepositorySnapshot } from '../../../shared/contracts'
import { createFileSearchIndex, rankFilePaths, type RankedPath } from './fileSearch'
import { getErrorMessage, requireRepositoryApi } from '../explorer/repositoryApi'
import {
  CONTENT_SEARCH_MIN_QUERY_LENGTH,
  contentSearchDelay,
  isPathLikeQuery
} from './contentSearchScheduler'
import { NO_RECENT_FILES } from '../explorer/recentFiles'
import { clearSearchResults, EMPTY_SEARCH_RESULTS, publishSearchResults } from './searchResultsStore'
import { reviewPathsForSnapshot } from '../explorer/workspaceMode'

const FILE_SEARCH_RESULT_LIMIT = 32
// An empty query is an offer, not a filter: show enough of the repository to be
// worth reading without turning the palette into a scroll.
const EMPTY_QUERY_RESULT_LIMIT = 40

// Every reset goes through the same instance so React can bail out on identity
// instead of re-rendering the palette for an empty list it already had.
const NO_CONTENT_RESULTS = EMPTY_SEARCH_RESULTS.results
const NO_FILE_RESULTS: readonly RankedPath[] = Object.freeze([])

export interface RepositorySearchController {
  query: string
  fileResults: readonly RankedPath[]
  contentResults: readonly ContentSearchResult[]
  searchingContent: boolean
  changeQuery(query: string): void
  /** Run a debounced content search now, for a reader who pressed Enter on it. */
  flushContentSearch(): void
}

/**
 * Lives inside the command palette, the only consumer of live search state.
 * Settled content results reach the diff viewer through `searchResultsStore`, so
 * a keystroke re-renders the palette and nothing else.
 */
export function useRepositorySearch(
  snapshot: RepositorySnapshot | null,
  onError: (message: string) => void,
  repositoryReview: Pick<RepositoryReview, 'files'> | null = null,
  recentFiles: readonly string[] = NO_RECENT_FILES
): RepositorySearchController {
  const [query, setQuery] = useState('')
  const [contentResults, setContentResults] = useState<readonly ContentSearchResult[]>(NO_CONTENT_RESULTS)
  const [searchingContent, setSearchingContent] = useState(false)
  const contentRequestRef = useRef(0)
  const outstandingRequestRef = useRef(false)
  const pendingSearchRef = useRef<(() => void) | null>(null)
  const previousScheduledQueryRef = useRef('')
  const deferredQuery = useDeferredValue(query)
  const hasSnapshot = snapshot != null
  const searching = deferredQuery.trim() !== ''
  const snapshotPaths = snapshot?.paths
  const snapshotKind = snapshot?.kind
  const snapshotStatuses = snapshotKind === 'git' ? snapshot?.statuses : undefined
  const indexedPaths = useMemo(
    () => createFileSearchIndex(snapshotPaths ?? []),
    [snapshotPaths]
  )
  const priorityPaths = useMemo(() => {
    if (snapshotKind == null) return undefined
    const reviewPaths = reviewPathsForSnapshot(
      { kind: snapshotKind, statuses: snapshotStatuses ?? [] },
      repositoryReview
    )
    return reviewPaths.length === 0 ? undefined : new Set(reviewPaths)
  }, [repositoryReview, snapshotKind, snapshotStatuses])
  const fileResults = useMemo(
    () => hasSnapshot
      ? rankFilePaths(indexedPaths, deferredQuery, {
          limit: searching ? FILE_SEARCH_RESULT_LIMIT : EMPTY_QUERY_RESULT_LIMIT,
          priorityPaths,
          recentPaths: recentFiles
        })
      : NO_FILE_RESULTS,
    [deferredQuery, hasSnapshot, indexedPaths, priorityPaths, recentFiles, searching]
  )

  const changeQuery = useCallback((nextQuery: string) => {
    setQuery(nextQuery)
    setContentResults(NO_CONTENT_RESULTS)
  }, [])

  // The main process keeps one ripgrep child per repository, so cancelling with
  // nothing in flight is an IPC round trip that buys nothing.
  const cancelOutstanding = useCallback(() => {
    if (!outstandingRequestRef.current) return
    outstandingRequestRef.current = false
    window.repository?.cancelContentSearch()
  }, [])

  useEffect(() => {
    const requestId = contentRequestRef.current + 1
    contentRequestRef.current = requestId
    if (query.trim().length < CONTENT_SEARCH_MIN_QUERY_LENGTH) {
      previousScheduledQueryRef.current = query
      pendingSearchRef.current = null
      setContentResults(NO_CONTENT_RESULTS)
      setSearchingContent(false)
      cancelOutstanding()
      publishSearchResults(EMPTY_SEARCH_RESULTS)
      return
    }

    if (!hasSnapshot) return

    setContentResults(NO_CONTENT_RESULTS)
    setSearchingContent(true)
    cancelOutstanding()
    const delay = contentSearchDelay(previousScheduledQueryRef.current, query, isPathLikeQuery(query))
    previousScheduledQueryRef.current = query
    const dispatch = (): void => {
      pendingSearchRef.current = null
      outstandingRequestRef.current = true
      void requireRepositoryApi()
        .searchContent(query)
        .then((results) => {
          if (contentRequestRef.current !== requestId) return
          setContentResults(results)
          publishSearchResults({ query, results })
        })
        .catch((searchError: unknown) => {
          if (contentRequestRef.current === requestId) onError(getErrorMessage(searchError))
        })
        .finally(() => {
          if (contentRequestRef.current !== requestId) return
          outstandingRequestRef.current = false
          setSearchingContent(false)
        })
    }
    const timeout = window.setTimeout(dispatch, delay)
    pendingSearchRef.current = () => {
      window.clearTimeout(timeout)
      dispatch()
    }
    return () => {
      window.clearTimeout(timeout)
      pendingSearchRef.current = null
    }
  }, [cancelOutstanding, hasSnapshot, onError, query])

  const flushContentSearch = useCallback(() => {
    pendingSearchRef.current?.()
  }, [])

  // Closing the palette unmounts this hook; the markers it put in the diff go with it.
  useEffect(() => () => {
    contentRequestRef.current += 1
    pendingSearchRef.current = null
    cancelOutstanding()
    clearSearchResults()
  }, [cancelOutstanding])

  return useMemo(() => ({
    query,
    fileResults,
    contentResults,
    searchingContent,
    changeQuery,
    flushContentSearch
  }), [changeQuery, contentResults, fileResults, flushContentSearch, query, searchingContent])
}
