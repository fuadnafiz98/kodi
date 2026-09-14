import type { AgentActivityUpdate } from '../../../shared/contracts'

const RESET_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit'
})

export function formatActivityStatus(status: AgentActivityUpdate['status']): string {
  if (status === 'waiting') return 'Approval'
  if (status === 'blocked') return 'Blocked'
  if (status === 'failed') return 'Failed'
  if (status === 'running') return 'Running'
  return 'Done'
}

export function formatTokens(value: number): string {
  if (value < 1_000) return Math.round(value).toLocaleString()
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}m`
}

export function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)}ms`
  const seconds = Math.round(value / 1_000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function formatReset(timestamp: number): string {
  const date = new Date(timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp)
  return RESET_TIME_FORMATTER.format(date)
}
