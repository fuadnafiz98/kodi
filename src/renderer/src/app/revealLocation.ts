import { useSyncExternalStore } from 'react'

/**
 * Where the next file opened should land: a line named in the palette
 * (`src/app.ts:42`) or a content-search match. Kept outside the workspace so
 * asking for it re-renders only the viewer that shows the file, which takes it
 * once the line can be scrolled to.
 */
export interface RevealLocation {
  path: string
  line: number
}

let pending: RevealLocation | null = null
let revision = 0
const listeners = new Set<() => void>()

export function requestReveal(location: RevealLocation): void {
  pending = location
  revision += 1
  for (const listener of listeners) listener()
}

export function pendingReveal(path: string | null | undefined): RevealLocation | null {
  return path != null && pending?.path === path ? pending : null
}

export function takeReveal(location: RevealLocation): void {
  if (pending === location) pending = null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Changes whenever a reveal is asked for, so an open file can answer a new one. */
export function useRevealRevision(): number {
  return useSyncExternalStore(subscribe, () => revision, () => revision)
}
