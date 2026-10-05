import { startTransition, useEffect, useEffectEvent, useRef, type RefObject } from 'react'

import type { RepositoryChangeEvent, RepositorySnapshot } from '../../../shared/contracts'
import type { useGitWorkflow } from '../git/useGitWorkflow'
import type { ComparisonLoader } from '../review/useComparisonLoader'
import { getErrorMessage, requireRepositoryApi } from '../explorer/repositoryApi'
import { heldPathsFor } from '../explorer/snapshotPaths'
import { isLiveSnapshot } from '../explorer/folderOpenSettle'

// A cold git status on a large repository takes a few seconds; half a minute
// covers anything but a hung refresh, which the watcher reports on its own.
const SESSION_CATCH_UP_INTERVAL_MS = 250
const SESSION_CATCH_UP_ATTEMPTS = 120

export interface RepositoryChangeSyncOptions {
  /** Root of the snapshot on screen; a new root starts the session catch-up. */
  appliedRoot: string | null
  selectedPath: string | null
  appliedSnapshotRef: RefObject<RepositorySnapshot | null>
  skeletonOpenRootRef: RefObject<string | null>
  gitWorkflow: ReturnType<typeof useGitWorkflow>
  comparisonLoader: ComparisonLoader
  applySnapshot(snapshot: RepositorySnapshot): void
  onRepositoryChange(change: RepositoryChangeEvent): void
  onError(message: string): void
}

/**
 * Keeps the applied snapshot in step with main: watcher events, the path lists
 * an event leaves out, and the live snapshot behind a skeleton still on screen.
 */
export function useRepositoryChangeSync({
  appliedRoot,
  selectedPath,
  appliedSnapshotRef,
  skeletonOpenRootRef,
  gitWorkflow,
  comparisonLoader,
  applySnapshot,
  onRepositoryChange,
  onError
}: RepositoryChangeSyncOptions): void {
  const reviewWorlds = gitWorkflow.worlds
  const syncRepositorySnapshot = gitWorkflow.syncRepositorySnapshot

  // An event can name a path list this window never received — the cached
  // paint before the session answers, or a tab whose session was evicted and
  // reopened. The session's own snapshot is the only safe fill, so it is asked
  // for once instead of guessing from an older list.
  const recoveringPathsRef = useRef(false)
  const recoverHeldPaths = useEffectEvent((root: string): void => {
    if (recoveringPathsRef.current) return
    recoveringPathsRef.current = true
    void requireRepositoryApi().getSessionSnapshot()
      .then((recovered) => {
        if (recovered == null || recovered.root !== root || appliedSnapshotRef.current?.root !== root) return
        syncRepositorySnapshot(recovered)
        startTransition(() => applySnapshot(recovered))
      })
      .catch((recoverError: unknown) => onError(getErrorMessage(recoverError)))
      .finally(() => {
        recoveringPathsRef.current = false
      })
  })

  const handleRepositoryChange = useEffectEvent((change: RepositoryChangeEvent): void => {
    const root = change.snapshot.root
    const previousWorld = reviewWorlds.find((world) => world.source !== 'new'
      && world.root === root)
    const previousSnapshot = previousWorld == null || previousWorld.source === 'new'
      ? null
      : previousWorld.snapshot
    const paths = change.snapshot.paths
      ?? heldPathsFor(change.snapshot, [appliedSnapshotRef.current, previousSnapshot])
    const nextSnapshot: RepositorySnapshot | null = paths == null ? null : { ...change.snapshot, paths }
    if (nextSnapshot != null) syncRepositorySnapshot(nextSnapshot)
    if (appliedSnapshotRef.current?.root !== root) return
    if (nextSnapshot == null) recoverHeldPaths(root)
    const adoptSkeletonOpen = nextSnapshot != null
      && skeletonOpenRootRef.current === root
      && isLiveSnapshot(nextSnapshot)
    if (adoptSkeletonOpen) skeletonOpenRootRef.current = null
    const invalidateAll = change.invalidateAll === true
    comparisonLoader.invalidate(invalidateAll ? 'all' : change.changedPaths)
    startTransition(() => {
      if (nextSnapshot != null) applySnapshot(nextSnapshot)
      onRepositoryChange(change)
      if (adoptSkeletonOpen) gitWorkflow.resyncDeskNavigation(nextSnapshot)
      if (selectedPath != null && (invalidateAll || change.changedPaths.includes(selectedPath))) {
        comparisonLoader.markRevision(change.revision)
      }
    })
  })

  useEffect(() => requireRepositoryApi().onDidChange(handleRepositoryChange), [])

  // A change event for a root this window has not applied yet is dropped above,
  // and the live snapshot of a folder opened at launch can be published while
  // the app is still mounting — on a cold start (the first launch after an
  // install) it reliably was, and main answered the renderer's own question
  // with the skeleton listing it had at the time. The window then sat on that
  // skeleton for good: four files, "Detached HEAD", nothing clickable. So while a
  // skeleton is on screen the session is asked again until it answers live.
  // One chain at a time: switching roots and back started a second poll beside
  // the first.
  const catchUpTimerRef = useRef(0)
  const catchUpWithSession = useEffectEvent((root: string): void => {
    window.clearTimeout(catchUpTimerRef.current)
    const ask = (attempt: number): void => {
      void requireRepositoryApi().getSessionSnapshot()
        .then((latest) => {
          const applied = appliedSnapshotRef.current
          if (latest == null || latest.root !== root || applied?.root !== root) return
          if (!isLiveSnapshot(latest)) {
            if (!isLiveSnapshot(applied) && attempt < SESSION_CATCH_UP_ATTEMPTS) {
              catchUpTimerRef.current = window.setTimeout(() => ask(attempt + 1), SESSION_CATCH_UP_INTERVAL_MS)
            }
            return
          }
          syncRepositorySnapshot(latest)
          const adoptSkeletonOpen = skeletonOpenRootRef.current === root
          if (adoptSkeletonOpen) skeletonOpenRootRef.current = null
          startTransition(() => {
            applySnapshot(latest)
            if (adoptSkeletonOpen) gitWorkflow.resyncDeskNavigation(latest)
          })
        })
        .catch(() => {
          // The next watcher event carries the same snapshot; nothing to report.
        })
    }
    ask(0)
  })
  useEffect(() => {
    if (appliedRoot == null) return
    catchUpWithSession(appliedRoot)
    return () => window.clearTimeout(catchUpTimerRef.current)
  }, [appliedRoot])
}
