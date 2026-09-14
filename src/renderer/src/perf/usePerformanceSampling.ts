import { useEffect, useRef, useState } from 'react'

import type { PerformanceMetrics } from '../../../shared/contracts'
import { recordMemorySample } from './performanceHistory'
import {
  SAMPLE_IDLE_TIMEOUT_MS,
  SAMPLE_INTERVAL_COLLAPSED_MS,
  SAMPLE_INTERVAL_OPEN_MS,
  SAMPLE_PRIME_DELAY_MS,
  SAMPLE_TIMEOUT_MS,
  sameReviewMetrics,
  type SamplingStatus
} from './performanceHudModel'
import { getReviewMetrics, type ReviewMetrics } from '../review/reviewMetrics'

export interface PerformanceSamplingOptions {
  /** Nothing is sampled until someone asks for the numbers. */
  enabled: boolean
  popoverOpen: boolean
  diagnosticsOpen: boolean
}

export interface PerformanceSampling {
  metrics: PerformanceMetrics | null
  reviewMetrics: ReviewMetrics
  status: SamplingStatus
}

export function usePerformanceSampling({
  enabled,
  popoverOpen,
  diagnosticsOpen
}: PerformanceSamplingOptions): PerformanceSampling {
  const [metrics, setMetrics] = useState<PerformanceMetrics | null>(null)
  const [reviewMetrics, setReviewMetrics] = useState<ReviewMetrics>(getReviewMetrics)
  const reviewMetricsRef = useRef(reviewMetrics)
  const [status, setStatus] = useState<SamplingStatus>('sampling')

  useEffect(() => {
    const repository = window.repository
    if (repository == null) return
    let disposed = false
    let timeout: number | null = null
    let idleHandle: number | null = null
    const intervalMs = popoverOpen ? SAMPLE_INTERVAL_OPEN_MS : SAMPLE_INTERVAL_COLLAPSED_MS
    // The inner disclosure keeps its own open state when the popover collapses
    // around it, so both have to be open before the detail is worth collecting.
    const detailed = popoverOpen && diagnosticsOpen

    const scheduleSample = (): void => {
      // The interval loop only exists while someone is reading; with nobody
      // asking, the one-shot prime below is all the collapsed badge gets.
      if (disposed || document.hidden || !enabled) return
      timeout = window.setTimeout(sample, intervalMs)
    }

    const sample = async (): Promise<void> => {
      if (disposed || document.hidden) return
      let sampleTimeout: number | null = null
      try {
        const nextMetrics = await Promise.race([
          repository.getPerformanceMetrics(detailed),
          new Promise<never>((_resolve, reject) => {
            sampleTimeout = window.setTimeout(() => reject(new Error('Performance sample timed out.')), SAMPLE_TIMEOUT_MS)
          })
        ])
        if (!disposed) {
          setMetrics(nextMetrics)
          setStatus('live')
          recordMemorySample({
            atMs: nextMetrics.sampledAt,
            workingSetMegabytes: nextMetrics.workingSetMegabytes,
            rendererPrivateMegabytes: nextMetrics.rendererPrivateMegabytes,
            cpuPercent: nextMetrics.cpuPercent,
            gpuProcessCpuPercent: nextMetrics.gpuProcessCpuPercent
          })
        }
      } catch {
        if (!disposed) setStatus('unavailable')
      } finally {
        if (sampleTimeout != null) window.clearTimeout(sampleTimeout)
        if (!disposed) {
          const nextReviewMetrics = getReviewMetrics()
          if (!sameReviewMetrics(reviewMetricsRef.current, nextReviewMetrics)) {
            reviewMetricsRef.current = nextReviewMetrics
            setReviewMetrics(nextReviewMetrics)
          }
        }
        scheduleSample()
      }
    }

    const handleVisibilityChange = (): void => {
      if (timeout != null) window.clearTimeout(timeout)
      timeout = null
      if (!document.hidden) void sample()
    }

    const startSample = (): void => {
      const begin = (): void => {
        idleHandle = null
        void sample()
      }
      if (enabled) {
        if (typeof window.requestIdleCallback !== 'function') {
          timeout = window.setTimeout(() => { void sample() }, 0)
          return
        }
        idleHandle = window.requestIdleCallback(begin, { timeout: SAMPLE_IDLE_TIMEOUT_MS })
        return
      }
      // Without a reader the badge still wants one real reading, but launch
      // owns the machine first: the prime waits out the startup window and
      // then takes an idle gap. `scheduleSample` will not re-arm it.
      timeout = window.setTimeout(() => {
        timeout = null
        if (typeof window.requestIdleCallback === 'function') {
          idleHandle = window.requestIdleCallback(begin, { timeout: SAMPLE_IDLE_TIMEOUT_MS })
        } else {
          void sample()
        }
      }, SAMPLE_PRIME_DELAY_MS)
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    startSample()
    return () => {
      disposed = true
      if (timeout != null) window.clearTimeout(timeout)
      if (idleHandle != null) window.cancelIdleCallback(idleHandle)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [diagnosticsOpen, enabled, popoverOpen])

  return { metrics, reviewMetrics, status }
}
