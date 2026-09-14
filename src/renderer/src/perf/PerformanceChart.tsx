import { memo, useMemo, useState } from 'react'

import {
  buildPerformanceChart,
  formatSpan,
  formatTrendPerHour,
  memoryTrendPerHour,
  type MemorySample,
  type PerformanceChartMetric
} from './performanceHistory'
import { PerformanceChartCanvas } from './PerformanceChartCanvas'
import { PerformanceChartTooltip } from './PerformanceChartTooltip'
import {
  chartSeriesLabels,
  chartTimeFormatter,
  CHART_HEIGHT,
  CHART_WIDTH,
  formatChartValue,
  LEAK_WARNING_MEGABYTES_PER_HOUR,
  sampleValue
} from './performanceChartModel'
import { usePerformanceChartInspector } from './usePerformanceChartInspector'

interface PerformanceChartProps {
  history: readonly MemorySample[]
  historyVersion?: number
}

export const PerformanceChart = memo(function PerformanceChart({
  history,
  historyVersion = 0
}: PerformanceChartProps): React.JSX.Element {
  const [metric, setMetric] = useState<PerformanceChartMetric>('memory')
  const [metricInput, setMetricInput] = useState<'keyboard' | 'pointer'>('pointer')
  const historySnapshot = useMemo(
    () => ({ history, version: historyVersion }),
    [history, historyVersion]
  )
  const trendPerHour = useMemo(
    () => memoryTrendPerHour(historySnapshot.history),
    [historySnapshot]
  )
  const chart = useMemo(
    () => buildPerformanceChart(historySnapshot.history, metric, CHART_WIDTH, CHART_HEIGHT),
    [historySnapshot, metric]
  )
  const inspector = usePerformanceChartInspector(history, chart)

  const firstSample = history[0]
  const latestSample = history[history.length - 1]
  const displayedSample = inspector.inspectedSample ?? latestSample
  const sessionSpanMs = (latestSample?.atMs ?? 0) - (firstSample?.atMs ?? 0)
  const labels = chartSeriesLabels(metric)
  const primaryValue = displayedSample == null ? null : sampleValue(displayedSample, metric)
  const secondaryValue = displayedSample == null ? null : sampleValue(displayedSample, metric, true)
  const leaking = trendPerHour != null && trendPerHour >= LEAK_WARNING_MEGABYTES_PER_HOUR

  return (
    <section className="performance-chart-panel" aria-labelledby="performance-chart-title">
      <div className="performance-chart-header">
        <div className="performance-chart-reading">
          <p id="performance-chart-title">Session trend</p>
          <div>
            <strong>{primaryValue == null ? '—' : formatChartValue(primaryValue, metric)}</strong>
            <span>{inspector.inspectedSample == null ? 'Latest sample' : chartTimeFormatter.format(inspector.inspectedSample.atMs)}</span>
          </div>
        </div>
        <div className="performance-chart-tabs" role="group" aria-label="Chart metric" data-input={metricInput}>
          {(['memory', 'cpu'] as const).map((chartMetric) => (
            <button
              key={chartMetric}
              type="button"
              aria-pressed={metric === chartMetric}
              onPointerDown={() => setMetricInput('pointer')}
              onKeyDown={() => setMetricInput('keyboard')}
              onClick={() => {
                setMetric(chartMetric)
                inspector.clear()
              }}
            >
              {chartMetric === 'memory' ? 'Memory' : 'CPU'}
            </button>
          ))}
        </div>
      </div>

      <div className="performance-chart-legend" aria-hidden="true">
        <span className="primary">{labels.primary}</span>
        <span className="secondary">{labels.secondary}</span>
        <span className={`performance-trend ${leaking ? 'warning' : ''}`}>
          {metric === 'memory' ? formatTrendPerHour(trendPerHour) : `${history.length} samples`}
        </span>
      </div>

      {chart == null || firstSample == null || latestSample == null ? (
        <div className="performance-chart-empty">
          <span aria-hidden="true" />
          <p>Building the session timeline.</p>
          <small>The first trend appears after two samples.</small>
        </div>
      ) : (
        <div
          id="performance-chart"
          className="performance-chart-stage"
          tabIndex={0}
          role="group"
          aria-label={`Interactive ${metric} chart over ${formatSpan(sessionSpanMs)}. Use the left and right arrow keys to inspect samples.`}
          onPointerMove={inspector.onPointerMove}
          onPointerLeave={inspector.onPointerLeave}
          onFocus={inspector.onFocus}
          onBlur={inspector.onBlur}
          onKeyDown={inspector.onKeyDown}
        >
          <PerformanceChartCanvas
            chart={chart}
            metric={metric}
            firstSample={firstSample}
            sessionSpanMs={sessionSpanMs}
            inspectX={inspector.inspectX}
            primaryY={inspector.primaryY}
            secondaryY={inspector.secondaryY}
          />

          <PerformanceChartTooltip
            sample={inspector.inspectedSample}
            inspectX={inspector.inspectX}
            metric={metric}
            primaryValue={primaryValue}
            secondaryValue={secondaryValue}
          />
          <p className="sr-only" aria-live="polite">
            {chartInspectorAnnouncement({
              exploring: inspector.keyboardExploring,
              sample: inspector.inspectedSample,
              metric,
              primaryValue,
              secondaryValue
            })}
          </p>
        </div>
      )}
    </section>
  )
})

function chartInspectorAnnouncement({
  exploring,
  sample,
  metric,
  primaryValue,
  secondaryValue
}: {
  exploring: boolean
  sample: MemorySample | null
  metric: PerformanceChartMetric
  primaryValue: number | null
  secondaryValue: number | null
}): string {
  if (!exploring || sample == null) return ''
  const labels = chartSeriesLabels(metric)
  const primary = primaryValue == null ? 'unavailable' : formatChartValue(primaryValue, metric)
  const secondary = secondaryValue == null ? 'unavailable' : formatChartValue(secondaryValue, metric)
  return `${chartTimeFormatter.format(sample.atMs)}. ${labels.primary} ${primary}. ${labels.secondary} ${secondary}.`
}
