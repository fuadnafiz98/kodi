// Tree ordering lives in two modules so that the boot path can ask for
// `firstTreePath` without loading the tree widget; both stay exported here
// because every caller already reaches for them through this module.
export { firstTreePath } from './treePathOrder'
export { orderPathsForTree } from './treeWidgetOrder'

export interface TreeFollowBehavior {
  offset: 'nearest' | 'center'
  animate: boolean
}

export function getTreeFollowBehavior(source: 'direct-navigation' | 'review-scroll'): TreeFollowBehavior {
  return source === 'direct-navigation'
    ? { offset: 'nearest', animate: false }
    : { offset: 'center', animate: false }
}

// The workspace and the explorer ask for the directories of the same path array,
// so the answer is kept per input identity rather than computed twice.
const directoryPathsByInput = new WeakMap<readonly string[], string[]>()

export interface AppliedTreeContent {
  root: string
  paths: readonly string[]
  statuses: unknown
  /** Directories of `paths`, for reading back what the reader had open. */
  directories?: readonly string[]
  /** Changed folders already opened once; the reader may have closed them since. */
  changedDirectories?: ReadonlySet<string>
}

/**
 * `adopt` is a reset whose collapse pass is pointless: the tree holds nothing
 * the reader expanded, either because this is its first content or because the
 * root changed under it. Opening a folder used to walk every directory twice —
 * once for the skeleton listing, once for the git snapshot behind it.
 */
export type TreeContentSyncMode = 'skip' | 'status' | 'reset' | 'adopt'

export function treeContentSyncMode(
  applied: AppliedTreeContent | null,
  root: string,
  nextPaths: readonly string[],
  nextStatuses: unknown
): TreeContentSyncMode {
  const sameRoot = applied != null && applied.root === root
  if (sameRoot && applied.paths === nextPaths && applied.statuses === nextStatuses) return 'skip'
  if (sameRoot && applied.paths === nextPaths) return 'status'
  if (!sameRoot || applied.paths.length === 0) return 'adopt'
  return 'reset'
}

export function getDirectoryPaths(filePaths: readonly string[]): string[] {
  const cached = directoryPathsByInput.get(filePaths)
  if (cached != null) return cached

  // Prefixes come from slicing at each separator, and depth is recorded on the way
  // through. Building them with `split().slice().join()` and then sorting with a
  // comparator that re-split both operands and called `localeCompare` cost 133ms at
  // 40k paths against 25ms for this; the order only drives the collapse-then-expand
  // pass, so byte order is enough.
  const directories = new Map<string, number>()
  for (const filePath of filePaths) {
    let index = filePath.indexOf('/')
    let depth = 1
    while (index >= 0) {
      directories.set(filePath.slice(0, index), depth)
      depth += 1
      index = filePath.indexOf('/', index + 1)
    }
  }

  const ordered = [...directories].sort(
    (left, right) => left[1] - right[1] || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)
  )
  const directoryPaths = ordered.map((entry) => entry[0])
  directoryPathsByInput.set(filePaths, directoryPaths)
  return directoryPaths
}

/** The slice of the tree model bulk expansion needs, so tests can use the real one or a fake. */
export interface BulkExpandableTree {
  getItem(path: string): object | null
  resetPaths(paths: readonly string[], options?: { initialExpandedPaths?: readonly string[] }): void
}

type DirectoryHandle = { isExpanded(): boolean; expand(): void; collapse(): void }

function directoryHandle(model: BulkExpandableTree, path: string): DirectoryHandle | null {
  const item = model.getItem(path)
  return item != null && 'isExpanded' in item ? item as DirectoryHandle : null
}

// Every `expand()`/`collapse()` on the tree rebuilds its visible projection and
// notifies every subscriber — the virtualized view re-renders, the explorer
// re-reads every folder. One call per folder made "expand all" on a tree with a
// few thousand folders O(folders²) and froze the window. Past a handful, the
// store is rebuilt once with the target expansion instead: one projection, one
// notification. Measured on 25k paths / 1k folders: 300 single expands 115 ms and
// climbing, one reset expanding all 52 ms.
export const PER_ITEM_EXPANSION_LIMIT = 16

export function expandedDirectoryPaths(model: BulkExpandableTree, directoryPaths: readonly string[]): string[] {
  const expanded: string[] = []
  for (const path of directoryPaths) {
    if (directoryHandle(model, path)?.isExpanded() === true) expanded.push(path)
  }
  return expanded
}

/**
 * Opens `targets` while keeping whatever the reader already had open. `paths`
 * must be the list the model currently holds; the reset rebuilds from it.
 */
export function expandDirectories(
  model: BulkExpandableTree,
  paths: readonly string[],
  directoryPaths: readonly string[],
  targets: readonly string[]
): void {
  const closed: DirectoryHandle[] = []
  const closedPaths: string[] = []
  for (const path of targets) {
    const handle = directoryHandle(model, path)
    if (handle == null || handle.isExpanded()) continue
    closed.push(handle)
    closedPaths.push(path)
  }
  if (closed.length === 0) return
  if (closed.length <= PER_ITEM_EXPANSION_LIMIT) {
    for (const handle of closed) handle.expand()
    return
  }
  model.resetPaths(paths, {
    initialExpandedPaths: [...expandedDirectoryPaths(model, directoryPaths), ...closedPaths]
  })
}

export function setAllDirectoriesExpanded(
  model: BulkExpandableTree,
  paths: readonly string[],
  directoryPaths: readonly string[],
  expanded: boolean
): void {
  model.resetPaths(paths, { initialExpandedPaths: expanded ? directoryPaths : [] })
  if (expanded) return
  // An empty list falls back to the tree's base expansion, which opens the top
  // level of a plain folder; only those few are left to close by hand.
  for (const path of directoryPaths) {
    if (path.includes('/')) continue
    const handle = directoryHandle(model, path)
    if (handle?.isExpanded() === true) handle.collapse()
  }
}

export interface TreePathDelta {
  added: string[]
  removed: string[]
}

// Past this many changed paths one rebuild is cheaper than the batch, and a
// delta that large is a checkout or a filter, not a save.
export const INCREMENTAL_PATH_LIMIT = 2_000

/**
 * What changed between two path lists, or null when too much did. Both lists
 * come out of the same ordering, so a save or a new file usually differs only in
 * a short window: the shared head and tail are skipped by identity and only
 * that window is compared as sets.
 */
export function diffTreePaths(
  previous: readonly string[],
  next: readonly string[],
  limit = INCREMENTAL_PATH_LIMIT
): TreePathDelta | null {
  let head = 0
  const shortest = Math.min(previous.length, next.length)
  while (head < shortest && previous[head] === next[head]) head += 1
  let previousEnd = previous.length
  let nextEnd = next.length
  while (previousEnd > head && nextEnd > head && previous[previousEnd - 1] === next[nextEnd - 1]) {
    previousEnd -= 1
    nextEnd -= 1
  }
  // Two files far apart widen the window to most of the list; comparing it as
  // sets still costs a fraction of the rebuild, so only the result is capped.
  const before = new Set(previous.slice(head, previousEnd))
  const after = new Set(next.slice(head, nextEnd))
  const added = [...after].filter((path) => !before.has(path))
  const removed = [...before].filter((path) => !after.has(path))
  return added.length + removed.length > limit ? null : { added, removed }
}

export interface IncrementalTree {
  batch(operations: readonly (
    | { type: 'add'; path: string }
    | { type: 'remove'; path: string; recursive?: boolean }
  )[]): void
}

/**
 * Applies a delta in one store event, which keeps every folder the reader has
 * open — a reset rebuilds the store and forgets them. Removing a folder's last
 * file leaves the folder behind, so a folder that no longer holds anything is
 * removed as a whole (only its topmost vanished ancestor, which takes the rest).
 */
export function applyTreePathDelta(
  model: IncrementalTree,
  delta: TreePathDelta,
  nextDirectoryPaths: readonly string[]
): void {
  const vanished = new Set<string>()
  if (delta.removed.length > 0) {
    const surviving = new Set(nextDirectoryPaths)
    for (const path of delta.removed) {
      let index = path.indexOf('/')
      while (index > 0) {
        const directory = path.slice(0, index)
        if (!surviving.has(directory)) {
          vanished.add(directory)
          break
        }
        index = path.indexOf('/', index + 1)
      }
    }
  }
  const operations: Parameters<IncrementalTree['batch']>[0][number][] = []
  for (const directory of vanished) operations.push({ type: 'remove', path: `${directory}/`, recursive: true })
  for (const path of delta.removed) {
    if (!insideAny(path, vanished)) operations.push({ type: 'remove', path })
  }
  for (const path of delta.added) operations.push({ type: 'add', path })
  if (operations.length > 0) model.batch(operations)
}

function insideAny(path: string, directories: ReadonlySet<string>): boolean {
  if (directories.size === 0) return false
  let index = path.indexOf('/')
  while (index > 0) {
    if (directories.has(path.slice(0, index))) return true
    index = path.indexOf('/', index + 1)
  }
  return false
}
