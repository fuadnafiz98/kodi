import { useSyncExternalStore } from 'react'

export type CommandPaletteModule = typeof import('./CommandPalette')

let loaded: CommandPaletteModule | null = null
let pending: Promise<CommandPaletteModule> | null = null
const listeners = new Set<() => void>()

function getSnapshot(): CommandPaletteModule | null {
  return loaded
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Starts the palette chunk once and notifies subscribers when it lands. Boot calls
 * this after the first render, so by the time a reader presses Cmd+P the module is
 * already resident and the palette mounts on the same frame — a `lazy()` boundary
 * would instead hold React's 300 ms fallback throttle on the first open.
 */
export function loadCommandPalette(): Promise<CommandPaletteModule> {
  if (loaded != null) return Promise.resolve(loaded)
  pending ??= import('./CommandPalette')
    .then((module) => {
      loaded = module
      pending = null
      for (const listener of listeners) listener()
      return module
    })
    .catch((error: unknown) => {
      pending = null
      throw error
    })
  return pending
}

export function useCommandPaletteModule(): CommandPaletteModule | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
