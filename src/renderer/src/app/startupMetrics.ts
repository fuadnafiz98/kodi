import type { RendererStartupMetrics } from '../../../shared/contracts'

type RendererStartupMilestone = keyof RendererStartupMetrics

const rendererStartupMetrics: RendererStartupMetrics = {
  rendererLoaded: null,
  reactCommitted: null,
  snapshotReady: null,
  explorerCommitted: null,
  viewerCommitted: null
}

export function markRendererStartup(milestone: RendererStartupMilestone): void {
  if (rendererStartupMetrics[milestone] != null) return
  rendererStartupMetrics[milestone] = performance.now()
  performance.mark(`kodi:${milestone.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`)
}

export function getRendererStartupMetrics(): Readonly<RendererStartupMetrics> {
  return rendererStartupMetrics
}
