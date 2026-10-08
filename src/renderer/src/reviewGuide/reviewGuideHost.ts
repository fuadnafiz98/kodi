import type { AgentModelOption, AgentProvider, AgentRequestSubject } from '../../../shared/contracts'

/**
 * The few facts the review (a startup module) and the Guide view (a lazy
 * chunk) share. Types only, behind a window global: a runtime import between
 * the two would pull the chunk, or the review's preload list, into startup.
 */

export type ReviewView = 'diff' | 'guide'

/** Where the guide puts each file: its rank, and a pill on a section's first file. */
export interface GuideItemOrder {
  rank: ReadonlyMap<string, number>
  pills: ReadonlyMap<string, string>
}

export type GuideSwitchStatus = 'idle' | 'loading' | 'ready'

/** The agent dock's current choice, and the active review it would describe. */
export interface GuideAgentContext {
  subject: AgentRequestSubject | null
  provider: AgentProvider
  model: string
  effort: string
  models: readonly AgentModelOption[]
  login(provider: AgentProvider): void
  openAgent(): void
}

export interface ReviewGuideHost {
  /** Bumped on every change, for useSyncExternalStore. */
  revision: number
  subscribe(listener: () => void): () => void
  view(worldId: string): ReviewView
  setView(worldId: string, view: ReviewView): void
  order(worldId: string): GuideItemOrder | null
  setOrder(worldId: string, order: GuideItemOrder | null): void
  status(worldId: string): GuideSwitchStatus
  setStatus(worldId: string, status: GuideSwitchStatus): void
  agent: GuideAgentContext | null
  setAgent(agent: GuideAgentContext | null): void
  /** A closed tab: its guide is cancelled and forgotten. */
  forget(worldId: string): void
  /** Set by the Guide chunk once loaded. */
  onForget: ((worldId: string) => void) | null
  /** Opens a file in the reader's editor (Settings › External editor). */
  openInEditor(path: string, line: number | null): void
}

declare global {
  interface Window {
    __kodiReviewGuide?: ReviewGuideHost
  }
}
