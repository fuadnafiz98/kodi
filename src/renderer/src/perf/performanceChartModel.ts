import {
  formatPerformanceMemory,
  formatPerformancePercent,
  type MemorySample,
  type PerformanceChartMetric
} from './performanceHistory'

export const CHART_WIDTH = 400
export const CHART_HEIGHT = 136
export const LEAK_WARNING_MEGABYTES_PER_HOUR = 120

export const chartTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
})

export function formatChartValue(value: number, metric: PerformanceChartMetric): string {
  return metric === 'memory' ? formatPerformanceMemory(value) : formatPerformancePercent(value)
}

export function sampleValue(
  sample: MemorySample,
  metric: PerformanceChartMetric,
  secondary = false
): number | null {
  if (metric === 'memory') {
    return secondary ? sample.rendererPrivateMegabytes : sample.workingSetMegabytes
  }
  return secondary ? sample.gpuProcessCpuPercent ?? null : sample.cpuPercent ?? null
}

/** What the two plotted series are called for the metric on screen. */
export function chartSeriesLabels(metric: PerformanceChartMetric): {
  primary: string
  secondary: string
} {
  return metric === 'memory'
    ? { primary: 'Total', secondary: 'Renderer' }
    : { primary: 'App CPU', secondary: 'GPU' }
}
