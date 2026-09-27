import type {
  HeldPathList,
  RepositorySnapshot,
  RepositorySnapshotWithoutPaths
} from './contracts.js'

/** Everything a snapshot says except its path list, which is by far the largest part. */
export function snapshotWithoutPaths(
  snapshot: Omit<RepositorySnapshot, 'paths'> & { paths?: string[] }
): RepositorySnapshotWithoutPaths {
  const { paths, ...rest } = snapshot
  void paths
  return rest
}

function isHeldPathList(value: unknown): value is HeldPathList {
  if (typeof value !== 'object' || value == null) return false
  const record = value as Record<string, unknown>
  return typeof record.root === 'string' && typeof record.pathsRevision === 'number'
}

/**
 * The main side of a mutation reply. The path list is left out only when the
 * requesting window said it holds exactly that list, so a window that never saw
 * it — a new one, a reload, a different root — still gets it. At 100k paths the
 * list is ~6.9 MB of a ~7 MB reply, and a stage click changes none of it.
 */
export function omitHeldPaths(
  snapshot: RepositorySnapshot,
  held: unknown
): RepositorySnapshot | RepositorySnapshotWithoutPaths {
  if (snapshot.pathsRevision == null || !isHeldPathList(held)) return snapshot
  if (held.root !== snapshot.root || held.pathsRevision !== snapshot.pathsRevision) return snapshot
  return snapshotWithoutPaths(snapshot)
}

interface HeldEntry extends HeldPathList {
  paths: string[]
}

function isSnapshotWithPaths(value: unknown): value is RepositorySnapshot & { pathsRevision: number } {
  if (typeof value !== 'object' || value == null) return false
  const record = value as Record<string, unknown>
  return typeof record.root === 'string'
    && typeof record.pathsRevision === 'number'
    && Array.isArray(record.paths)
}

/**
 * The preload side: the last path list main sent, so a reply that left it out
 * can be completed before the renderer sees it. One entry, because mutations
 * only ever act on the repository in front of the reader, and each list held
 * here is a full copy of the renderer's own.
 */
export class HeldPathCache {
  #entry: HeldEntry | null = null

  /** Keeps a snapshot's path list when it carries one main can name. */
  remember(value: unknown): void {
    if (!isSnapshotWithPaths(value)) return
    if (this.#entry?.root === value.root && this.#entry.pathsRevision === value.pathsRevision) return
    this.#entry = { root: value.root, pathsRevision: value.pathsRevision, paths: value.paths }
  }

  /**
   * A broadcast for another root must not evict the list the reader is acting
   * on; it only refreshes the entry it already names.
   */
  rememberBroadcast(value: unknown): void {
    if (this.#entry != null && isSnapshotWithPaths(value) && value.root !== this.#entry.root) return
    this.remember(value)
  }

  /**
   * What to tell main along with a request. The returned entry is held by the
   * caller until the reply lands, so a broadcast that replaces the cache in the
   * meantime cannot leave the reply without its paths.
   */
  claim(): HeldEntry | null {
    return this.#entry
  }

  /** Puts back the path list main left out, or keeps the one it sent. */
  complete(reply: unknown, claim: HeldEntry | null): RepositorySnapshot {
    const snapshot = reply as RepositorySnapshotWithoutPaths | RepositorySnapshot
    if (Array.isArray(snapshot.paths)) {
      this.remember(snapshot)
      return snapshot as RepositorySnapshot
    }
    if (claim == null || claim.root !== snapshot.root || claim.pathsRevision !== snapshot.pathsRevision) {
      throw new Error('The repository reply is missing its file list.')
    }
    this.#entry = claim
    return { ...snapshot, paths: claim.paths }
  }
}

/** The request half of a claim: main needs the name, not the list. */
export function heldPathList(claim: HeldPathList | null): HeldPathList | null {
  return claim == null ? null : { root: claim.root, pathsRevision: claim.pathsRevision }
}
