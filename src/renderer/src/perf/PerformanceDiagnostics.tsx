import type { CSSProperties } from 'react'

import type { PerformanceMetrics } from '../../../shared/contracts'
import { formatPerformanceMemory } from './performanceHistory'
import {
  formatStartupTiming,
  processPeakMegabytes,
  SAMPLE_INTERVAL_COLLAPSED_MS,
  SAMPLE_INTERVAL_OPEN_MS
} from './performanceHudModel'
import type { ReviewMetrics } from '../review/reviewMetrics'
import { getRendererStartupMetrics } from '../app/startupMetrics'

type ProcessStyle = CSSProperties & {
  '--performance-process-share': number
}

export interface PerformanceDiagnosticsProps {
  metrics: PerformanceMetrics | null
  reviewMetrics: ReviewMetrics
}

/** The expensive half of the HUD: only rendered while the disclosure is open. */
export function PerformanceDiagnostics({
  metrics,
  reviewMetrics
}: PerformanceDiagnosticsProps): React.JSX.Element {
  const detail = metrics?.detail ?? null
  const rendererStartup = getRendererStartupMetrics()
  const processPeak = processPeakMegabytes(detail)

  return (
    <div className="performance-diagnostics-content">
      <div className="performance-details-grid">
        <section className="performance-group">
          <h3>Runtime</h3>
          <dl>
            <div><dt>Renderer private</dt><dd>{metrics == null ? '—' : formatPerformanceMemory(metrics.rendererPrivateMegabytes)}</dd></div>
            <div><dt>Main private</dt><dd>{detail == null ? '—' : formatPerformanceMemory(detail.mainPrivateMegabytes)}</dd></div>
            <div><dt>V8 heap</dt><dd>{detail == null ? '—' : `${formatPerformanceMemory(detail.rendererHeapUsedMegabytes)} / ${formatPerformanceMemory(detail.rendererHeapTotalMegabytes)}`}</dd></div>
            <div><dt>DOM nodes</dt><dd>{detail?.rendererDomNodes.toLocaleString() ?? '—'}</dd></div>
          </dl>
        </section>

        <section className="performance-group">
          <h3>Review activity</h3>
          <dl>
            <div><dt>Files loaded</dt><dd>{reviewMetrics.loadedItems.toLocaleString()}</dd></div>
            <div><dt>Files hydrated</dt><dd>{reviewMetrics.hydratedFiles.toLocaleString()}</dd></div>
            <div><dt>Workspace renders</dt><dd>{reviewMetrics.workspaceRenders.toLocaleString()}</dd></div>
            <div><dt>Agent events</dt><dd>{reviewMetrics.agentStreamEvents.toLocaleString()}</dd></div>
          </dl>
        </section>

        <section className="performance-group">
          <h3>Main startup</h3>
          <dl>
            <div><dt>App ready</dt><dd>{formatStartupTiming(detail?.mainStartup.appReady)}</dd></div>
            <div><dt>Window created</dt><dd>{formatStartupTiming(detail?.mainStartup.windowCreated)}</dd></div>
            <div><dt>Window shown</dt><dd>{formatStartupTiming(detail?.mainStartup.windowShown)}</dd></div>
            <div><dt>Restore settled</dt><dd>{formatStartupTiming(detail?.mainStartup.restoreSettled)}</dd></div>
          </dl>
        </section>

        <section className="performance-group">
          <h3>Renderer startup</h3>
          <dl>
            <div><dt>Renderer loaded</dt><dd>{formatStartupTiming(rendererStartup.rendererLoaded)}</dd></div>
            <div><dt>React committed</dt><dd>{formatStartupTiming(rendererStartup.reactCommitted)}</dd></div>
            <div><dt>Snapshot ready</dt><dd>{formatStartupTiming(rendererStartup.snapshotReady)}</dd></div>
            <div><dt>Explorer committed</dt><dd>{formatStartupTiming(rendererStartup.explorerCommitted)}</dd></div>
            <div><dt>Viewer committed</dt><dd>{formatStartupTiming(rendererStartup.viewerCommitted)}</dd></div>
          </dl>
        </section>
      </div>

      {detail != null && detail.memoryByProcessType.length > 0 ? (
        <section className="performance-processes">
          <h3>Working set by process</h3>
          <ul role="list">
            {detail.memoryByProcessType.map((entry) => (
              <li key={entry.type}>
                <span>{entry.type}</span>
                <span className="performance-process-track" aria-hidden="true">
                  <span style={{ '--performance-process-share': entry.megabytes / processPeak } as ProcessStyle} />
                </span>
                <strong>{formatPerformanceMemory(entry.megabytes)}</strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="performance-footnote">
        Samples every {SAMPLE_INTERVAL_OPEN_MS / 1_000} seconds while this popover is open, every {SAMPLE_INTERVAL_COLLAPSED_MS / 1_000} while it is closed.
        {metrics?.lastRendererTermination == null
          ? null
          : ` Last renderer exit: ${metrics.lastRendererTermination.reason} (${metrics.lastRendererTermination.exitCode}).`}
      </footer>
    </div>
  )
}
