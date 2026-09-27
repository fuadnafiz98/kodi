// Counters an e2e suite reads off the window over CDP, to assert work that must
// not happen at all — a tree rebuild per save, a comparison refetch per
// `git add`. Bumping a number is the whole cost, so they stay on in every build.
export type KodiCounter = 'treeResets' | 'treeBatches' | 'comparisonRequests' | 'reviewPagedFallbacks' | 'autoHydrations'

declare global {
  interface Window {
    /** Read by scripts/perf and scripts/e2e probes; see workspaceRenderMetric. */
    __kodiMetrics?: { workspaceRenders: number } & Partial<Record<KodiCounter, number>>
    /** Why the last counted event happened, for a probe to print when it fails. */
    __kodiLastReason?: Partial<Record<KodiCounter, string>>
  }
}

export function countKodiMetric(name: KodiCounter, reason?: string): void {
  if (typeof window === 'undefined') return
  if (reason != null) window.__kodiLastReason = { ...window.__kodiLastReason, [name]: reason }
  const metrics = window.__kodiMetrics ?? { workspaceRenders: 0 }
  metrics[name] = (metrics[name] ?? 0) + 1
  window.__kodiMetrics = metrics
}
