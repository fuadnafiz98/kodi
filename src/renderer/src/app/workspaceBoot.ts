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
