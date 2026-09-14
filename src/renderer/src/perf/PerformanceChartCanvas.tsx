import { useId } from 'react'

import type { MemorySample, PerformanceChartGeometry, PerformanceChartMetric } from './performanceHistory'
import { formatSpan } from './performanceHistory'
import { chartTimeFormatter, CHART_HEIGHT, CHART_WIDTH, formatChartValue } from './performanceChartModel'

export interface PerformanceChartCanvasProps {
  chart: PerformanceChartGeometry
  metric: PerformanceChartMetric
  firstSample: MemorySample
  sessionSpanMs: number
  /** Crosshair position in SVG units, or `null` when nothing is inspected. */
  inspectX: number | null
  primaryY: number | null
  secondaryY: number | null
}

/** The plot itself: grid, two series, time axis and the crosshair. */
export function PerformanceChartCanvas({
  chart,
  metric,
  firstSample,
  sessionSpanMs,
  inspectX,
  primaryY,
  secondaryY
}: PerformanceChartCanvasProps): React.JSX.Element {
  const gradientId = useId().replaceAll(':', '')
  const plotHeight = chart.plotBottom - chart.plotTop
  const domainSpan = chart.domainHigh - chart.domainLow

  return (
    <svg viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`${gradientId}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="performance-chart-fill-start" />
          <stop offset="1" className="performance-chart-fill-end" />
        </linearGradient>
        <clipPath id={`${gradientId}-clip`}>
          <rect x={chart.plotLeft} y={chart.plotTop} width={chart.plotRight - chart.plotLeft} height={plotHeight} />
        </clipPath>
      </defs>

      {chart.gridValues.map((value) => {
        const y = chart.plotBottom - ((value - chart.domainLow) / domainSpan) * plotHeight
        return (
          <g key={value} className="performance-chart-grid">
            <line x1={chart.plotLeft} x2={chart.plotRight} y1={y} y2={y} />
            <text x={chart.plotLeft - 7} y={y + 3} textAnchor="end">{formatChartValue(value, metric)}</text>
          </g>
        )
      })}

      <g clipPath={`url(#${gradientId}-clip)`}>
        <path className="performance-chart-area" d={`${chart.primary.path}L${chart.plotRight},${chart.plotBottom}L${chart.plotLeft},${chart.plotBottom}Z`} fill={`url(#${gradientId}-fill)`} />
        <path className="performance-chart-line secondary" d={chart.secondary.path} pathLength="1" />
        <path className="performance-chart-line primary" d={chart.primary.path} pathLength="1" />
      </g>

      <g className="performance-chart-time-axis">
        <text x={chart.plotLeft} y={CHART_HEIGHT - 4}>{chartTimeFormatter.format(firstSample.atMs)}</text>
        <text x={(chart.plotLeft + chart.plotRight) / 2} y={CHART_HEIGHT - 4} textAnchor="middle">{formatSpan(sessionSpanMs)}</text>
        <text x={chart.plotRight} y={CHART_HEIGHT - 4} textAnchor="end">Now</text>
      </g>

      {inspectX != null && primaryY != null && secondaryY != null ? (
        <g className="performance-chart-inspector">
          <line x1={inspectX} x2={inspectX} y1={chart.plotTop} y2={chart.plotBottom} />
          <circle className="secondary" cx={inspectX} cy={secondaryY} r="3" />
          <circle className="primary" cx={inspectX} cy={primaryY} r="3.5" />
        </g>
      ) : null}
    </svg>
  )
}
