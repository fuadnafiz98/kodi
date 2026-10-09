import { useSyncExternalStore } from 'react'

import type { AgentRequestSubject, RepositoryChangeEvent } from '../../../shared/contracts'
import type {
  NormalizedGuide,
  ReviewGuidePhase,
  ReviewGuideReply,
  ReviewGuideUnavailableCode
} from '../../../shared/reviewGuide'
import type { GuideAgentContext, ReviewGuideHost } from './reviewGuideHost'

export interface GuideState {
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  phase?: ReviewGuidePhase
  startedAt?: number
  guide?: NormalizedGuide
  reason?: string
  code?: ReviewGuideUnavailableCode
  cached?: boolean
  /** Files changed since the guide was written; empty when it is current. */
  stalePaths: ReadonlySet<string>
  stale: boolean
  /** Ready while the reader was down the review: waiting for "Show it". */
  pendingOrder: boolean
  /** The disk was asked once; a stored guide shows without a model call. */
  askedCache: boolean
}

const IDLE: GuideState = { status: 'idle', stale: false, stalePaths: new Set(), pendingOrder: false, askedCache: false }

/**
 * Per-tab guide state, outside React: progress events and change events touch
 * one tab's entry and re-render only what reads it, never the workspace.
 */
class ReviewGuideStore {
  #states = new Map<string, GuideState>()
  #listeners = new Set<() => void>()
  #tokens = new Map<string, number>()
  #unsubscribers: Array<() => void> = []
  #connectedTo: typeof window.repository = undefined

  get(tabId: string): GuideState {
    return this.#states.get(tabId) ?? IDLE
  }

  set(tabId: string, update: Partial<GuideState>): void {
    const next = { ...this.get(tabId), ...update }
    this.#states.set(tabId, next)
    const host = window.__kodiReviewGuide
    host?.setStatus(tabId, next.status === 'loading' ? 'loading' : next.status === 'ready' ? 'ready' : 'idle')
    for (const listener of this.#listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  /** Listens to main once: progress for any tab, and file changes for staleness. */
  connect(host: ReviewGuideHost): void {
    const repository = window.repository
    if (repository == null || this.#connectedTo === repository) return
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe()
    this.#connectedTo = repository
    this.#unsubscribers.push(repository.onReviewGuideProgress((event) => {
      const state = this.#states.get(event.tabId)
      if (state?.status !== 'loading' || state.phase === event.phase) return
      this.set(event.tabId, { phase: event.phase })
    }))
    this.#unsubscribers.push(repository.onDidChange((change) => this.#markChanged(change)))
    host.onForget = (worldId) => this.forget(worldId)
  }

  #markChanged(change: RepositoryChangeEvent): void {
    const deskId = `desk:${change.snapshot.root}`
    const state = this.#states.get(deskId)
    const guide = state?.guide
    if (state?.status !== 'ready' || guide == null) return
    const guidePaths = new Set(guide.sections.flatMap((section) => section.files.map((file) => file.path)))
    const touched = change.invalidateAll === true
      ? [...guidePaths]
      : change.changedPaths.filter((path) => guidePaths.has(path))
    if (touched.length === 0) return
    this.set(deskId, { stale: true, stalePaths: new Set([...state.stalePaths, ...touched]) })
  }

  async request(
    tabId: string,
    subject: AgentRequestSubject,
    agent: Pick<GuideAgentContext, 'provider' | 'model' | 'effort'> & { customPrompt?: string },
    options: { force?: boolean; cachedOnly?: boolean } = {}
  ): Promise<void> {
    const current = this.get(tabId)
    if (current.status === 'loading' && options.force !== true) return
    if (options.cachedOnly === true && current.askedCache) return
    const token = (this.#tokens.get(tabId) ?? 0) + 1
    this.#tokens.set(tabId, token)
    if (options.cachedOnly === true) this.set(tabId, { askedCache: true })
    else this.set(tabId, { status: 'loading', phase: 'collecting', startedAt: Date.now(), askedCache: true })
    let reply: ReviewGuideReply
    try {
      if (window.repository == null) throw new Error('Kodi is not ready.')
      reply = await window.repository.getReviewGuide({
        subject,
        provider: agent.provider,
        model: agent.model,
        effort: agent.effort,
        ...(agent.customPrompt == null ? {} : { customPrompt: agent.customPrompt }),
        ...(options.force === true ? { force: true } : {}),
        ...(options.cachedOnly === true ? { cachedOnly: true } : {})
      })
    } catch (error) {
      reply = { status: 'unavailable', reason: error instanceof Error ? error.message : 'The guide could not be written.', code: 'failed' }
    }
    if (this.#tokens.get(tabId) !== token) return
    if (reply.status === 'ready') {
      this.set(tabId, {
        status: 'ready',
        guide: reply.guide,
        cached: reply.cached,
        stale: false,
        stalePaths: new Set(),
        reason: undefined,
        code: undefined,
        phase: undefined
      })
      return
    }
    if (options.cachedOnly === true) {
      // Nothing stored: the view offers Generate; a failure to read is not news.
      if (this.get(tabId).status !== 'ready') this.set(tabId, { status: 'idle' })
      return
    }
    this.set(tabId, { status: 'unavailable', reason: reply.reason, code: reply.code, phase: undefined })
  }

  /** A guide that came from outside (`kodi --guide-file`): shown as it is, any ask in flight dropped. */
  adopt(tabId: string, reply: ReviewGuideReply): void {
    this.#tokens.set(tabId, (this.#tokens.get(tabId) ?? 0) + 1)
    if (reply.status === 'ready') {
      this.set(tabId, {
        status: 'ready', guide: reply.guide, cached: false, stale: false, stalePaths: new Set(),
        reason: undefined, code: undefined, phase: undefined, askedCache: true, pendingOrder: false
      })
      return
    }
    this.set(tabId, { status: 'unavailable', reason: reply.reason, code: reply.code, phase: undefined, askedCache: true })
  }

  cancel(tabId: string): void {
    if (this.get(tabId).status !== 'loading') return
    this.#tokens.set(tabId, (this.#tokens.get(tabId) ?? 0) + 1)
    void window.repository?.cancelReviewGuide(tabId).catch(() => {})
    const previous = this.get(tabId).guide
    this.set(tabId, previous == null
      ? { status: 'unavailable', reason: 'The guide was cancelled.', code: 'cancelled', phase: undefined }
      : { status: 'ready', phase: undefined })
  }

  forget(tabId: string): void {
    this.cancel(tabId)
    this.#states.delete(tabId)
    this.#tokens.delete(tabId)
    for (const listener of this.#listeners) listener()
  }
}

export const reviewGuideStore = new ReviewGuideStore()

export function useGuideState(tabId: string): GuideState {
  return useSyncExternalStore(
    reviewGuideStore.subscribe,
    () => reviewGuideStore.get(tabId),
    () => reviewGuideStore.get(tabId)
  )
}
