// `RepositorySnapshot.paths` arrives sorted from the main process (repository.ts
// sorts every list with plain `<`/`>`), so membership is a binary search. The
// linear fallback costs a scan only when the answer is "gone", which is exactly
// the case that moves the selection — a producer that ever stopped sorting would
// otherwise teleport the reader instead of merely being slow.
export function includesPath(sortedPaths: readonly string[], path: string): boolean {
  let low = 0
  let high = sortedPaths.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    const candidate = sortedPaths[middle]!
    if (candidate === path) return true
    if (candidate < path) low = middle + 1
    else high = middle - 1
  }
  return sortedPaths.includes(path)
}

// A watcher tick usually reports new statuses over an unchanged file list. Reusing
// the previous array keeps every consumer memoized on `paths` (the ⌘P search index,
// the explorer's directory list) from rebuilding for nothing.
export function samePathList(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function sameStatusList(
  left: readonly { path: string; status: string; previousPath?: string }[],
  right: readonly { path: string; status: string; previousPath?: string }[]
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const previous = left[index]!
    const next = right[index]!
    if (
      previous.path !== next.path
      || previous.status !== next.status
      || previous.previousPath !== next.previousPath
    ) {
      return false
    }
  }
  return true
}

export function retainSnapshotIdentity<T extends {
  root: string
  paths: readonly string[]
  statuses: readonly { path: string; status: string; previousPath?: string }[]
}>(previous: T | null | undefined, next: T): T {
  if (previous == null || previous.root !== next.root) return next
  const paths = samePathList(previous.paths, next.paths) ? previous.paths : next.paths
  const statuses = sameStatusList(previous.statuses, next.statuses)
    ? previous.statuses
    : next.statuses
  if (paths === next.paths && statuses === next.statuses) return next
  return { ...next, paths, statuses }
}

export function snapshotLooksUnchanged<T extends {
  root: string
  name: string
  kind: string
  branch: string | null
  head: string | null
  paths: readonly string[]
  statuses: readonly unknown[]
}>(previous: T | null | undefined, next: T): boolean {
  return previous != null
    && previous.root === next.root
    && previous.name === next.name
    && previous.kind === next.kind
    && previous.branch === next.branch
    && previous.head === next.head
    && previous.paths === next.paths
    && previous.statuses === next.statuses
}
