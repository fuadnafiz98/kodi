const TOAST_HOST_ID = 'kodi-toast-host'
const TOAST_LIFETIME_MS = 1_600
const TOAST_ACTION_LIFETIME_MS = 4_000
const TOAST_FADE_MS = 180
const MAX_VISIBLE_TOASTS = 3

// How many of the currently live toasts have to leave to make room for one more.
// Toasts that are already fading do not count: their box is still on screen but
// it is on its way out, so evicting one of those would move the stack twice.
export function toastEvictionCount(liveToastCount: number, maxVisible = MAX_VISIBLE_TOASTS): number {
  return Math.max(0, liveToastCount - maxVisible + 1)
}

function toastHost(): HTMLElement {
  const existing = document.getElementById(TOAST_HOST_ID)
  if (existing != null) return existing
  const host = document.createElement('div')
  host.id = TOAST_HOST_ID
  host.setAttribute('role', 'status')
  host.setAttribute('aria-live', 'polite')
  // A modal <dialog> paints its backdrop over everything in the normal layer
  // regardless of z-index, so a confirmation raised while the repository panel or
  // the palette is open would be dimmed out of sight. A manual popover puts the
  // host in the top layer without making it modal.
  host.setAttribute('popover', 'manual')
  // Theme tokens are declared on the shell, not the document root, so a toast
  // parked on the body would always render in the dark palette.
  const shell = document.querySelector('.app-shell')
  ;(shell ?? document.body).append(host)
  return host
}

// The top layer stacks in invocation order, so a host shown before a dialog ends
// up beneath its backdrop. Re-showing it on every toast re-promotes it.
function promote(host: HTMLElement): void {
  if (typeof host.showPopover !== 'function') return
  try {
    if (host.matches(':popover-open')) host.hidePopover()
    host.showPopover()
  } catch {
    // A host that is not connected yet stays in the normal layer; the next toast
    // promotes it.
  }
}

function retire(host: HTMLElement): void {
  if (host.childElementCount > 0 || typeof host.hidePopover !== 'function') return
  try {
    host.hidePopover()
  } catch {
    // Already hidden.
  }
}

function dismiss(toast: HTMLElement): void {
  if (toast.dataset.state === 'leaving') return
  window.clearTimeout(Number(toast.dataset.timer))
  toast.dataset.state = 'leaving'
  window.setTimeout(() => {
    const host = toast.parentElement
    toast.remove()
    if (host != null) retire(host)
  }, TOAST_FADE_MS)
}

// Toasts live outside React: the diff viewer's shadow-root listeners are the
// main callers, and routing them through app state would rebuild the viewer.
const SVG_NS = 'http://www.w3.org/2000/svg'
// IconCheckCircle from @pierre/icons, drawn by hand: toasts live outside React.
const SUCCESS_ICON_PATHS = [
  'M12.08 5.975a.75.75 0 0 0-1.16-.95L6.943 9.884 5.03 7.97a.75.75 0 0 0-1.06 1.06l2.5 2.5a.75.75 0 0 0 1.11-.055z',
  'M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8m1.5 0a6.5 6.5 0 1 1 13 0 6.5 6.5 0 0 1-13 0'
]

function successIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of SUCCESS_ICON_PATHS) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    // The ring is two concentric subpaths; evenodd keeps its middle open.
    path.setAttribute('fill-rule', 'evenodd')
    svg.append(path)
  }
  return svg
}

export interface ToastOptions {
  /** A completed, consequential action — it earns a mark and a longer read. */
  tone?: 'success'
}

export function showToast(
  message: string,
  action?: { label: string; run(): void },
  options: ToastOptions = {}
): void {
  const host = toastHost()
  const live = [...host.children].filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.dataset.state !== 'leaving'
  )
  for (const evicted of live.slice(0, toastEvictionCount(live.length))) dismiss(evicted)

  const toast = document.createElement('div')
  toast.className = 'kodi-toast'
  if (options.tone != null) {
    toast.dataset.tone = options.tone
    toast.append(successIcon())
  }
  const label = document.createElement('span')
  label.textContent = message
  toast.append(label)
  if (action != null) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = action.label
    button.addEventListener('click', () => {
      action.run()
      dismiss(toast)
    }, { once: true })
    toast.append(button)
  }
  host.append(toast)
  promote(host)
  // Entering from the removal state keeps the transition symmetric.
  toast.dataset.state = 'entering'
  window.requestAnimationFrame(() => {
    toast.dataset.state = 'visible'
  })

  toast.dataset.timer = String(window.setTimeout(
    () => dismiss(toast),
    action == null ? TOAST_LIFETIME_MS : TOAST_ACTION_LIFETIME_MS
  ))
}
