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
