import { useEffect } from 'react'

/**
 * Deep hibernation asks the window to drop every review payload it is holding.
 * Two different parts of the tree know whether that is safe: the workspace owns
 * unsaved editor state, and the git workflow owns in-flight review requests.
 * Neither is an ancestor of the other, so the veto is a registry rather than a
 * prop threaded through the layers between them.
 *
 * A veto returns the reason it is refusing, or null to allow. Main records the
 * reason, so "nothing happened" is never the answer a snooze reports.
 */
type HibernationVeto = () => string | null

const vetoes = new Set<HibernationVeto>()

/** Registers a veto and returns the function that removes it again. */
export function registerHibernationVeto(veto: HibernationVeto): () => void {
  vetoes.add(veto)
  return () => { vetoes.delete(veto) }
}

export function useHibernationVeto(veto: HibernationVeto): void {
  useEffect(() => registerHibernationVeto(veto), [veto])
}

export function firstHibernationBlocker(): string | null {
  for (const veto of vetoes) {
    let reason: string | null = null
    try {
      reason = veto()
    } catch {
      // A veto that throws is treated as a refusal: hibernating past a guard
      // that could not answer is how unsaved work gets destroyed.
      reason = 'a hibernation guard failed'
    }
    if (reason != null) return reason
  }
  return null
}

/**
 * Registers the one listener that answers main. `release` runs only after every
 * veto has allowed it, and returns its own reason when the release itself
 * cannot proceed.
 */
export function useHibernationListener(release: () => string | null): void {
  useEffect(() => window.repository?.onHibernateRequest(() => {
    const blocked = firstHibernationBlocker()
    if (blocked != null) return blocked
    return release()
  }), [release])
}

/** Exported for tests: the registry outlives any single component tree. */
export function clearHibernationVetoes(): void {
  vetoes.clear()
}
