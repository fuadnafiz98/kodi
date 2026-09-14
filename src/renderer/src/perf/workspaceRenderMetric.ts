import { getReviewMetrics, markRepositoryWorkspaceRender } from '../review/reviewMetrics'

declare global {
  interface Window {
    /** Read by scripts/perf/startup-probe.mjs to assert 0 workspace renders per keystroke. */
    __kodiMetrics?: { workspaceRenders: number }
  }
}

/**
 * Effect body for `RepositoryWorkspace`: one tick per committed render, mirrored
 * onto the window so a CDP probe can read it without opening the performance HUD.
 */
export function markWorkspaceRender(): void {
  markRepositoryWorkspaceRender()
  const metrics = window.__kodiMetrics ?? { workspaceRenders: 0 }
  metrics.workspaceRenders = getReviewMetrics().workspaceRenders
  window.__kodiMetrics = metrics
}
