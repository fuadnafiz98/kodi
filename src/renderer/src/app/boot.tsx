import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import type { RepositorySnapshot } from '../../../shared/contracts'
import { initialWorkspacePaint } from '../../../shared/workspaceCache'
import { App } from './App'
import { AppErrorBoundary } from './AppErrorBoundary'
import { loadCommandPalette } from '../palette/commandPaletteModule'
import { warmFileSearchIndex } from '../palette/fileSearch'
import { getEditorThemeType, loadPreferences } from '../settings/preferences'
import { automaticWorkspaceView } from '../explorer/workspaceMode'
import { preloadMultiFileReview, preloadWorkspaceRoot, preloadWorkspaceViewer } from './workspaceBoot'
import './styles.css'

export function mountApp(sessionSnapshot: Promise<RepositorySnapshot | null>): void {
  void import('@fontsource-variable/inter/opsz.css')
  void import('@fontsource-variable/fira-code/wght.css')

  const preferences = loadPreferences()

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AppErrorBoundary>
        <App initialPreferences={preferences} sessionSnapshot={sessionSnapshot} />
      </AppErrorBoundary>
    </StrictMode>
  )

  // Cmd+P is the first thing many readers press. The chunk is small and the
  // download overlaps the first paint, so the palette is resident before the
  // keystroke instead of paying React's 300 ms Suspense fallback throttle.
  void loadCommandPalette().catch(() => undefined)

  // The workspace and viewer chunks are ~1.9 MB together. Awaiting them here
  // held the window blank until they had been parsed and evaluated; App already
  // paints the cached tree through CachedWorkspaceFallback and swaps to
  // WorkspaceRoot when the module store notifies, so starting the loads is
  // enough. Reading the cached paint after render keeps it off the paint path.
  const cachedPaint = initialWorkspacePaint(window.repository?.cachedWorkspace ?? null)

  // The palette's index over the cached path list, built in the first idle gap
  // rather than inside the first Cmd+P.
  warmFileSearchIndex(cachedPaint.snapshot?.paths)

  if (window.repository?.restoreHint?.pendingPullRequestUrl != null) {
    // This launch is a Cmd+H. The review lands in a New tab over the desk, so the
    // multi-file viewer is the chunk that has to be resident, not whichever one
    // the cached workspace was last showing.
    void preloadMultiFileReview().catch(() => undefined)
    void preloadWorkspaceRoot().catch(() => undefined)
  } else if (cachedPaint.snapshot != null) {
    void preloadWorkspaceRoot().catch(() => undefined)
    void preloadWorkspaceViewer(cachedPaint.workspaceView).catch(() => undefined)
  } else if (preferences.restoreLastFolder) {
    void preloadWorkspaceRoot().catch(() => undefined)
    void sessionSnapshot.then((snapshot) => snapshot == null
      ? undefined
      : preloadWorkspaceViewer(automaticWorkspaceView(snapshot, null))).catch(() => undefined)
  }

  // Preferences live in renderer storage, but main needs two of them before a
  // window exists: the background colour it paints during resize and before first
  // paint, and whether to reopen the last folder while the renderer boots.
  void window.repository?.setStartupPreferences({
    themeType: getEditorThemeType(preferences.editorTheme),
    restoreLastFolder: preferences.restoreLastFolder
  }).catch((error) => console.warn('Could not send startup preferences to the main process:', error))
}
