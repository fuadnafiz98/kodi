import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { hydratePartialDiff, type CodeViewItem } from '@pierre/diffs'
import { useWorkerPool } from '@pierre/diffs/react'

import { COMMAND_ABORTED_MESSAGE, type OmittedDiffFile, type RepositoryChangeEvent, type RepositoryReview } from '../../../shared/contracts'
import { COMPARISON_FETCH_CONCURRENCY } from '../diff/diffWorkerConfig'
import type { ReviewAnnotationMetadata } from './ReviewComments'
import {
  AUTO_HYDRATE_MAX_LINES,
  canAutoHydrate,
  exceedsLineLimit,
  isReviewItemRendered,
  loadPartialDiffFiles
} from './partialDiffHydration'
import {
  adoptReviewDiff,
  createPatchReviewItems,
  createReviewItem,
  keepUnchangedReviewItem,
  mergeReviewItems,
  orderReviewItems,
  pathFromReviewItemId as pathFromItemId,
  primeReviewHighlights,
  retainReviewItems,
  reviewItemId as itemId
} from './reviewItems'
import { resetReviewFileMetrics, setLoadedReviewItemCount } from './reviewMetrics'
import { worldViewCache } from './worldViewCache'
import { countKodiMetric } from '../perf/kodiCounters'
import { createStreamCompletion } from './streamCompletion'

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

// A rewrite waits this long for its whole file before it swaps in as a patch.
const REWRITE_HYDRATION_TIMEOUT_MS = 300
// Below the worker's four-entry highlight cache, so a primed result is still
// there when the rewrite swaps in.
const PRIMED_REWRITES_LIMIT = 3

function exceedsHighlightBudget(item: CodeViewItem<ReviewAnnotationMetadata>): boolean {
  return item.type === 'diff'
    && Math.max(item.fileDiff.additionLines.length, item.fileDiff.deletionLines.length) > AUTO_HYDRATE_MAX_LINES
}

/**
 * A reload hands back the patch alone. Swapping it in for a file the review had
 * already hydrated shrank that file to its hunks under the reader (with folding
 * off, from the whole file to its hunks), and hydration grew it back a moment
 * later: two layout changes for one agent write, the second after the reader
 * had moved on. A rewrite on screen is hydrated before it replaces the file.
 */
async function hydrateRewrites(
  results: readonly { path: string; item: CodeViewItem<ReviewAnnotationMetadata> | null }[],
  held: readonly CodeViewItem<ReviewAnnotationMetadata>[],
  repository: Pick<NonNullable<typeof window.repository>, 'getComparison'>
): Promise<{ path: string; item: CodeViewItem<ReviewAnnotationMetadata> | null }[]> {
  const heldById = new Map(held.map((item) => [item.id, item]))
  return Promise.all(results.map(async (result) => {
    const { item } = result
    const current = item == null ? undefined : heldById.get(item.id)
    if (item?.type !== 'diff' || current?.type !== 'diff' || current.fileDiff.isPartial || !isReviewItemRendered(item.id)
      || !canAutoHydrate(item.fileDiff) || keepUnchangedReviewItem(current, item) !== item) return result
    countKodiMetric('autoHydrations')
    const hydrated = (async () => {
      const comparison = await repository.getComparison(result.path)
      if (exceedsLineLimit(comparison.oldFile?.contents) || exceedsLineLimit(comparison.newFile?.contents)) return null
      const files = await loadPartialDiffFiles(item.fileDiff, [
        { side: 'new', load: async () => comparison.newFile },
        { side: 'old', load: async () => comparison.oldFile }
      ])
      return hydratePartialDiff('clone', item.fileDiff, files)
    })().catch(() => null)
    let timer: ReturnType<typeof setTimeout> | undefined
    const fileDiff = await Promise.race([
      hydrated,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), REWRITE_HYDRATION_TIMEOUT_MS) })
    ])
    clearTimeout(timer)
    return fileDiff == null ? result : { path: result.path, item: adoptReviewDiff(item, fileDiff) }
  }))
}

// A watcher refresh aborts a working-tree patch still being built for the
// older snapshot. That is a git repository answering "ask again", not a plain
// folder with no patch: treating it as the latter fetched fifty files one by
// one, re-parsed and re-highlighted them, on every save made while a review was
// loading — the stalls a busy repository kept hitting. It keeps asking for as
// long as writes keep superseding the build: a cap of three let a patch that
// takes longer to build than the gap between writes (24k untracked files, a
// status tick every 1.5 s) fall through to 24k one-file requests.
const SUPERSEDED_PATCH_MAX_WAIT_MS = 1_000

export async function requestWorkingTreePatch(
  repository: Pick<NonNullable<Window['repository']>, 'getWorkingTreePatch'>,
  paths: readonly string[],
  requestId: string | undefined,
  isCancelled: () => boolean,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): ReturnType<NonNullable<Window['repository']>['getWorkingTreePatch']> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await repository.getWorkingTreePatch([...paths], requestId)
    } catch (error) {
      const superseded = error instanceof Error && error.message.includes(COMMAND_ABORTED_MESSAGE)
      if (!superseded || isCancelled()) throw error
      await wait(Math.min(SUPERSEDED_PATCH_MAX_WAIT_MS, 100 * (attempt + 1)))
      if (isCancelled()) throw error
    }
  }
}

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
  /**
   * The repository this review belongs to. Main otherwise answers from whichever
   * session is in front, and a tab's load that crossed a tab switch was served
   * by the other repository.
   */
  root?: string
}

/**
 * A retry after a superseded build streams its pages again under the same
 * request, so an omission can arrive twice; counted twice, it pushed the
 * skipped count past the files that were really skipped.
 */
export function appendOmittedFiles(
  current: readonly OmittedDiffFile[],
  incoming: readonly OmittedDiffFile[]
): OmittedDiffFile[] {
  if (incoming.length === 0) return current as OmittedDiffFile[]
  const known = new Set(current.map((file) => file.path))
  const next = [...current]
  for (const file of incoming) {
    if (known.has(file.path)) continue
    known.add(file.path)
    next.push(file)
  }
  return next
}

/** The patch call pinned to one repository. */
function workingTreePatchFor(
  repository: NonNullable<Window['repository']>,
  root: string | undefined
): Pick<NonNullable<Window['repository']>, 'getWorkingTreePatch'> {
  return { getWorkingTreePatch: (paths, requestId) => repository.getWorkingTreePatch(paths, requestId, root) }
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
  worldId = null,
  root
}: ReviewLoadStateOptions): ReviewLoadStateApi {
  const loadedPathsKeyRef = useRef<string | null>(null)
  const loadedPageCountRef = useRef(0)
  // Whether the current path set was served by the working-tree patch. Once it
  // was, a rerun for the same paths (a new `stablePaths` identity, a status
  // change) has nothing to page: falling through fetched fifty comparisons one
  // by one and switched a git review into the folder's paged mode.
  const servedByPatchRef = useRef(false)
  // The paths the last working-tree patch delivered. A path set that only grew
  // (a save made another file dirty, a new file) fetches the newcomers alone:
  // refetching and re-parsing every file on each of those ticks was a long task
  // per save on a large review. Content changes to the files already held come
  // through the change event below, not through a path-set change.
  const servedPathsRef = useRef<ReadonlySet<string>>(new Set())
  const [folderLoadState, setFolderLoadState] = useState<ReviewLoadState>(EMPTY_LOAD_STATE)
  const workerPool = useWorkerPool()
  const pendingReloadPathsRef = useRef(new Set<string>())
  // What the review holds now, for a reload to tell rewritten files from rewrites
  // that changed nothing.
  const heldItemsRef = useRef<readonly CodeViewItem<ReviewAnnotationMetadata>[]>([])
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
  // Keyed on the omitted files rather than the review: a review rebuilt around
  // the same patch would otherwise mint a new load state and path Set.
  const externalOmittedFiles = repositoryReview?.omittedFiles
  const externalLoadState = useMemo(() => {
    if (externalReviewItems == null) return null
    return reviewLoadStateFromExternalItems(
      externalReviewItems,
      stablePaths,
      externalOmittedFiles ?? []
    )
  }, [externalOmittedFiles, externalReviewItems, stablePaths])
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
    if (!isNewPathSet && servedByPatchRef.current) return
    const heldPaths = isNewPathSet && servedByPatchRef.current ? servedPathsRef.current : null
    const requestPaths = heldPaths == null ? stablePaths : stablePaths.filter((path) => !heldPaths.has(path))
    const partial = requestPaths.length < stablePaths.length
    if (isNewPathSet) {
      loadedPageCountRef.current = 0
      servedByPatchRef.current = false
      const stableSet = new Set(stablePaths)
      // Whatever is on screen stays there while the new patch is fetched. Emptying
      // the list dropped the viewer to its loading state, and returning from that
      // remounted it — the reader lost their scroll position and every file had to
      // be highlighted again, on every `git add` and every new untracked file.
      setFolderLoadState((current) => current.items.length === 0 && !partial
        ? EMPTY_LOAD_STATE
        : {
          ...EMPTY_LOAD_STATE,
          items: retainReviewItems(current.items, stablePaths),
          omittedFiles: partial ? current.omittedFiles.filter((file) => stableSet.has(file.path)) : []
        })
    }
    const servedAll = (): void => {
      servedByPatchRef.current = true
      servedPathsRef.current = new Set(stablePaths)
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

      if (isNewPathSet && requestPaths.length === 0) {
        // Paths only left the review; the retained items are the whole answer.
        servedAll()
        setFolderLoadState((current) => ({
          ...current,
          loadedPaths: new Set(stablePaths),
          failedCount: 0,
          skippedCount: Math.max(0, stablePaths.length - current.items.length - current.omittedFiles.length),
          paged: false
        }))
        return
      }
      if (isNewPathSet) {
        const requestId = crypto.randomUUID()
        let streamed = false
        const completion = createStreamCompletion()
        stopProgress = repository.onLocalReviewProgress?.((progress) => {
          if (cancelled || progress.requestId !== requestId) return
          if (progress.kind === 'done') {
            completion.markDone()
            return
          }
          if (progress.kind !== 'files') return
          streamed = true
          const incoming = progress.patch === ''
            ? []
            : createPatchReviewItems<ReviewAnnotationMetadata>(progress.patch, `working-tree-${requestId}`)
          startTransition(() => {
            setFolderLoadState((current) => {
              const omittedFiles = appendOmittedFiles(current.omittedFiles, progress.omittedFiles)
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
          const workingTreePatch = await requestWorkingTreePatch(workingTreePatchFor(repository, root), requestPaths, requestId,
            () => cancelled)
          if (cancelled) return
          // The reply can overtake the pages sent before it (see streamCompletion).
          if (stopProgress != null) await completion.wait()
          if (cancelled) return
          if (streamed) {
            servedAll()
            setFolderLoadState((current) => {
              const items = current.items.length > 0
                ? orderReviewItems(current.items, stablePaths)
                : orderReviewItems(createPatchReviewItems<ReviewAnnotationMetadata>(
                  workingTreePatch.patch,
                  `working-tree-${requestId}`
                ), stablePaths)
              // The stream appended the newcomers' omissions as they arrived.
              const omittedFiles = partial ? current.omittedFiles : workingTreePatch.omittedFiles
              return {
                items,
                loadedPaths: new Set(stablePaths),
                omittedFiles,
                failedCount: 0,
                skippedCount: Math.max(0, stablePaths.length - items.length - omittedFiles.length),
                paged: false
              }
            })
            return
          }
          const parsed = createPatchReviewItems<ReviewAnnotationMetadata>(
            workingTreePatch.patch,
            `working-tree-${requestId}`
          )
          if (parsed.length > 0 || requestPaths.length === 0 || partial) {
            servedAll()
            setFolderLoadState((current) => {
              const items = orderReviewItems(mergeReviewItems(current.items, parsed), stablePaths)
              const omittedFiles = partial
                ? appendOmittedFiles(current.omittedFiles, workingTreePatch.omittedFiles)
                : workingTreePatch.omittedFiles
              return {
                items,
                loadedPaths: new Set(stablePaths),
                omittedFiles,
                failedCount: 0,
                skippedCount: Math.max(0, stablePaths.length - items.length - omittedFiles.length),
                paged: false
              }
            })
            return
          }
          countKodiMetric('reviewPagedFallbacks', `empty patch for ${stablePaths.length} paths`)
        } catch (error) {
          // A plain folder has no Git patch. Load its files through the paged fallback below.
          countKodiMetric('reviewPagedFallbacks', `patch failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          stopProgress?.()
        }
      } else {
        countKodiMetric('reviewPagedFallbacks', `rerun for the same ${stablePaths.length} paths, page ${loadedPageCountRef.current}, limit ${loadLimit}`)
      }

      const pageStart = loadedPageCountRef.current
      const pagedPaths = stablePaths.slice(pageStart, loadLimit)
      for (let start = 0; start < pagedPaths.length && !cancelled; start += COMPARISON_FETCH_CONCURRENCY) {
        const batchPaths = pagedPaths.slice(start, start + COMPARISON_FETCH_CONCURRENCY)
        const results = await Promise.all(batchPaths.map(async (path) => {
          try {
            countKodiMetric('comparisonRequests')
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
  }, [externalReviewItems, loadLimit, pathsKey, repositoryReview, root, stablePaths])

  useEffect(() => {
    if (externalReviewItems != null || repositoryChange == null) return
    const visiblePaths = new Set(stablePaths)
    // A newer change cancels this run; whatever it had not committed yet rides
    // along with the next one instead of staying stale until its next write.
    const pending = pendingReloadPathsRef.current
    for (const path of repositoryChange.changedPaths) pending.add(path)
    const pathsToReload = [...pending].filter((path) => visiblePaths.has(path))
    if (pathsToReload.length === 0) return
    let cancelled = false

    void (async () => {
      try {
        const workingTreePatch = await requestWorkingTreePatch(workingTreePatchFor(window.repository!, root), pathsToReload,
          undefined, () => cancelled)
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
    })().then(async (fetched) => {
      if (cancelled) return
      const results = await hydrateRewrites(fetched, heldItemsRef.current, window.repository!)
      if (cancelled) return
      // Only what the reader can see: the worker highlights one file at a time
      // and caches four, so offscreen rewrites only queued ahead of the visible one.
      const onScreen = results.flatMap((result) => result.item != null && isReviewItemRendered(result.item.id)
        && !exceedsHighlightBudget(result.item) ? [result.item] : []).slice(0, PRIMED_REWRITES_LIMIT)
      await primeReviewHighlights(workerPool, onScreen, heldItemsRef.current)
      if (cancelled) return
      for (const path of pathsToReload) pending.delete(path)
      startTransition(() => {
        setFolderLoadState((current) => {
          const replacements = new Map(results.map((result) => [itemId(result.path), result.item]))
          const nextItems = current.items.flatMap((item) => {
            if (!replacements.has(item.id)) return [item]
            const replacement = replacements.get(item.id)
            replacements.delete(item.id)
            return replacement == null ? [] : [keepUnchangedReviewItem(item, replacement)]
          })
          for (const replacement of replacements.values()) {
            if (replacement != null) nextItems.push(replacement)
          }
          return { ...current, items: orderReviewItems(mergeReviewItems([], nextItems), stablePaths) }
        })
      })
    })

    return () => { cancelled = true }
  }, [externalReviewItems, repositoryChange, root, stablePaths, workerPool])

  useEffect(() => {
    resetReviewFileMetrics()
    return resetReviewFileMetrics
  }, [])

  useEffect(() => {
    heldItemsRef.current = loadState.items
    setLoadedReviewItemCount(loadState.items.length)
  }, [loadState.items])

  return { loadState, loading, targetPathCount, loadMoreFiles }
}
