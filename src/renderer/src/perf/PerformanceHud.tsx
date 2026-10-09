import { lazy, memo, Suspense, useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { IconCiWarningFill } from '@pierre/icons'
import './PerformanceHud.css'

import {
  formatPerformanceMemory,
  formatPerformancePercent,
  getMemorySamples,
  subscribeMemorySamples
} from './performanceHistory'
import { isHighMemory } from './performanceHealth'
import { PerformanceDiagnostics } from './PerformanceDiagnostics'
import {
  buildLabel,
  performanceDescription,
  samplingStatusLabel,
  workingSetSummary
} from './performanceHudModel'
import { usePerformanceSampling } from './usePerformanceSampling'
import { usePopoverDismiss } from '../app/usePopoverDismiss'

const PerformanceChart = lazy(async () => ({
  default: (await import('./PerformanceChart')).PerformanceChart
}))

const sampledTimeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
})

export const PerformanceHud = memo(function PerformanceHud(): React.JSX.Element {
  // Each recorded sample publishes a new array, so this re-renders exactly when
  // the history actually changes and the chart's memo sees a reference it cannot
  // mistake for the old one.
  const history = useSyncExternalStore(subscribeMemorySamples, getMemorySamples, getMemorySamples)
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  // Nothing is sampled until someone asks for the numbers, so a launch spends no
  // IPC on metrics nobody is reading.
  const [pollingEnabled, setPollingEnabled] = useState(false)
  const hudRef = useRef<HTMLDetailsElement>(null)

  const { metrics, reviewMetrics, status } = usePerformanceSampling({
    enabled: pollingEnabled,
    popoverOpen,
    diagnosticsOpen
  })

  const closePopover = useCallback(() => setPopoverOpen(false), [])
  usePopoverDismiss(popoverOpen, hudRef, closePopover)

  const highMemory = isHighMemory(metrics?.workingSetMegabytes)
  const description = performanceDescription(metrics, highMemory)

  return (
    <details
      ref={hudRef}
      className="performance-hud"
      open={popoverOpen}
      onToggle={(event) => {
        const open = event.currentTarget.open
        setPopoverOpen(open)
        if (open) setPollingEnabled(true)
      }}
    >
      <summary aria-label={description}>
        <span className={`performance-signal ${metrics == null ? 'idle' : ''} ${metrics?.production ? 'production' : ''} ${highMemory ? 'high-memory' : ''}`} aria-hidden="true" />
        <span className={`performance-memory ${highMemory ? 'high-memory' : ''}`}
          title={highMemory ? 'Working set is above 1 GB' : undefined}>
          {highMemory ? <IconCiWarningFill aria-hidden="true" /> : null}
          <strong>{metrics == null ? '' : formatPerformanceMemory(metrics.workingSetMegabytes)}</strong>
        </span>
      </summary>

      <div className="performance-popover">
        <header className="performance-popover-header">
          <div className="performance-popover-heading">
            <strong>Performance</strong>
            <small>{buildLabel(metrics)}</small>
          </div>
          <div className={`performance-live ${status}`}>
            <span>{samplingStatusLabel(status, metrics)}</span>
            {metrics == null ? null : <time dateTime={new Date(metrics.sampledAt).toISOString()}>{sampledTimeFormatter.format(metrics.sampledAt)}</time>}
          </div>
        </header>

        <div className="performance-popover-body">
          <dl className="performance-kpis">
            <div><dt>App CPU</dt><dd>{formatPerformancePercent(metrics?.cpuPercent)}</dd><small>All processes</small></div>
            <div><dt>GPU</dt><dd>{formatPerformancePercent(metrics?.gpuProcessCpuPercent)}</dd><small>Graphics process</small></div>
            <div className={highMemory ? 'high-memory' : undefined}><dt>Working set</dt><dd>{metrics == null ? '—' : formatPerformanceMemory(metrics.workingSetMegabytes)}</dd><small>{workingSetSummary(metrics, highMemory)}</small></div>
          </dl>

          {popoverOpen ? <Suspense fallback={null}>
            <PerformanceChart history={history} />
          </Suspense> : null}

          <details className="performance-diagnostics" onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}>
            <summary>
              <span>
                <strong>Diagnostics</strong>
                <small>Runtime · Activity · Processes</small>
              </span>
            </summary>

            {diagnosticsOpen ? (
              <PerformanceDiagnostics metrics={metrics} reviewMetrics={reviewMetrics} />
            ) : null}
          </details>
        </div>
      </div>
    </details>
  )
})
