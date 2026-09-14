export type SearchEntryKind = 'file' | 'dir'

export interface IndexedPath {
  path: string
  normalizedPath: string
  kind: SearchEntryKind
}

export interface RankedPath {
  path: string
  kind: SearchEntryKind
}

export interface FileRankingOptions {
  limit?: number
  /** Changed or under-review paths, ranked ahead of equally good matches. */
  priorityPaths?: ReadonlySet<string>
  /** Most-recently-opened files for this root, newest first. */
  recentPaths?: readonly string[]
}

interface ScoredPath {
  entry: IndexedPath
  score: number
  priority: boolean
}

function fuzzyPathScore(path: IndexedPath, normalizedQuery: string): number | null {
  const { normalizedPath } = path

  const directIndex = normalizedPath.indexOf(normalizedQuery)
  if (directIndex >= 0) {
    const filename = normalizedPath.slice(normalizedPath.lastIndexOf('/') + 1)
    if (filename.startsWith(normalizedQuery)) {
      return -100 + (filename.length - normalizedQuery.length) / 1_000 + path.path.length / 1_000_000
    }
    return directIndex + path.path.length / 1_000
  }

  let pathIndex = 0
  let score = 0
  let previousMatch = -2
  for (const queryCharacter of normalizedQuery) {
    const matchIndex = normalizedPath.indexOf(queryCharacter, pathIndex)
    if (matchIndex < 0) return null
    score += matchIndex === previousMatch + 1 ? 1 : 8
    score += matchIndex / 100
    previousMatch = matchIndex
    pathIndex = matchIndex + 1
  }
  return score
}

function compareScoredPaths(left: ScoredPath, right: ScoredPath): number {
  if (left.priority !== right.priority) return left.priority ? -1 : 1
  if (left.score !== right.score) return left.score - right.score
  const leftPath = left.entry.path
  const rightPath = right.entry.path
  return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
}

function addScoredPath(heap: ScoredPath[], candidate: ScoredPath, limit: number): void {
  if (heap.length < limit) {
    heap.push(candidate)
    let index = heap.length - 1
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2)
      const parent = heap[parentIndex]!
      const current = heap[index]!
      if (compareScoredPaths(parent, current) >= 0) break
      heap[parentIndex] = current
      heap[index] = parent
      index = parentIndex
    }
    return
  }
  if (compareScoredPaths(candidate, heap[0]!) >= 0) return

  heap[0] = candidate
  let index = 0
  while (true) {
    const leftIndex = index * 2 + 1
    const rightIndex = leftIndex + 1
    let worstIndex = index
    if (leftIndex < heap.length && compareScoredPaths(heap[leftIndex]!, heap[worstIndex]!) > 0) worstIndex = leftIndex
    if (rightIndex < heap.length && compareScoredPaths(heap[rightIndex]!, heap[worstIndex]!) > 0) worstIndex = rightIndex
    if (worstIndex === index) break
    const current = heap[index]!
    heap[index] = heap[worstIndex]!
    heap[worstIndex] = current
    index = worstIndex
  }
}

// A folder row is worth offering, but "go to file" is what the reader asked for:
// a directory only outranks a file when no file matched nearly as well. One point
// is larger than every tie-break term in fuzzyPathScore and smaller than the gap
// between match classes, so it reorders near-ties and nothing else.
const DIRECTORY_SCORE_PENALTY = 1

const NOISY_SEARCH_DIRECTORY = /(?:^|\/)(?:\.venv|venv|__pycache__|site-packages|\.mypy_cache|\.pytest_cache|\.ruff_cache|\.tox|\.nox|\.eggs)(?:\/|$)/
const NOISY_SEARCH_EXTENSION = /\.(?:pyc|pyd|pyo)$/i

export function isNoisySearchPath(path: string): boolean {
  return NOISY_SEARCH_DIRECTORY.test(path) || NOISY_SEARCH_EXTENSION.test(path)
}

// A snapshot's path array is retained across watcher ticks that change nothing,
// and the palette rebuilds its index on every open. One slot is enough to make
// reopening the palette free on a 20k-path repository.
let cachedIndexInput: readonly string[] | null = null
let cachedIndex: IndexedPath[] = []
let indexBuilds = 0

export function createFileSearchIndex(paths: readonly string[]): IndexedPath[] {
  if (paths === cachedIndexInput) return cachedIndex
  indexBuilds += 1
  const indexed: IndexedPath[] = []
  const directories = new Set<string>()
  for (const path of paths) {
    if (isNoisySearchPath(path)) continue
    indexed.push({ path, normalizedPath: path.toLowerCase(), kind: 'file' })
    for (let slash = path.indexOf('/'); slash > 0; slash = path.indexOf('/', slash + 1)) {
      directories.add(path.slice(0, slash))
    }
  }
  for (const directory of directories) {
    indexed.push({ path: directory, normalizedPath: directory.toLowerCase(), kind: 'dir' })
  }
  cachedIndexInput = paths
  cachedIndex = indexed
  return indexed
}

/** Whether `createFileSearchIndex(paths)` would answer without building anything. */
export function isFileSearchIndexWarm(paths: readonly string[]): boolean {
  return paths === cachedIndexInput
}

/**
 * How many indexes have actually been built. The number the palette cares about
 * is the one that does not move: an index built on the frame Cmd+P was pressed
 * is 3,000 strings lowercased inside a keystroke.
 */
export function fileSearchIndexBuilds(): number {
  return indexBuilds
}

// Long enough that the build waits for a genuinely idle moment during boot,
// short enough that it is done before a reader can reach for Cmd+P.
const WARM_INDEX_TIMEOUT_MS = 1_000

const NOTHING_TO_CANCEL = (): void => {}

/**
 * Builds the index for a new path list while the reader is doing something else,
 * so opening the palette is a cache lookup rather than a walk over every path in
 * the repository. Safe to call on every snapshot: an already-indexed array is a
 * no-op. Returns the canceller, which is also an effect cleanup.
 */
export function warmFileSearchIndex(paths: readonly string[] | null | undefined): () => void {
  if (paths == null || paths === cachedIndexInput) return NOTHING_TO_CANCEL
  const build = (): void => {
    createFileSearchIndex(paths)
  }
  if (typeof window.requestIdleCallback !== 'function') {
    const timeout = window.setTimeout(build, 0)
    return () => window.clearTimeout(timeout)
  }
  const handle = window.requestIdleCallback(build, { timeout: WARM_INDEX_TIMEOUT_MS })
  return () => window.cancelIdleCallback(handle)
}

/**
 * What the palette offers before a single character is typed: the files this
 * reader was last in, then what the working tree or the review changed, then the
 * top-level folders, then the tree itself. Ordering is by usefulness, not score —
 * an empty query matches everything equally.
 */
function priorityFilePaths(
  paths: readonly IndexedPath[],
  limit: number,
  priorityPaths: ReadonlySet<string> | undefined,
  recentPaths: readonly string[] | undefined
): RankedPath[] {
  const recentOrder = new Map<string, number>()
  for (const [order, path] of (recentPaths ?? []).entries()) recentOrder.set(path, order)
  const recent: Array<{ entry: IndexedPath; order: number }> = []
  const changed: IndexedPath[] = []
  const topDirectories: IndexedPath[] = []
  const rest: IndexedPath[] = []

  for (const entry of paths) {
    const order = recentOrder.get(entry.path)
    if (order != null && entry.kind === 'file') {
      recent.push({ entry, order })
    } else if (priorityPaths?.has(entry.path) === true) {
      if (changed.length < limit) changed.push(entry)
    } else if (entry.kind === 'dir' && !entry.path.includes('/')) {
      if (topDirectories.length < limit) topDirectories.push(entry)
    } else if (rest.length < limit) {
      rest.push(entry)
    }
  }

  recent.sort((left, right) => left.order - right.order)
  const ordered = [
    ...recent.map((item) => item.entry),
    ...changed,
    ...topDirectories,
    ...rest
  ]
  return ordered.slice(0, limit).map((entry) => ({ path: entry.path, kind: entry.kind }))
}

interface RankingCacheEntry extends FileRankingOptions {
  paths: readonly IndexedPath[]
  query: string
  results: readonly RankedPath[]
}

let lastRanking: RankingCacheEntry | null = null

function sameRanking(left: readonly RankedPath[], right: readonly RankedPath[]): boolean {
  if (left.length !== right.length) return false
  for (const [index, entry] of left.entries()) {
    const other = right[index]!
    if (entry.path !== other.path || entry.kind !== other.kind) return false
  }
  return true
}

export function rankFilePaths(
  paths: readonly IndexedPath[],
  query: string,
  options: FileRankingOptions = {}
): readonly RankedPath[] {
  const { limit = 80, priorityPaths, recentPaths } = options
  const cached = lastRanking
  if (cached != null
    && cached.paths === paths
    && cached.query === query
    && cached.limit === limit
    && cached.priorityPaths === priorityPaths
    && cached.recentPaths === recentPaths) {
    return cached.results
  }
  const computed = computeRanking(paths, query, limit, priorityPaths, recentPaths)
  // One more character usually leaves the same rows in the same order. Handing
  // back the previous array lets the palette's row memo bail out instead of
  // rebuilding thirty row models per keystroke.
  const results = cached != null && sameRanking(cached.results, computed) ? cached.results : computed
  lastRanking = { paths, query, limit, priorityPaths, recentPaths, results }
  return results
}

function computeRanking(
  paths: readonly IndexedPath[],
  query: string,
  limit: number,
  priorityPaths: ReadonlySet<string> | undefined,
  recentPaths: readonly string[] | undefined
): readonly RankedPath[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (normalizedQuery === '') return priorityFilePaths(paths, limit, priorityPaths, recentPaths)

  const scored: ScoredPath[] = []
  for (const entry of paths) {
    const score = fuzzyPathScore(entry, normalizedQuery)
    if (score == null) continue
    addScoredPath(scored, {
      entry,
      score: entry.kind === 'dir' ? score + DIRECTORY_SCORE_PENALTY : score,
      priority: priorityPaths?.has(entry.path) === true
    }, limit)
  }
  return scored
    .sort(compareScoredPaths)
    .map((result) => ({ path: result.entry.path, kind: result.entry.kind }))
}
