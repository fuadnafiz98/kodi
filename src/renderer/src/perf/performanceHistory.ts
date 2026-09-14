export interface MemorySample {
  atMs: number
  workingSetMegabytes: number
  rendererPrivateMegabytes: number
  cpuPercent?: number
  gpuProcessCpuPercent?: number | null
}

// Keep the chart recent enough that a new sample still moves visibly. A long
// visibility gap starts a new continuous series instead of drawing a misleading
// line across hours when the app did not sample.
const HISTORY_WINDOW_MS = 1_200_000
const HISTORY_GAP_RESET_MS = 30_000
const MAX_SAMPLES = 500
// Startup allocates fast; extrapolating those first seconds to an hour reports a
// leak that isn't there. Wait for a few minutes, then read only recent history so
// an old ramp stops dominating the slope.
const TREND_MIN_SPAN_MS = 180_000
const TREND_WINDOW_MS = 1_200_000

// Module state, not component state: the HUD remounts with the titlebar and the
// history is about the session, not the widget.
const samples: MemorySample[] = []

export function recordMemorySample(sample: MemorySample): readonly MemorySample[] {
  const previous = samples[samples.length - 1]
  if (previous != null && sample.atMs <= previous.atMs) return samples
  if (previous != null && sample.atMs - previous.atMs > HISTORY_GAP_RESET_MS) {
    samples.length = 0
  }
  samples.push(sample)
  const firstRecentIndex = samples.findIndex((entry) => entry.atMs >= sample.atMs - HISTORY_WINDOW_MS)
  if (firstRecentIndex > 0) samples.splice(0, firstRecentIndex)
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES)
  return samples
}

export function getMemorySamples(): readonly MemorySample[] {
  return samples
}

export function clearMemorySamples(): void {
  samples.length = 0
}

/**
 * Least-squares slope in MB per hour. Null until there is enough spread in time
 * for a slope to mean anything — two samples 3s apart extrapolate to nonsense.
 */
export function memoryTrendPerHour(history: readonly MemorySample[]): number | null {
  const newest = history[history.length - 1]
  if (newest == null) return null
  const window = history.filter((sample) => newest.atMs - sample.atMs <= TREND_WINDOW_MS)
  const first = window[0]
  if (first == null || window.length < 4) return null
  if (newest.atMs - first.atMs < TREND_MIN_SPAN_MS) return null

  const bucketSize = Math.max(2, Math.floor(window.length * 0.15))
  const start = window.slice(0, bucketSize)
  const end = window.slice(-bucketSize)
  const median = (values: readonly number[]): number => {
    const ordered = [...values].sort((left, right) => left - right)
    const middle = Math.floor(ordered.length / 2)
    return ordered.length % 2 === 0
      ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
      : ordered[middle] ?? 0
  }
  const startValue = median(start.map((sample) => sample.workingSetMegabytes))
  const endValue = median(end.map((sample) => sample.workingSetMegabytes))
  const startTime = median(start.map((sample) => sample.atMs))
  const endTime = median(end.map((sample) => sample.atMs))
  const elapsedHours = (endTime - startTime) / 3_600_000
  return elapsedHours <= 0 ? null : (endValue - startValue) / elapsedHours
}

export function formatTrendPerHour(megabytesPerHour: number | null): string {
  if (megabytesPerHour == null) return 'Measuring…'
  const rounded = Math.round(megabytesPerHour)
  if (rounded === 0) return 'Flat'
  return `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)} MB/h`
}

export function formatSpan(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000)
  if (minutes < 1) return 'under a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder === 0 ? `${hours} h` : `${hours} h ${remainder} min`
}

export function formatPerformancePercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value < 10 ? value.toFixed(1) : value.toFixed(0)}%`
}

export function formatPerformanceMemory(megabytes: number): string {
  return megabytes >= 1_024
    ? `${(megabytes / 1_024).toFixed(1)} GB`
    : `${Math.round(megabytes)} MB`
}

export type PerformanceChartMetric = 'memory' | 'cpu'

export interface ChartPoint {
  x: number
  y: number
}

export interface PerformanceChartGeometry {
  primary: {
    path: string
    points: ChartPoint[]
  }
  secondary: {
    path: string
    points: ChartPoint[]
  }
  domainLow: number
  domainHigh: number
  gridValues: number[]
  plotLeft: number
  plotRight: number
  plotTop: number
  plotBottom: number
}

function chartDomain(values: readonly number[], metric: PerformanceChartMetric): [number, number] {
  const low = Math.min(...values)
  const high = Math.max(...values)
  if (metric === 'cpu') {
    const domainHigh = Math.max(10, Math.ceil((high * 1.15) / 10) * 10)
    return [0, domainHigh]
  }

  const range = high - low
  const padding = Math.max(16, range * 0.18)
  return [
    Math.max(0, Math.floor((low - padding) / 25) * 25),
    Math.ceil((high + padding) / 25) * 25
  ]
}

export function buildPerformanceChart(
  history: readonly MemorySample[],
  metric: PerformanceChartMetric,
  width: number,
  height: number
): PerformanceChartGeometry | null {
  if (history.length < 2) return null
  const first = history[0]
  const last = history[history.length - 1]
  if (first == null || last == null || last.atMs <= first.atMs) return null

  const plotLeft = 38
  const plotRight = width - 8
  const plotTop = 8
  const plotBottom = height - 22
  const primaryValues = history.map((sample) => metric === 'memory'
    ? sample.workingSetMegabytes
    : sample.cpuPercent ?? 0)
  const secondaryValues = history.map((sample) => metric === 'memory'
    ? sample.rendererPrivateMegabytes
    : sample.gpuProcessCpuPercent ?? 0)
  const [domainLow, domainHigh] = chartDomain([...primaryValues, ...secondaryValues], metric)
  const domainRange = Math.max(1, domainHigh - domainLow)
  const timeSpan = last.atMs - first.atMs

  const pointsFor = (values: readonly number[]): ChartPoint[] => values.map((value, index) => ({
    x: plotLeft + ((history[index]!.atMs - first.atMs) / timeSpan) * (plotRight - plotLeft),
    y: plotBottom - ((value - domainLow) / domainRange) * (plotBottom - plotTop)
  }))
  const primaryPoints = pointsFor(primaryValues)
  const secondaryPoints = pointsFor(secondaryValues)
  const toPath = (points: readonly ChartPoint[]): string => points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join('')

  return {
    primary: { path: toPath(primaryPoints), points: primaryPoints },
    secondary: { path: toPath(secondaryPoints), points: secondaryPoints },
    domainLow,
    domainHigh,
    gridValues: [domainHigh, domainLow + domainRange / 2, domainLow],
    plotLeft,
    plotRight,
    plotTop,
    plotBottom
  }
}

export function interpolateChartY(points: readonly ChartPoint[], x: number): number | null {
  const first = points[0]
  if (first == null) return null
  if (x <= first.x) return first.y
  for (let index = 1; index < points.length; index++) {
    const right = points[index]!
    const left = points[index - 1]!
    if (x > right.x) continue
    const span = right.x - left.x
    if (span <= 0) return right.y
    return left.y + ((x - left.x) / span) * (right.y - left.y)
  }
  return points[points.length - 1]?.y ?? null
}

export function findNearestSampleIndex(history: readonly MemorySample[], atMs: number): number {
  if (history.length === 0) return -1
  let low = 0
  let high = history.length - 1
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((history[middle]?.atMs ?? 0) < atMs) low = middle + 1
    else high = middle
  }
  if (low === 0) return 0
  const before = history[low - 1]!
  const after = history[low]!
  return atMs - before.atMs <= after.atMs - atMs ? low - 1 : low
}
