import type { CSSProperties } from 'react'

import type { MemorySample, PerformanceChartMetric } from './performanceHistory'
import {
  chartSeriesLabels,
  chartTimeFormatter,
  CHART_WIDTH,
  formatChartValue
} from './performanceChartModel'

type TooltipStyle = CSSProperties & {
  '--performance-tooltip-x': string
}

export interface PerformanceChartTooltipProps {
  sample: MemorySample | null
  inspectX: number | null
  metric: PerformanceChartMetric
  primaryValue: number | null
  secondaryValue: number | null
}

/** The readout that follows the crosshair. */
export function PerformanceChartTooltip({
  sample,
  inspectX,
  metric,
  primaryValue,
  secondaryValue
}: PerformanceChartTooltipProps): React.JSX.Element | null {
  if (sample == null || inspectX == null) return null
  const labels = chartSeriesLabels(metric)
  const style = { '--performance-tooltip-x': `${(inspectX / CHART_WIDTH) * 100}%` } as TooltipStyle
  return (
    <div className={`performance-chart-tooltip ${inspectX > CHART_WIDTH * 0.67 ? 'align-right' : ''}`} style={style} aria-hidden="true">
      <time dateTime={new Date(sample.atMs).toISOString()}>{chartTimeFormatter.format(sample.atMs)}</time>
      <dl>
        <div className="primary"><dt>{labels.primary}</dt><dd>{primaryValue == null ? '—' : formatChartValue(primaryValue, metric)}</dd></div>
        <div className="secondary"><dt>{labels.secondary}</dt><dd>{secondaryValue == null ? '—' : formatChartValue(secondaryValue, metric)}</dd></div>
      </dl>
    </div>
  )
}
