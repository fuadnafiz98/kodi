/**
 * Main keeps a launch's window hidden until the renderer says its first screen
 * is final, so the first frame a reader sees is the one that stays: no empty
 * window, no unstyled tree, no plain-text diff recoloured a moment later. Each
 * view that can be the first screen reports here; every report after the first
 * is ignored, and main shows the window anyway if none arrives.
 */

// A file the highlighter never colours (plain text, a massive diff) has no
// highlighted render to wait for.
const UNHIGHLIGHTED_GRACE_MS = 250

let reported = false
let fallback: ReturnType<typeof setTimeout> | undefined
const pending = new Set<object>()

export function reportFirstScreen(): void {
  if (reported) return
  reported = true
  clearTimeout(fallback)
  pending.clear()
  performance.mark('kodi:first-screen-final')
  // Two frames: the one that draws the final DOM, then one that has presented it.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    performance.mark('kodi:first-screen-reported')
    window.repository?.reportFirstScreen?.()
  }))
}

/** Reports after `ms` unless something reports first; a later call moves the deadline. */
export function reportFirstScreenAfter(ms: number): void {
  if (reported) return
  clearTimeout(fallback)
  fallback = setTimeout(reportFirstScreen, ms)
}

interface RenderedInstance {
  hunksRenderer?: { renderCache?: { result?: unknown; highlighted?: boolean } }
  fileRenderer?: { renderCache?: { result?: unknown; highlighted?: boolean } }
}

/**
 * From a viewer's `onPostRender`: the first screen is final once every item it
 * drew has its highlighted render. Reads the renderer's cache, which the
 * library keeps on the instance.
 */
export function noteFirstScreenRender(instance: unknown, phase: string): void {
  if (reported || instance == null || typeof instance !== 'object') return
  if (phase === 'unmount') {
    pending.delete(instance)
  } else {
    if (pending.size === 0) reportFirstScreenAfter(UNHIGHLIGHTED_GRACE_MS)
    pending.add(instance)
  }
  for (const item of pending) {
    const { hunksRenderer, fileRenderer } = item as RenderedInstance
    const cache = hunksRenderer?.renderCache ?? fileRenderer?.renderCache
    if (cache?.result == null || cache.highlighted !== true) return
  }
  if (pending.size > 0) reportFirstScreen()
}
