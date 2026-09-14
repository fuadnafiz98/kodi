import type { PerformanceMetrics } from '../../../shared/contracts'
import { formatPerformanceMemory, formatPerformancePercent } from './performanceHistory'
import type { ReviewMetrics } from '../review/reviewMetrics'

// The lightweight sample uses Electron's in-process app metrics. Keep it fast
// enough to catch a short memory spike; expensive process detail remains gated
// behind the open Diagnostics disclosure.
export const SAMPLE_INTERVAL_OPEN_MS = 2_000
export const SAMPLE_INTERVAL_COLLAPSED_MS = 15_000
export const SAMPLE_TIMEOUT_MS = 5_000
// A sample is an IPC round trip plus `app.getAppMetrics()` in main. Waiting for
// idle keeps it out of the frame that opens the popover.
export const SAMPLE_IDLE_TIMEOUT_MS = 1_000
// The collapsed badge gets one deferred reading so it can show the real working
// set instead of an empty dash; late enough to stay out of the launch window
// (session restore settles inside ~450 ms), early enough that the placeholder
// never reads as a loading state.
export const SAMPLE_PRIME_DELAY_MS = 750

export type SamplingStatus = 'sampling' | 'live' | 'unavailable'

export function sameReviewMetrics(left: ReviewMetrics, right: ReviewMetrics): boolean {
  return left.loadedItems === right.loadedItems &&
    left.hydratedFiles === right.hydratedFiles &&
    left.workspaceRenders === right.workspaceRenders &&
    left.agentStreamEvents === right.agentStreamEvents
}

export function formatStartupTiming(milliseconds: number | null | undefined): string {
  return milliseconds == null ? '—' : `${Math.round(milliseconds)} ms`
}

/** The summary's accessible name: everything the collapsed badge cannot show. */
export function performanceDescription(
  metrics: PerformanceMetrics | null,
  highMemory: boolean
): string {
  if (metrics == null) return 'Collecting application performance metrics.'
  const build = metrics.production ? 'Production' : 'Development'
  const warning = highMemory ? ' High memory warning.' : ''
  return `${build} build. ${metrics.processCount} processes. CPU ${formatPerformancePercent(metrics.cpuPercent)}. Total application working set ${formatPerformanceMemory(metrics.workingSetMegabytes)}.${warning}`
}

export function buildLabel(metrics: PerformanceMetrics | null): string {
  if (metrics == null) return 'Detecting build'
  return metrics.production ? 'Production build' : 'Development build'
}

/** `Stale` is a failed sample that still has an earlier reading to show. */
export function samplingStatusLabel(
  status: SamplingStatus,
  metrics: PerformanceMetrics | null
): string {
  if (status === 'live') return 'Live'
  if (status === 'sampling') return 'Sampling'
  return metrics == null ? 'Unavailable' : 'Stale'
}

export function workingSetSummary(metrics: PerformanceMetrics | null, highMemory: boolean): string {
  if (metrics == null) return 'Sampling…'
  const processes = `${metrics.processCount} processes`
  return highMemory ? `High · ${processes}` : processes
}

/** The widest bar in the per-process list; at least 1 so nothing divides by zero. */
export function processPeakMegabytes(
  detail: PerformanceMetrics['detail'] | null
): number {
  return Math.max(1, ...(detail?.memoryByProcessType.map((entry) => entry.megabytes) ?? []))
}
