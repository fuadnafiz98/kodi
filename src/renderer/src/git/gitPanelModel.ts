const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

export const FRESHNESS_TICK_MS = 5_000

export function formatUpdatedAgo(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 'just now'
  const seconds = Math.floor(elapsedMs / 1_000)
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

// Anything that moves HEAD, the index or a remote branch. Two of these at once
// means index.lock contention, or two merges into the same base, so they exclude
// each other. Read-only work (review:, commit:, compare:) never joins the set, so
// opening a review while a merge finishes stays allowed.
const MUTATING_ACTION_PREFIXES = ['sync:', 'checkout:', 'merge:', 'ready:', 'branch:']

export function isMutatingAction(actionKey: string | null): boolean {
  return actionKey != null && MUTATING_ACTION_PREFIXES.some((prefix) => actionKey.startsWith(prefix))
}

export function formatRelativeDate(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const elapsedDays = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000))
  if (elapsedDays === 0) return 'today'
  if (elapsedDays === 1) return 'yesterday'
  if (elapsedDays < 30) return `${elapsedDays}d ago`
  return shortDateFormatter.format(timestamp)
}
