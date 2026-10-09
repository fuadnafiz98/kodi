import { startTransition, useEffect, useState } from 'react'

import type { WorkspaceView } from './AppView'

type WorkspaceRootComponent = (typeof import('./WorkspaceRoot'))['default']
type DiffSurfaceComponent = (typeof import('../diff/DiffSurface'))['default']
type MultiFileReviewComponent = (typeof import('../review/MultiFileReview'))['default']

interface ModuleStore<Component> {
  getSnapshot(): Component | null
  load(): Promise<Component>
  subscribe(listener: () => void): () => void
}

function createModuleStore<Component>(
  importer: () => Promise<{ default: Component }>
): ModuleStore<Component> {
  let component: Component | null = null
  let pending: Promise<Component> | null = null
  const listeners = new Set<() => void>()

  return {
    getSnapshot: () => component,
    load: () => {
      if (component != null) return Promise.resolve(component)
      if (pending != null) return pending
      pending = importer()
        .then((module) => {
          component = module.default
          pending = null
          for (const listener of listeners) listener()
          return component
        })
        .catch((error: unknown) => {
          pending = null
          throw error
        })
      return pending
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

const workspaceRoot = createModuleStore<WorkspaceRootComponent>(() => import('./WorkspaceRoot'))
const diffSurface = createModuleStore<DiffSurfaceComponent>(() => import('../diff/DiffSurface'))
const multiFileReview = createModuleStore<MultiFileReviewComponent>(() => import('../review/MultiFileReview'))

export const getLoadedWorkspaceRoot = workspaceRoot.getSnapshot
export const preloadWorkspaceRoot = workspaceRoot.load
export const subscribeWorkspaceRoot = workspaceRoot.subscribe

export const getLoadedDiffSurface = diffSurface.getSnapshot
export const preloadDiffSurface = diffSurface.load
export const subscribeDiffSurface = diffSurface.subscribe

export const getLoadedMultiFileReview = multiFileReview.getSnapshot
export const preloadMultiFileReview = multiFileReview.load
export const subscribeMultiFileReview = multiFileReview.subscribe

export function preloadWorkspaceViewer(
  view: WorkspaceView
): Promise<DiffSurfaceComponent | MultiFileReviewComponent> {
  return view === 'multi' ? preloadMultiFileReview() : preloadDiffSurface()
}

/**
 * A lazily loaded component, swapped in as a transition. `useSyncExternalStore`
 * rendered the swap synchronously, inside the import's microtask: the workspace
 * and its 3,000-row tree took the main thread for ~60 ms at a launch, and every
 * module load the first screen's highlight waits on (shiki, the theme, the
 * grammar) sat behind it. A transition renders in slices that let them through.
 */
export function useLoadedModule<Component>(
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => Component | null
): Component | null {
  const [component, setComponent] = useState<{ current: Component | null }>(() => ({ current: getSnapshot() }))
  useEffect(() => {
    const update = (): void => {
      const next = getSnapshot()
      startTransition(() => setComponent((held) => held.current === next ? held : { current: next }))
    }
    const unsubscribe = subscribe(update)
    // Loaded between the first render and this subscription.
    update()
    return unsubscribe
  }, [getSnapshot, subscribe])
  return component.current
}
