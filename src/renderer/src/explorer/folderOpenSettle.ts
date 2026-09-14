import type { RepositorySnapshot } from '../../../shared/contracts'

/**
 * How long an open keeps its progress affordance up waiting for the git
 * snapshot. `open()` in the main process already races the refresh for 150 ms,
 * so this only covers the repositories that lose that race.
 */
export const LIVE_SNAPSHOT_DEADLINE_MS = 400

/**
 * An open that settles inside this window never shows a spinner. Folder opens
 * measure 16-196 ms, so the common case is a picker that simply closes.
 */
export const OPEN_SPINNER_DELAY_MS = 80

/** A snapshot with no stage came from a cache or a git action; both are real. */
export function isLiveSnapshot(snapshot: Pick<RepositorySnapshot, 'stage'>): boolean {
  return snapshot.stage !== 'skeleton'
}

interface LiveSnapshotWaiter {
  root: string
  settle(): void
}

const waiters = new Set<LiveSnapshotWaiter>()

/** Every snapshot the renderer applies passes through here. */
export function reportAppliedSnapshot(snapshot: Pick<RepositorySnapshot, 'root' | 'stage'>): void {
  if (waiters.size === 0 || !isLiveSnapshot(snapshot)) return
  // Deleting the current entry mid-iteration is defined behaviour for a Set, so
  // the waiter list does not have to be copied to drain it.
  for (const waiter of waiters) {
    if (waiter.root !== snapshot.root) continue
    waiters.delete(waiter)
    waiter.settle()
  }
}

/**
 * Resolves when a live snapshot for `root` is applied, or when the deadline
 * passes. The folder picker holds its row spinner until then so the reader
 * never watches a status-less skeleton tree turn into the real one.
 */
export function waitForLiveSnapshot(
  root: string,
  deadlineMs = LIVE_SNAPSHOT_DEADLINE_MS
): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const waiter: LiveSnapshotWaiter = {
      root,
      settle: () => {
        if (timer != null) clearTimeout(timer)
        resolve()
      }
    }
    waiters.add(waiter)
    timer = setTimeout(() => {
      waiters.delete(waiter)
      resolve()
    }, deadlineMs)
  })
}
