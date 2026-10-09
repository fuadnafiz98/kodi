import type { AgentRequestSubject } from '../../../shared/contracts'
import type { GuideAutoGenerate } from '../settings/preferences'
import type { GuideAgentContext } from './reviewGuideHost'
import { reviewGuideStore } from './reviewGuideStore'
import { guideAgentChoice, resolveGuideRun } from './guideAgentSettings'

export interface AutoGuideCandidate {
  worldId: string
  kind: 'pull-request' | 'comparison' | 'working-tree'
  /** The head the guide would describe; a working tree has none. */
  headOid: string | null
  fileCount: number
  /** The review's patch, as pages, to count hunks in; null when not counted. */
  patchPages: readonly string[] | null
}

// A guide over this much is long to write and long to read; the reader asks.
export const AUTO_GUIDE_MAX_FILES = 120
export const AUTO_GUIDE_MAX_HUNKS = 400

const started = new Set<string>()

function countHunks(pages: readonly string[]): number {
  let hunks = 0
  for (const page of pages) {
    let index = page.startsWith('@@ ') ? 0 : page.indexOf('\n@@ ')
    while (index !== -1) {
      hunks += 1
      if (hunks > AUTO_GUIDE_MAX_HUNKS) return hunks
      index = page.indexOf('\n@@ ', index + 1)
    }
  }
  return hunks
}

export function autoGuideAllowed(mode: GuideAutoGenerate, candidate: AutoGuideCandidate): boolean {
  if (mode === 'off') return false
  if (mode === 'pull-requests' && candidate.kind !== 'pull-request') return false
  if (candidate.fileCount === 0 || candidate.fileCount > AUTO_GUIDE_MAX_FILES) return false
  return candidate.patchPages == null || countHunks(candidate.patchPages) <= AUTO_GUIDE_MAX_HUNKS
}

/**
 * Starts a review's guide without a click, once per review head: the stored one
 * when there is one, otherwise a model run with the Guide's model. Returns
 * whether it asked.
 */
export function autoGenerateGuide(
  mode: GuideAutoGenerate,
  candidate: AutoGuideCandidate,
  subject: AgentRequestSubject,
  agent: Pick<GuideAgentContext, 'provider' | 'model' | 'effort'>
): boolean {
  const key = `${candidate.worldId}\n${candidate.headOid ?? ''}`
  if (started.has(key) || subject.tabId !== candidate.worldId) return false
  if (!autoGuideAllowed(mode, candidate)) return false
  if (reviewGuideStore.get(candidate.worldId).status !== 'idle') return false
  started.add(key)
  const host = window.__kodiReviewGuide
  if (host != null) reviewGuideStore.connect(host)
  // The Guide's own model when one is chosen there, the dock's otherwise.
  const run = resolveGuideRun(guideAgentChoice(), agent)
  void reviewGuideStore.request(candidate.worldId, subject, run, { cachedOnly: true }).then(() => {
    if (reviewGuideStore.get(candidate.worldId).status === 'idle') void reviewGuideStore.request(candidate.worldId, subject, run)
  })
  return true
}

/** For tests: forget which reviews were started. */
export function resetAutoGuide(): void {
  started.clear()
}
