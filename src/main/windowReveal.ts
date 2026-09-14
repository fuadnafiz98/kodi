/**
 * Half-bounce launch: order the native window on screen as soon as it exists.
 *
 * macOS keeps the Dock icon bouncing until the app is on the event loop and a
 * window is visible. Electron's `ready-to-show` waits for the renderer's first
 * paint, which in this app is after the JS bundle — past a native "half bounce"
 * (~400 ms). Showing immediately with a matching `backgroundColor` is the
 * documented Electron path for complex apps.
 *
 * `app.dock.bounce()` is an attention request, not this launch bounce.
 * `NSWindow.animationBehavior` (zoom-from-dock) is not exposed by Electron.
 */

export interface WindowRevealTarget {
  isDestroyed(): boolean
  isVisible(): boolean
  maximize(): void
  show(): void
}

export interface WindowRevealOptions {
  holdHidden: boolean
  maximize: boolean
}

export interface ExistingWindowRevealTarget {
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
}

export function revealCreatedWindow(
  window: WindowRevealTarget,
  options: WindowRevealOptions
): boolean {
  if (options.holdHidden || window.isDestroyed() || window.isVisible()) return false
  if (options.maximize) window.maximize()
  window.show()
  return true
}

/** Cmd+H / kodi:// open: show and focus even if the window was a hidden warmup. */
export function revealExistingWindow(
  window: ExistingWindowRevealTarget | null | undefined
): boolean {
  if (window == null || window.isDestroyed()) return false
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  return true
}

export function shouldHoldWindowHidden(
  startHidden: boolean,
  reviews: readonly { intent: string }[]
): boolean {
  if (startHidden) return true
  if (reviews.some((review) => review.intent === 'open')) return false
  return reviews.length > 0 && reviews.every((review) => review.intent === 'warmup')
}

export function shouldRevealForReview(intent: string): boolean {
  return intent === 'open'
}
