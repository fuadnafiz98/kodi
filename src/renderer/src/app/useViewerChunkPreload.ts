import { useEffect } from 'react'

import type { WorkspaceView } from './AppView'
import { getErrorMessage } from '../explorer/repositoryApi'
import {
  preloadDiffSurface,
  preloadMultiFileReview,
  preloadWorkspaceViewer
} from './workspaceBoot'

/**
 * Current view first so the first paint is not waiting on the other chunk, then
 * warm the sibling so file ↔ review does not flash the code skeleton.
 */
export function useViewerChunkPreload(
  workspaceView: WorkspaceView,
  onError: (message: string) => void
): void {
  useEffect(() => {
    let active = true
    void preloadWorkspaceViewer(workspaceView)
      .then(async () => {
        if (!active) return
        if (workspaceView === 'multi') await preloadDiffSurface()
        else await preloadMultiFileReview()
      })
      .catch((error: unknown) => {
        if (active) onError(getErrorMessage(error))
      })
    return () => { active = false }
  }, [onError, workspaceView])
}
