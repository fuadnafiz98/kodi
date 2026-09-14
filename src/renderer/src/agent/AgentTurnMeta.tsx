import { useEffect, useState } from 'react'
import { IconClockArrow } from '@pierre/icons'

import type { AgentAccessMode, AgentProvider } from '../../../shared/contracts'
import { formatDuration } from './agentFormat'
import { ACCESS_MODES, EFFORT_LABELS } from './agentPanelOptions'

export function TurnMeta({ provider, model, effort, accessMode, running, startedAt, completedAt }: {
  provider: AgentProvider | null
  model: string
  effort: string
  accessMode: AgentAccessMode | null
  running: boolean
  startedAt: number | null
  completedAt: number | null
}): React.JSX.Element {
  const elapsed = useElapsedSeconds(startedAt, completedAt, running)
  const providerLabel = provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'Agent'
  const configuration = [EFFORT_LABELS[effort] ?? effort, accessMode == null ? '' : ACCESS_MODES[accessMode].label]
    .filter(Boolean).join(' · ')
  return (
    <div className="agent-turn-meta" title={configuration}>
      <span>{providerLabel}{model === '' ? '' : ` · ${model}`}</span>
      {accessMode === 'full-access' ? <strong>Full access</strong> : null}
      {elapsed == null ? null : <small className="tabular"><IconClockArrow aria-hidden="true" />{formatDuration(elapsed * 1_000)}</small>}
    </div>
  )
}

function useElapsedSeconds(startedAt: number | null, completedAt: number | null, running: boolean): number | null {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running || startedAt == null) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [running, startedAt])
  if (startedAt == null) return null
  return Math.max(0, Math.round(((completedAt ?? now) - startedAt) / 1_000))
}
