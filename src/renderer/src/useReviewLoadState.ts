import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CodeViewItem } from '@pierre/diffs'

import type { OmittedDiffFile, RepositoryChangeEvent, RepositoryReview } from '../../shared/contracts'
import { COMPARISON_FETCH_CONCURRENCY } from './diffWorkerConfig'
import type { ReviewAnnotationMetadata } from './ReviewComments'
import {
  createPatchReviewItems,
  createReviewItem,
  mergeReviewItems,
  orderReviewItems,
  pathFromReviewItemId as pathFromItemId,
  retainReviewItems,
  reviewItemId as itemId
} from './reviewItems'
import { resetReviewFileMetrics, setLoadedReviewItemCount } from './reviewMetrics'
import { worldViewCache } from './worldViewCache'

export interface ReviewLoadState {
  items: CodeViewItem<ReviewAnnotationMetadata>[]
  loadedPaths: Set<string>
  omittedFiles: OmittedDiffFile[]
  failedCount: number
  skippedCount: number
  paged: boolean
}

const EMPTY_LOAD_STATE: ReviewLoadState = {
  items: [],
  loadedPaths: new Set(),
  omittedFiles: [],
  failedCount: 0,
  skippedCount: 0,
  paged: false
}

export const FOLDER_REVIEW_PAGE_SIZE = 50

// A streamed pull request review whose fetch dies mid-flight leaves
// `expectedFileCount` above what actually arrived, and `loading` then stays true
// for the rest of the session: permanent spinner, no scroll restore, no pill.
// The fetch collapses the count on both of its own exits, so this only has to
// cover the case where neither runs.
export const STREAM_STALL_MS = 25_000

export interface ReviewProgressInput {
  /** Expected file count while a review is still streaming; null when there is none. */
  streamingFileCount: number | null
  /** Files the streamed review has actually delivered so far. */
  streamedFileCount: number
  /** True once the stream has gone quiet for longer than the stall window. */
  streamStalled: boolean
  hasExternalReview: boolean
  loadedPathCount: number
  stablePathCount: number
  paged: boolean
  loadLimit: number
}

export interface ReviewProgress {
  loading: boolean
  targetPathCount: number
}

export function reviewProgress({
  streamingFileCount,
  streamedFileCount,
  streamStalled,
  hasExternalReview,
  loadedPathCount,
  stablePathCount,
  paged,
  loadLimit
}: ReviewProgressInput): ReviewProgress {
  // A streamed review knows how many files to expect before it has them, so the
  // count it is climbing towards is that total, not what has arrived.
  const targetPathCount = streamingFileCount != null
    ? Math.max(streamingFileCount, stablePathCount)
    : paged
      ? Math.min(loadLimit, stablePathCount)
      : stablePathCount
  const loading = !hasExternalReview
    ? loadedPathCount < targetPathCount
    : streamingFileCount != null && !streamStalled && streamedFileCount < streamingFileCount
  return { loading, targetPathCount }
}

interface ParsedPatchCache {
  key: string
  length: number
  /** The bytes immediately before `length`, i.e. the seam an append slices from. */
  tail: string
  items: CodeViewItem<ReviewAnnotationMetadata>[]
}

export interface ParsedPatchPageCache {
  key: string
  pageRefs: readonly string[]
  items: CodeViewItem<ReviewAnnotationMetadata>[]
}

const PATCH_SEAM_SAMPLE = 4_096

function patchSeam(patch: string): string {
  return patch.length <= PATCH_SEAM_SAMPLE ? patch : patch.slice(patch.length - PATCH_SEAM_SAMPLE)
}

/**
 * Whether the incremental tail parse can trust `parsed.length` as an offset into
 * `patch`. Comparing lengths alone assumed the stream can only ever append: a page
 * re-emitted with different bytes would have been sliced mid-hunk and parsed into
 * silently wrong items, so the seam the slice starts at is checked too.
 */
export function canAppendPatch(
  parsed: Pick<ParsedPatchCache, 'key' | 'length' | 'tail'>,
  key: string,
  patch: string
): boolean {
  return parsed.key === key
    && patch.length >= parsed.length
    && patch.startsWith(parsed.tail, parsed.length - parsed.tail.length)
}

export function canAppendPatchPages(
  parsed: Pick<ParsedPatchPageCache, 'key' | 'pageRefs'>,
  key: string,
  pages: readonly string[]
): boolean {
  return parsed.key === key
    && pages.length >= parsed.pageRefs.length
    && parsed.pageRefs.every((page, index) => pages[index] === page)
}

function emptyParsedPatch(): ParsedPatchCache {
  return { key: '', length: 0, tail: '', items: [] }
}

function emptyParsedPages(): ParsedPatchPageCache {
  return { key: '', pageRefs: [], items: [] }
}

function seedParsedCache(worldId: string | null): {
  string: ParsedPatchCache
  pages: ParsedPatchPageCache
} {
  const cached = worldId == null ? undefined : worldViewCache.get(worldId)?.parsed
  if (cached?.kind === 'pages') {
    return {
      pages: { key: cached.parseKey, pageRefs: cached.pageRefs, items: cached.items },
      string: emptyParsedPatch()
    }
  }
  if (cached?.kind === 'string') {
    return {
      string: {
        key: cached.parseKey,
        length: cached.patchLength,
        tail: cached.tail,
        items: cached.items
      },
      pages: emptyParsedPages()
    }
  }
  return { string: emptyParsedPatch(), pages: emptyParsedPages() }
}

export function parsePatchPageBatch(
  parsed: ParsedPatchPageCache,
  key: string,
  pages: readonly string[]
): ParsedPatchPageCache {
  const appended = canAppendPatchPages(parsed, key, pages)
  const firstPendingPage = appended ? parsed.pageRefs.length : 0
  const pendingItems = pages.slice(firstPendingPage).flatMap((page, offset) => page === ''
    ? []
    : createPatchReviewItems<ReviewAnnotationMetadata>(page, `${key}:page:${firstPendingPage + offset}`))
  return {
    key,
    pageRefs: [...pages],
    items: appended ? mergeReviewItems(parsed.items, pendingItems) : pendingItems
  }
}

type ExternalReviewItems = {
  kind: 'string'
  cache: ParsedPatchCache
  items: CodeViewItem<ReviewAnnotationMetadata>[]
} | {
  kind: 'pages'
  cache: ParsedPatchPageCache
  items: CodeViewItem<ReviewAnnotationMetadata>[]
}

interface ReviewLoadStateOptions {
  pathsKey: string
  stablePaths: string[]
  repositoryReview: RepositoryReview | null
  repositoryChange: RepositoryChangeEvent | null
  worldId?: string | null
}

interface ReviewLoadStateApi {
  loadState: ReviewLoadState
  loading: boolean
  targetPathCount: number
  loadMoreFiles(): void
}

export function reviewLoadStateFromExternalItems(
  items: CodeViewItem<ReviewAnnotationMetadata>[],
  stablePaths: readonly string[],
  omittedFiles: ReviewLoadState['omittedFiles']
): ReviewLoadState {
  return {
    items,
    loadedPaths: new Set(stablePaths),
    omittedFiles,
    failedCount: 0,
    skippedCount: Math.max(0, stablePaths.length - items.length - omittedFiles.length),
    paged: false
  }
}

export function useReviewLoadState({
  pathsKey,
  stablePaths,
  repositoryReview,
  repositoryChange,
  worldId = null
}: ReviewLoadStateOptions): ReviewLoadStateApi {
  const loadedPathsKeyRef = useRef<string | null>(null)
  const loadedPageCountRef = useRef(0)
  const [folderLoadState, setFolderLoadState] = useState<ReviewLoadState>(EMPTY_LOAD_STATE)
  const [pagination, setPagination] = useState({ key: '', limit: FOLDER_REVIEW_PAGE_SIZE })
  const loadLimit = pagination.key === pathsKey ? pagination.limit : FOLDER_REVIEW_PAGE_SIZE
  const streamingFileCount = repositoryReview?.expectedFileCount ?? null
  const streamedFileCount = repositoryReview?.files.length ?? 0
  // The key moves whenever the stream makes progress, which restarts the timer;
  // it only fires when nothing has arrived for the whole window.
  const streamKey = repositoryReview == null || streamingFileCount == null
    ? null
    : `${repositoryReview.kind === 'github' ? repositoryReview.selector : repositoryReview.id}:${streamedFileCount}:${streamingFileCount}`
  const [stalledStreamKey, setStalledStreamKey] = useState<string | null>(null)
  const streamStalled = streamKey != null && stalledStreamKey === streamKey

  const loadMoreFiles = useCallback(() => {
    setPagination({ key: pathsKey, limit: loadLimit + FOLDER_REVIEW_PAGE_SIZE })
  }, [loadLimit, pathsKey])

  // Streaming appends to the patch, so only the new tail is parsed. Re-parsing the
  // whole document on every page turned a 13 MB review into quadratic work.
  const parsedPatchRef = useRef<ParsedPatchCache>({ key: '', length: 0, tail: '', items: [] })
  const parsedPatchPagesRef = useRef<ParsedPatchPageCache>({ key: '', pageRefs: [], items: [] })
  const parsedWorldIdRef = useRef(worldId)
  const externalReview = useMemo<ExternalReviewItems | null>(() => {
    if (repositoryReview == null) return null
    const key = repositoryReview.kind === 'github'
      ? `pr-${repositoryReview.pullRequest.number}-${repositoryReview.pullRequest.updatedAt}`
      : repositoryReview.id
    const seeded = parsedWorldIdRef.current !== worldId ? seedParsedCache(worldId) : null
    if (repositoryReview.patchPages != null) {
      const pagesBase = seeded?.pages ?? parsedPatchPagesRef.current
      if (
        pagesBase.key === key
        && pagesBase.pageRefs.length === repositoryReview.patchPages.length
        && pagesBase.pageRefs.every((page, index) => page === repositoryReview.patchPages?.[index])
      ) {
        return { kind: 'pages', cache: pagesBase, items: pagesBase.items }
      }
      const cache = parsePatchPageBatch(pagesBase, key, repositoryReview.patchPages)
      return {
        kind: 'pages',
        cache,
        items: orderReviewItems(cache.items, stablePaths)
      }
    }
    const parsed = seeded?.string ?? parsedPatchRef.current
    if (parsed.key === key && parsed.length === repositoryReview.patch.length && parsed.items.length > 0) {
      return {
        kind: 'string',
        cache: parsed,
        items: parsed.items
      }
    }
    const appended = canAppendPatch(parsed, key, repositoryReview.patch)
    const pending = appended ? repositoryReview.patch.slice(parsed.length) : repositoryReview.patch
    const pendingItems = pending === ''
      ? []
      : createPatchReviewItems<ReviewAnnotationMetadata>(pending, key)
    // Merging by id keeps this idempotent, so a repeated render cannot duplicate a
    // file or lose one.
    const items = appended ? mergeReviewItems(parsed.items, pendingItems) : pendingItems
    return {
      kind: 'string',
      cache: {
        key,
        length: repositoryReview.patch.length,
        tail: patchSeam(repositoryReview.patch),
        items
      },
      items: orderReviewItems(items, stablePaths)
    }
  }, [repositoryReview, stablePaths, worldId])
  useEffect(() => {
    parsedWorldIdRef.current = worldId
    if (externalReview?.kind === 'pages') {
      const cache = { ...externalReview.cache, items: externalReview.items }
      parsedPatchPagesRef.current = cache
      if (worldId != null) {
        worldViewCache.rememberParsed(worldId, {
          kind: 'pages',
          parseKey: cache.key,
          pageRefs: cache.pageRefs,
          items: cache.items
        })
      }
    } else if (externalReview?.kind === 'string') {
      const cache = { ...externalReview.cache, items: externalReview.items }
      parsedPatchRef.current = cache
      if (worldId != null) {
        worldViewCache.rememberParsed(worldId, {
          kind: 'string',
          parseKey: cache.key,
          patchLength: cache.length,
          tail: cache.tail,
          items: cache.items
        })
      }
    }
  }, [externalReview, worldId])
  const externalReviewItems = externalReview?.items ?? null
  const externalLoadState = useMemo(() => {
    if (externalReviewItems == null) return null
    return reviewLoadStateFromExternalItems(
      externalReviewItems,
      stablePaths,
      repositoryReview?.omittedFiles ?? []
    )
  }, [externalReviewItems, repositoryReview, stablePaths])
  const loadState = externalLoadState ?? folderLoadState
  const { loading, targetPathCount } = reviewProgress({
    streamingFileCount,
    streamedFileCount,
    streamStalled,
    hasExternalReview: repositoryReview != null,
    loadedPathCount: loadState.loadedPaths.size,
    stablePathCount: stablePaths.length,
    paged: loadState.paged,
    loadLimit
  })

  useEffect(() => {
    if (streamKey == null || !loading) return
    const timer = setTimeout(() => setStalledStreamKey(streamKey), STREAM_STALL_MS)
    return () => clearTimeout(timer)
  }, [loading, streamKey])

  useEffect(() => {
    let cancelled = false
    let stopProgress: (() => void) | undefined
    if (externalReviewItems != null) return
    const isNewPathSet = loadedPathsKeyRef.current !== pathsKey
    loadedPathsKeyRef.current = pathsKey
    if (isNewPathSet) {
      loadedPageCountRef.current = 0
      // Whatever is on screen stays there while the new patch is fetched. Emptying
      // the list dropped the viewer to its loading state, and returning from that
      // remounted it — the reader lost their scroll position and every file had to
      // be highlighted again, on every `git add` and every new untracked file.
      setFolderLoadState((current) => current.items.length === 0
        ? EMPTY_LOAD_STATE
        : { ...EMPTY_LOAD_STATE, items: retainReviewItems(current.items, stablePaths) })
    }

    async function loadComparisons(): Promise<void> {
      const repository = window.repository
      if (repository == null) {
        setFolderLoadState({
          ...EMPTY_LOAD_STATE,
          loadedPaths: new Set(stablePaths),
          failedCount: stablePaths.length
        })
        return
      }

      if (isNewPathSet) {
        const requestId = crypto.randomUUID()
        let streamed = false
        stopProgress = repository.onLocalReviewProgress?.((progress) => {
          if (cancelled || progress.requestId !== requestId || progress.kind !== 'files') return
          streamed = true
          const incoming = progress.patch === ''
            ? []
            : createPatchReviewItems<ReviewAnnotationMetadata>(progress.patch, `working-tree-${requestId}`)
          startTransition(() => {
            setFolderLoadState((current) => {
              const omittedFiles = [...current.omittedFiles, ...progress.omittedFiles]
              const loadedPaths = new Set(current.loadedPaths)
              for (const item of incoming) loadedPaths.add(pathFromItemId(item.id))
              for (const file of progress.omittedFiles) loadedPaths.add(file.path)
              return {
                items: orderReviewItems(mergeReviewItems(current.items, incoming), stablePaths),
                loadedPaths,
                omittedFiles,
                failedCount: 0,
                skippedCount: Math.max(0, stablePaths.length - loadedPaths.size),
                paged: false
              }
            })
          })
        })
        try {
          const workingTreePatch = await repository.getWorkingTreePatch(stablePaths, requestId)
          if (cancelled) return
          if (streamed) {
            setFolderLoadState((current) => {
              const items = current.items.length > 0
                ? orderReviewItems(current.items, stablePaths)
                : orderReviewItems(createPatchReviewItems<ReviewAnnotationMetadata>(
                  workingTreePatch.patch,
                  `working-tree-${requestId}`
                ), stablePaths)
              return {
                items,
                loadedPaths: new Set(stablePaths),
                omittedFiles: workingTreePatch.omittedFiles,
                failedCount: 0,
                skippedCount: Math.max(
                  0,
                  stablePaths.length - items.length - workingTreePatch.omittedFiles.length
                ),
                paged: false
              }
            })
            return
          }
          const items = orderReviewItems(createPatchReviewItems<ReviewAnnotationMetadata>(
            workingTreePatch.patch,
            `working-tree-${requestId}`
          ), stablePaths)
          if (items.length > 0 || stablePaths.length === 0) {
            setFolderLoadState({
              items,
              loadedPaths: new Set(stablePaths),
              omittedFiles: workingTreePatch.omittedFiles,
              failedCount: 0,
              skippedCount: Math.max(
                0,
                stablePaths.length - items.length - workingTreePatch.omittedFiles.length
              ),
              paged: false
            })
            return
          }
        } catch {
          // A plain folder has no Git patch. Load its files through the paged fallback below.
        } finally {
          stopProgress?.()
        }
      }

      const pageStart = loadedPageCountRef.current
      const pagedPaths = stablePaths.slice(pageStart, loadLimit)
      for (let start = 0; start < pagedPaths.length && !cancelled; start += COMPARISON_FETCH_CONCURRENCY) {
        const batchPaths = pagedPaths.slice(start, start + COMPARISON_FETCH_CONCURRENCY)
        const results = await Promise.all(batchPaths.map(async (path) => {
          try {
            const item = createReviewItem<ReviewAnnotationMetadata>(await repository.getComparison(path))
            return { path, item, failed: false }
          } catch {
            return { path, item: null, failed: true }
          }
        }))
        if (cancelled) return
        loadedPageCountRef.current = pageStart + start + batchPaths.length

        startTransition(() => {
          setFolderLoadState((current) => {
            const loadedPaths = new Set(current.loadedPaths)
            const incomingItems: CodeViewItem<ReviewAnnotationMetadata>[] = []
            let failedCount = current.failedCount
            let skippedCount = current.skippedCount

            for (const result of results) {
              loadedPaths.add(result.path)
              if (result.failed) failedCount += 1
              else if (result.item == null) skippedCount += 1
              else incomingItems.push(result.item)
            }

            return {
              ...current,
              items: mergeReviewItems(current.items, incomingItems),
              loadedPaths,
              failedCount,
              skippedCount,
              paged: true
            }
          })
        })
      }
    }

    let loaded = false
    void loadComparisons().then(() => { loaded = true })
    return () => {
      cancelled = true
      stopProgress?.()
      // An interrupted first pass must not look like a completed one to the next run.
      if (isNewPathSet && !loaded) loadedPathsKeyRef.current = null
    }
  }, [externalReviewItems, loadLimit, pathsKey, repositoryReview, stablePaths])

  useEffect(() => {
    if (externalReviewItems != null || repositoryChange == null) return
    const visiblePaths = new Set(stablePaths)
    const pathsToReload = repositoryChange.changedPaths.filter((path) => visiblePaths.has(path))
    if (pathsToReload.length === 0) return
    let cancelled = false

    void (async () => {
      try {
        const workingTreePatch = await window.repository!.getWorkingTreePatch(pathsToReload)
        const patchItems = createPatchReviewItems<ReviewAnnotationMetadata>(
          workingTreePatch.patch,
          `working-tree-${repositoryChange.revision}`
        )
        const byPath = new Map(patchItems.map((item) => [pathFromItemId(item.id), item]))
        return pathsToReload.map((path) => ({ path, item: byPath.get(path) ?? null }))
      } catch {
        return Promise.all(pathsToReload.map(async (path) => {
          try {
            return { path, item: createReviewItem<ReviewAnnotationMetadata>(await window.repository!.getComparison(path)) }
          } catch {
            return { path, item: null }
          }
        }))
      }
    })().then((results) => {
      if (cancelled) return
      startTransition(() => {
        setFolderLoadState((current) => {
          const replacements = new Map(results.map((result) => [itemId(result.path), result.item]))
          const nextItems = current.items.flatMap((item) => {
            if (!replacements.has(item.id)) return [item]
            const replacement = replacements.get(item.id)
            replacements.delete(item.id)
            return replacement == null ? [] : [replacement]
          })
          for (const replacement of replacements.values()) {
            if (replacement != null) nextItems.push(replacement)
          }
          return { ...current, items: orderReviewItems(mergeReviewItems([], nextItems), stablePaths) }
        })
      })
    })

    return () => { cancelled = true }
  }, [externalReviewItems, repositoryChange, stablePaths])

  useEffect(() => {
    resetReviewFileMetrics()
    return resetReviewFileMetrics
  }, [])

  useEffect(() => {
    setLoadedReviewItemCount(loadState.items.length)
  }, [loadState.items])

  return { loadState, loading, targetPathCount, loadMoreFiles }
}
