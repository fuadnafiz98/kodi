import { useEffect, useRef, useState } from 'react'

import { isHighMemory } from '../perf/performanceHealth'
import { getMemorySamples } from '../perf/performanceHistory'

export const HIDDEN_VIEWER_RELEASE_DELAY_MS = 300_000
export const HIGH_MEMORY_HIDDEN_RELEASE_DELAY_MS = 60_000

// Short window switches must never lose review state. A working set already at
// the 1 GB warning can drop workers sooner once the window is actually hidden.
export function hiddenViewerReleaseDelayMs(
  workingSetMegabytes: number | undefined = getMemorySamples().at(-1)?.workingSetMegabytes
): number {
  return isHighMemory(workingSetMegabytes)
    ? HIGH_MEMORY_HIDDEN_RELEASE_DELAY_MS
    : HIDDEN_VIEWER_RELEASE_DELAY_MS
}

export function useViewerSuspension(): boolean {
  const [suspended, setSuspended] = useState(false)
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clearReleaseTimer = (): void => {
      if (releaseTimerRef.current == null) return
      clearTimeout(releaseTimerRef.current)
      releaseTimerRef.current = null
    }
    const handleVisibility = (): void => {
      clearReleaseTimer()
      if (document.hidden) {
        releaseTimerRef.current = setTimeout(() => setSuspended(true), hiddenViewerReleaseDelayMs())
      } else {
        setSuspended(false)
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    handleVisibility()
    return () => {
      clearReleaseTimer()
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  return suspended
}
