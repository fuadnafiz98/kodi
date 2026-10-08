import { useSyncExternalStore } from 'react'

import type { GuideAgentContext, GuideItemOrder, GuideSwitchStatus, ReviewGuideHost, ReviewView } from '../reviewGuide/reviewGuideHost'
import type { AppPreferences } from '../settings/preferences'
import { openFileInEditor } from './editorTarget'
import type { ReviewWorld } from './useReviewWorlds'

// Which reviews were left on their guide, so a relaunch comes back to it. Only
// guide entries are kept, newest last.
const VIEW_STORAGE_KEY = 'kodi:review-guide-view:v1'
const MAX_REMEMBERED_VIEWS = 64

function readGuideWorlds(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(VIEW_STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []
  } catch {
    return []
  }
}

function createHost(): ReviewGuideHost {
  const guideWorlds = new Set(readGuideWorlds())
  const orders = new Map<string, GuideItemOrder>()
  const statuses = new Map<string, GuideSwitchStatus>()
  const listeners = new Set<() => void>()
  const notify = (): void => {
    host.revision += 1
    for (const listener of listeners) listener()
  }
  const persist = (): void => {
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, JSON.stringify([...guideWorlds].slice(-MAX_REMEMBERED_VIEWS)))
    } catch {
      // A full or blocked store only costs the view after a relaunch.
    }
  }
  const host: ReviewGuideHost = {
    revision: 0,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    view: (worldId) => guideWorlds.has(worldId) ? 'guide' : 'diff',
    setView(worldId, view) {
      if ((view === 'guide') === guideWorlds.has(worldId)) return
      guideWorlds.delete(worldId)
      if (view === 'guide') guideWorlds.add(worldId)
      persist()
      notify()
    },
    order: (worldId) => orders.get(worldId) ?? null,
    setOrder(worldId, order) {
      if (orders.get(worldId) === (order ?? undefined)) return
      if (order == null) orders.delete(worldId)
      else orders.set(worldId, order)
      notify()
    },
    status: (worldId) => statuses.get(worldId) ?? 'idle',
    setStatus(worldId, status) {
      if (host.status(worldId) === status) return
      statuses.set(worldId, status)
      notify()
    },
    agent: null,
    setAgent(agent) {
      host.agent = agent
      notify()
    },
    forget(worldId) {
      host.onForget?.(worldId)
      const had = guideWorlds.has(worldId) || orders.has(worldId) || statuses.has(worldId)
      guideWorlds.delete(worldId)
      orders.delete(worldId)
      statuses.delete(worldId)
      if (had) {
        persist()
        notify()
      }
    },
    onForget: null,
    openInEditor(path, line) {
      void openFileInEditor(path, line).catch(() => {})
    }
  }
  return host
}

/** The one host for the window; module-level so no component writes a global. */
export function reviewGuideHost(): ReviewGuideHost {
  window.__kodiReviewGuide ??= createHost()
  return window.__kodiReviewGuide
}

function subscribe(listener: () => void): () => void {
  return reviewGuideHost().subscribe(listener)
}

function revision(): number {
  return reviewGuideHost().revision
}

/** Re-renders the caller whenever a view, an order or a status changes. */
export function useReviewGuideRevision(): number {
  return useSyncExternalStore(subscribe, revision, revision)
}

export function useReviewView(worldId: string | null | undefined): ReviewView {
  const read = (): ReviewView => worldId == null ? 'diff' : reviewGuideHost().view(worldId)
  return useSyncExternalStore(subscribe, read, read)
}

/** The guide's order while the world shows its guide; null in the Diff view. */
export function useGuideItemOrder(worldId: string | null | undefined): GuideItemOrder | null {
  const read = (): GuideItemOrder | null => {
    if (worldId == null) return null
    const host = reviewGuideHost()
    return host.view(worldId) === 'guide' ? host.order(worldId) : null
  }
  return useSyncExternalStore(subscribe, read, read)
}

export function useGuideSwitchStatus(worldId: string | null | undefined): GuideSwitchStatus {
  const read = (): GuideSwitchStatus => worldId == null ? 'idle' : reviewGuideHost().status(worldId)
  return useSyncExternalStore(subscribe, read, read)
}

/** The agent dock's choice, for the Guide view of the active review. */
let externalGuideWaiting = false
let externalGuideAsking = false

/** Main holds a `kodi --guide-file` guide; it is asked for on each review until one takes it. */
export function expectExternalGuide(): void {
  externalGuideWaiting = true
  offerExternalGuide(reviewGuideHost().agent?.subject ?? null)
}

function offerExternalGuide(subject: GuideAgentContext['subject']): void {
  if (!externalGuideWaiting || externalGuideAsking || subject == null || window.repository == null) return
  externalGuideAsking = true
  void window.repository.takeExternalGuide(subject).then((reply) => {
    externalGuideAsking = false
    if (reply == null) return
    externalGuideWaiting = false
    void import('../reviewGuide/externalGuide').then(({ showExternalGuide }) => showExternalGuide(subject.tabId, reply))
  }, () => {
    externalGuideAsking = false
  })
}

const openedOnGuide = new Set<string>()
const autoAsked = new Set<string>()

function autoGuideRunsHidden(): boolean {
  try {
    return localStorage.getItem('kodi:guide-auto-hidden') === '1'
  } catch {
    return false
  }
}

/**
 * A review that just opened: a pull request may open on its Guide, and its
 * guide may start without a click (Settings › Pull requests › Guides). A probe
 * or a hidden window never spends tokens unless a test asks it to.
 */
export function considerAutoGuide(
  world: ReviewWorld | null,
  agent: GuideAgentContext | null,
  preferences: Pick<AppPreferences, 'guideAutoGenerate' | 'guideOpensFirst'>
): void {
  if (world == null || world.source === 'new') return
  const pullRequest = world.source === 'patch' && world.review.kind === 'github'
  if (pullRequest && preferences.guideOpensFirst && world.loadStatus === 'loading' && !openedOnGuide.has(world.worldId)) {
    openedOnGuide.add(world.worldId)
    reviewGuideHost().setView(world.worldId, 'guide')
  }
  const mode = preferences.guideAutoGenerate
  const subject = agent?.subject
  if (mode === 'off' || (mode === 'pull-requests' && !pullRequest) || agent == null || subject?.tabId !== world.worldId) return
  if (world.source === 'patch' && world.loadStatus !== 'ready') return
  if (document.visibilityState !== 'visible' && !autoGuideRunsHidden()) return
  const headOid = world.source === 'patch' ? world.headOid : world.snapshot.head
  const key = `${world.worldId}\n${headOid ?? ''}`
  if (autoAsked.has(key)) return
  // A working tree seen before its status (a skeleton) or while clean has
  // nothing to describe yet; it is not marked asked, so its first change is.
  if (world.source !== 'patch' && world.snapshot.statuses.length === 0) return
  autoAsked.add(key)
  const candidate = world.source === 'patch'
    ? { worldId: world.worldId, kind: pullRequest ? 'pull-request' as const : 'comparison' as const, headOid, fileCount: world.review.files.length, patchPages: world.patchPages }
    : { worldId: world.worldId, kind: 'working-tree' as const, headOid, fileCount: world.snapshot.statuses.length, patchPages: null }
  void import('../reviewGuide/autoGuide').then(({ autoGenerateGuide }) => autoGenerateGuide(mode, candidate, subject, agent))
}

export function publishGuideAgent(agent: GuideAgentContext | null): void {
  reviewGuideHost().setAgent(agent)
  offerExternalGuide(agent?.subject ?? null)
}

export function forgetReviewGuideWorld(worldId: string): void {
  window.__kodiReviewGuide?.forget(worldId)
}

/** Items in the guide's order; files it does not know keep their load order at the end. */
export function orderReviewItems<Item extends { id: string }>(items: readonly Item[], order: GuideItemOrder | null): readonly Item[] {
  if (order == null) return items
  const unknown = order.rank.size
  return items
    .map((item, index) => [order.rank.get(item.id) ?? unknown + index, item] as const)
    .sort((left, right) => left[0] - right[0])
    .map((entry) => entry[1])
}

export function toggleReviewView(worldId: string | null | undefined): void {
  if (worldId == null) return
  const host = reviewGuideHost()
  host.setView(worldId, host.view(worldId) === 'guide' ? 'diff' : 'guide')
}

export type { ReviewView }
