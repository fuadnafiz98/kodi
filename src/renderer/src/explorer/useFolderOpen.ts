import { useCallback, useRef, useState } from 'react'

import type { RepositorySnapshot } from '../../../shared/contracts'
import { isLiveSnapshot, waitForLiveSnapshot } from './folderOpenSettle'
import type { RecentFolder } from './recentFolders'
import { getErrorMessage, requireRepositoryApi } from './repositoryApi'

export interface FolderOpenOptions {
  /** Recent folders, so a picked path can reuse the remembered open. */
  recentFolders: readonly RecentFolder[]
  /** Adopt a snapshot an open returned: view, first file, recents, skeleton arming. */
  adoptSnapshot(snapshot: RepositorySnapshot): void
  /** Start loading the workspace chunk before the snapshot lands. */
  ensureWorkspaceRoot(): void
  /** Runs before the picker opens, so the palette can get out of the way. */
  onBeforePickerOpen(): void
  /** `null` clears the banner, which every open does before it starts. */
  onError(message: string | null): void
}

export interface FolderOpenControls {
  opening: boolean
  openingRecentPath: string | null
  folderPickerOpen: boolean
  openFolder(): Promise<void>
  openFolderPicker(): void
  closeFolderPicker(): boolean
  toggleFolderPicker(): void
  openFolderFromPicker(path: string): Promise<void>
  openRecentFolder(folder: RecentFolder): Promise<void>
}

/**
 * Everything that turns "the reader wants another folder" into a snapshot: the
 * native dialog, the picker popover and the recent-folder rows.
 */
export function useFolderOpen({
  recentFolders,
  adoptSnapshot,
  ensureWorkspaceRoot,
  onBeforePickerOpen,
  onError
}: FolderOpenOptions): FolderOpenControls {
  const [opening, setOpening] = useState(false)
  const [openingRecentPath, setOpeningRecentPath] = useState<string | null>(null)
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const folderPickerOpenRef = useRef(false)

  const openFolder = useCallback(async () => {
    ensureWorkspaceRoot()
    setOpening(true)
    onError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().openFolder()
      if (nextSnapshot != null) adoptSnapshot(nextSnapshot)
    } catch (openError) {
      onError(getErrorMessage(openError))
    }
    setOpening(false)
  }, [adoptSnapshot, ensureWorkspaceRoot, onError])

  const closeFolderPicker = useCallback((): boolean => {
    if (!folderPickerOpenRef.current) return false
    folderPickerOpenRef.current = false
    setFolderPickerOpen(false)
    return true
  }, [])

  const openFolderPicker = useCallback(() => {
    onBeforePickerOpen()
    folderPickerOpenRef.current = true
    setFolderPickerOpen(true)
  }, [onBeforePickerOpen])

  const toggleFolderPicker = useCallback(() => {
    if (folderPickerOpenRef.current) {
      folderPickerOpenRef.current = false
      setFolderPickerOpen(false)
      return
    }
    openFolderPicker()
  }, [openFolderPicker])

  // The picker stays up, with the picked row marked, until the tree behind it is
  // the real one. Closing on the skeleton put a status-less tree on screen and
  // then rearranged it a moment later.
  const openThroughPicker = useCallback(async (
    path: string,
    load: () => Promise<RepositorySnapshot>,
    describeFailure: (message: string) => string
  ) => {
    ensureWorkspaceRoot()
    setOpeningRecentPath(path)
    onError(null)
    try {
      const nextSnapshot = await load()
      adoptSnapshot(nextSnapshot)
      if (!isLiveSnapshot(nextSnapshot)) await waitForLiveSnapshot(nextSnapshot.root)
    } catch (openError) {
      onError(describeFailure(getErrorMessage(openError)))
    }
    setOpeningRecentPath(null)
    closeFolderPicker()
  }, [adoptSnapshot, closeFolderPicker, ensureWorkspaceRoot, onError])

  const openRecentFolder = useCallback(async (folder: RecentFolder) => {
    await openThroughPicker(
      folder.path,
      () => requireRepositoryApi().openPath(folder.path),
      (message) => `Cannot open “${folder.name}”. ${message}`
    )
  }, [openThroughPicker])

  const openFolderFromPicker = useCallback(async (path: string) => {
    const recent = recentFolders.find((folder) => folder.path === path)
    if (recent != null) {
      await openRecentFolder(recent)
      return
    }
    await openThroughPicker(
      path,
      () => requireRepositoryApi().openPickedFolder(path),
      (message) => `Cannot open that folder. ${message}`
    )
  }, [openRecentFolder, openThroughPicker, recentFolders])

  return {
    opening,
    openingRecentPath,
    folderPickerOpen,
    openFolder,
    openFolderPicker,
    closeFolderPicker,
    toggleFolderPicker,
    openFolderFromPicker,
    openRecentFolder
  }
}
