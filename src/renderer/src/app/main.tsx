import { applyRestoreHintToDocument } from '../../../shared/sessionRestore'
import { markRendererStartup } from './startupMetrics'

// Rename-era migration: Horus stored its UI state under `horus:` keys. Move any
// that exist once, before a module reads its key. Iterate backwards — removal
// shifts the remaining indices.
try {
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index)
    if (key == null || !key.startsWith('horus:')) continue
    const migrated = `kodi:${key.slice('horus:'.length)}`
    if (localStorage.getItem(migrated) == null) {
      const value = localStorage.getItem(key)
      if (value != null) localStorage.setItem(migrated, value)
    }
    localStorage.removeItem(key)
  }
} catch {
  // localStorage can be unavailable; a failed sweep just means fresh defaults.
}

markRendererStartup('rendererLoaded')
applyRestoreHintToDocument(document.documentElement, window.repository?.restoreHint)

// Kick the restore IPC before the App chunk arrives so it overlaps the download.
const sessionSnapshot = window.repository?.getSessionSnapshot() ?? Promise.resolve(null)
void import('./boot').then(({ mountApp }) => mountApp(sessionSnapshot))
