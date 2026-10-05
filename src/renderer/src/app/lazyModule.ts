import { useEffect, useSyncExternalStore } from 'react'

/** A module fetched the first time a surface actually needs it, then kept. */
export interface LazyModule<Module> {
  get(): Module | null
  load(): Promise<Module>
  subscribe(listener: () => void): () => void
}

export function createLazyModule<Module>(importer: () => Promise<Module>): LazyModule<Module> {
  let loaded: Module | null = null
  let pending: Promise<Module> | null = null
  const listeners = new Set<() => void>()
  return {
    get: () => loaded,
    load() {
      if (loaded != null) return Promise.resolve(loaded)
      pending ??= importer().then((module) => {
        loaded = module
        for (const listener of listeners) listener()
        return module
      }, (error: unknown) => {
        pending = null
        throw error
      })
      return pending
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}

/**
 * The module once it is here, asked for as soon as `wanted` is: a chunk read
 * from disk lands in a few milliseconds, well before anything it draws is
 * interactive. A failed fetch leaves the surface without it; the next want asks
 * again.
 */
export function useLazyModule<Module>(module: LazyModule<Module>, wanted: boolean): Module | null {
  const loaded = useSyncExternalStore(module.subscribe, module.get)
  useEffect(() => {
    if (!wanted || loaded != null) return
    module.load().catch(() => {})
  }, [loaded, module, wanted])
  return loaded
}
