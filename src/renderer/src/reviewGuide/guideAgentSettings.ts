import { useEffect, useState, useSyncExternalStore } from 'react'

import type { AgentModelCatalog, AgentProvider, AgentProviderStatuses } from '../../../shared/contracts'
import type { GuideAgentContext } from './reviewGuideHost'

/**
 * The model the Guide writes with. `provider: null` follows the agent dock;
 * otherwise the Guide keeps its own provider, model, effort and instructions.
 */
export interface GuideAgentChoice {
  provider: AgentProvider | null
  model: string
  effort: string
  instructions: string
}

export interface GuideRun {
  provider: AgentProvider
  model: string
  effort: string
  customPrompt?: string
}

const STORAGE_KEY = 'kodi:guide-agent:v1'
const MAX_INSTRUCTIONS = 4_000
const FOLLOW_DOCK: GuideAgentChoice = { provider: null, model: '', effort: '', instructions: '' }

function read(): GuideAgentChoice {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<GuideAgentChoice> | null
    if (parsed == null) return FOLLOW_DOCK
    return {
      provider: parsed.provider === 'claude' || parsed.provider === 'codex' ? parsed.provider : null,
      model: typeof parsed.model === 'string' ? parsed.model.slice(0, 128) : '',
      effort: typeof parsed.effort === 'string' ? parsed.effort.slice(0, 32) : '',
      instructions: typeof parsed.instructions === 'string' ? parsed.instructions.slice(0, MAX_INSTRUCTIONS) : ''
    }
  } catch {
    return FOLLOW_DOCK
  }
}

let current: GuideAgentChoice | null = null
const listeners = new Set<() => void>()

export function guideAgentChoice(): GuideAgentChoice {
  current ??= read()
  return current
}

export function setGuideAgentChoice(change: Partial<GuideAgentChoice>): void {
  const next = { ...guideAgentChoice(), ...change }
  next.instructions = next.instructions.slice(0, MAX_INSTRUCTIONS)
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Private storage: the choice lasts until the window closes.
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useGuideAgentChoice(): GuideAgentChoice {
  return useSyncExternalStore(subscribe, guideAgentChoice, guideAgentChoice)
}

/** What a run is asked with: the Guide's own choice, or the dock's while it follows the dock. */
export function resolveGuideRun(choice: GuideAgentChoice, dock: Pick<GuideAgentContext, 'provider' | 'model' | 'effort'>): GuideRun {
  const instructions = choice.instructions.trim()
  const base = choice.provider == null
    ? { provider: dock.provider, model: dock.model, effort: dock.effort }
    : { provider: choice.provider, model: choice.model, effort: choice.effort }
  return instructions === '' ? base : { ...base, customPrompt: instructions }
}

// Both lists change rarely; one fetch per window, refreshed after a sign-in.
let catalogPromise: Promise<AgentModelCatalog | null> | null = null
let statusPromise: Promise<AgentProviderStatuses | null> | null = null

// A missing bridge (tests, a window still starting) answers null, not a throw.
function ask<T>(call: (() => Promise<T>) | undefined): Promise<T | null> {
  try {
    return call == null ? Promise.resolve(null) : call().catch(() => null)
  } catch {
    return Promise.resolve(null)
  }
}

function loadCatalog(): Promise<AgentModelCatalog | null> {
  const repository = window.repository
  catalogPromise ??= ask(typeof repository?.getAgentModels === 'function' ? () => repository.getAgentModels() : undefined)
  return catalogPromise
}

function loadStatuses(refresh: boolean): Promise<AgentProviderStatuses | null> {
  if (refresh) statusPromise = null
  const repository = window.repository
  statusPromise ??= ask(typeof repository?.getAgentStatuses === 'function' ? () => repository.getAgentStatuses() : undefined)
  return statusPromise
}

/** The models of both providers and who is signed in to each; null until they answer. */
export function useGuideAgentCatalog(): {
  catalog: AgentModelCatalog | null
  statuses: AgentProviderStatuses | null
  refresh(): void
} {
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null)
  const [statuses, setStatuses] = useState<AgentProviderStatuses | null>(null)
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    let live = true
    void loadCatalog().then((value) => { if (live) setCatalog(value) })
    void loadStatuses(generation > 0).then((value) => { if (live) setStatuses(value) })
    return () => { live = false }
  }, [generation])
  return { catalog, statuses, refresh: () => setGeneration((value) => value + 1) }
}
