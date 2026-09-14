import { useEffect, useEffectEvent, useState } from 'react'

import type { RepositorySnapshot } from '../../../shared/contracts'
import {
  sessionRestoreExpected,
  shouldReportRestoreFailure,
  startupSnapshotAction,
  type SessionRestoreHint
} from '../../../shared/sessionRestore'
import { getErrorMessage } from '../explorer/repositoryApi'

export interface SessionRestoreOptions {
  /** Main's restore of the last folder; resolves to `null` when there is none. */
  snapshotPromise: Promise<RepositorySnapshot | null>
  restoreHint: SessionRestoreHint | null
  /** The snapshot already on screen from the cached paint, read at call time. */
  paintedSnapshot(): RepositorySnapshot | null
  onRestore(snapshot: RepositorySnapshot): void
  onError(message: string): void
}

/**
 * Waits out main's session restore and reports whether it is still pending, so
 * the shell can hold the opening canvas instead of flashing the welcome screen.
 */
export function useSessionRestore({
  snapshotPromise,
  restoreHint,
  paintedSnapshot,
  onRestore,
  onError
}: SessionRestoreOptions): boolean {
  const [restorePending, setRestorePending] = useState(
    () => paintedSnapshot() == null && sessionRestoreExpected(restoreHint)
  )

  const settle = useEffectEvent((restoredSnapshot: RepositorySnapshot | null) => {
    const action = startupSnapshotAction({
      cancelled: false,
      snapshot: restoredSnapshot,
      paintedSnapshot: paintedSnapshot()
    })
    if (action === 'apply' && restoredSnapshot != null) {
      onRestore(restoredSnapshot)
    } else if (shouldReportRestoreFailure({
      action,
      restoreExpected: sessionRestoreExpected(restoreHint)
    })) {
      const folder = restoreHint?.lastRoot?.split('/').pop()
      onError(folder == null
        ? 'Could not reopen the last folder.'
        : `Could not reopen “${folder}”.`)
    }
    setRestorePending(false)
  })

  const fail = useEffectEvent((sessionError: unknown) => {
    setRestorePending(false)
    onError(getErrorMessage(sessionError))
  })

  useEffect(() => {
    let cancelled = false
    void snapshotPromise.then((restoredSnapshot) => {
      if (cancelled) return
      settle(restoredSnapshot)
    }).catch((sessionError: unknown) => {
      if (cancelled) return
      fail(sessionError)
    })
    return () => { cancelled = true }
  }, [snapshotPromise])

  return restorePending
}
