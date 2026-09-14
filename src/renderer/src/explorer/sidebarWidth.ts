export const DEFAULT_SIDEBAR_WIDTH = 280
export const MIN_SIDEBAR_WIDTH = 200
export const MAX_SIDEBAR_WIDTH = 520

const MIN_CONTENT_WIDTH = 360
const STORAGE_KEY = 'kodi:sidebar-width'

export function clampSidebarWidth(width: number, workspaceWidth = Number.POSITIVE_INFINITY): number {
  const availableMaximum = Math.max(MIN_SIDEBAR_WIDTH, workspaceWidth - MIN_CONTENT_WIDTH)
  return Math.round(Math.min(Math.max(width, MIN_SIDEBAR_WIDTH), MAX_SIDEBAR_WIDTH, availableMaximum))
}

export function loadSidebarWidth(): number {
  try {
    const storedWidth = Number(window.localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(storedWidth) && storedWidth > 0
      ? clampSidebarWidth(storedWidth)
      : DEFAULT_SIDEBAR_WIDTH
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
}

export function saveSidebarWidth(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clampSidebarWidth(width)))
  } catch {
    // The current session still retains the selected width.
  }
}
