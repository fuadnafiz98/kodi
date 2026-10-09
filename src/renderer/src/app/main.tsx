import { applyRestoreHintToDocument } from '../../../shared/sessionRestore'
import { prewarmDiffWorker } from '../diff/diffWorkerConfig'
import { requestStartupReview } from '../review/startupReviewRequest'
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
// The first screen's highlight worker, patch and highlight, fetched alongside
// the boot chunk rather than after the viewer mounts. A Cmd+H launch opens a
// pull request, not the cached review.
if (window.repository?.cachedWorkspace != null && window.repository.restoreHint?.pendingPullRequestUrl == null) {
  // The theme loader awaits the tokenizer core before it loads the theme, so
  // the core is fetched now rather than once the startup module asks for it.
  void import('shiki/core').catch(() => undefined)
  prewarmDiffWorker()
  requestStartupReview(() => import('../review/startupReview')
    .then(({ startStartupReview }) => startStartupReview(sessionSnapshot)))
}
