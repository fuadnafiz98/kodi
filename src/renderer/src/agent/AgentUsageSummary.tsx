import { IconChevronSm, IconToken } from '@pierre/icons'

import type { AgentUsageUpdate } from '../../../shared/contracts'
import { formatDuration, formatReset, formatTokens } from './agentFormat'
import { UsageMeter } from './AgentUsageMeter'

export function UsageSummary({ usage }: { usage: AgentUsageUpdate }): React.JSX.Element {
  const total = usage.totalTokens ?? 0
  const contextPercent = usage.contextWindow == null || usage.contextWindow === 0
    ? null
    : Math.min(100, total / usage.contextWindow * 100)
  const metrics = [
    { label: 'Input', value: usage.inputTokens }, { label: 'Output', value: usage.outputTokens },
    { label: 'Cached', value: usage.cachedInputTokens }, { label: 'Reasoning', value: usage.reasoningTokens }
  ].filter((metric) => metric.value != null)
  return (
    <details className="agent-usage agent-state-surface">
      <summary>
        <IconToken aria-hidden="true" /><span>Usage</span><strong>{formatTokens(total)} tokens</strong>
        {usage.durationMs == null || usage.durationMs === 0 ? null : <small>{formatDuration(usage.durationMs)}</small>}
        <IconChevronSm className="agent-usage-chevron" aria-hidden="true" />
      </summary>
      <div className="agent-usage-body">
        {contextPercent == null ? null : <UsageMeter label="Context" value={contextPercent} />}
        <dl className="agent-usage-grid">
          {metrics.map((metric) => <div key={metric.label}><dt>{metric.label}</dt><dd>{formatTokens(metric.value ?? 0)}</dd></div>)}
          {usage.costUsd == null || usage.costUsd === 0 ? null : <div><dt>Estimated cost</dt><dd>${usage.costUsd.toFixed(4)}</dd></div>}
          {usage.turns == null || usage.turns === 0 ? null : <div><dt>Model turns</dt><dd>{usage.turns}</dd></div>}
        </dl>
        {usage.rateLimits?.map((window) => <div className="agent-rate-limit" key={window.label}>
          <UsageMeter label={`${window.label} plan`} value={window.usedPercent} suffix=" used" />
          {window.resetsAt == null ? null : <small>Resets {formatReset(window.resetsAt)}</small>}
        </div>)}
      </div>
    </details>
  )
}
