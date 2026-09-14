import { useEffect, useState } from 'react'

const STORAGE_KEY_PREFIX = 'kodi:recent-files:v1:'
const MAX_RECENT_FILES = 20

export const NO_RECENT_FILES: readonly string[] = Object.freeze([])

interface RecentFilesState {
  root: string | null
  files: readonly string[]
}

const EMPTY_STATE: RecentFilesState = { root: null, files: NO_RECENT_FILES }

function storageKey(root: string): string {
  return `${STORAGE_KEY_PREFIX}${root}`
}

export function loadRecentFiles(root: string): readonly string[] {
  try {
    const stored = localStorage.getItem(storageKey(root))
    if (stored == null) return NO_RECENT_FILES
    const files = JSON.parse(stored) as unknown
    if (!Array.isArray(files)) return NO_RECENT_FILES
    const paths = files.filter((file): file is string => typeof file === 'string')
    return paths.length === 0 ? NO_RECENT_FILES : paths.slice(0, MAX_RECENT_FILES)
  } catch {
    return NO_RECENT_FILES
  }
}

export function rememberRecentFile(
  current: readonly string[],
  path: string
): readonly string[] {
  if (current[0] === path) return current
  return [path, ...current.filter((file) => file !== path)].slice(0, MAX_RECENT_FILES)
}

export function saveRecentFiles(root: string, files: readonly string[]): void {
  try {
    localStorage.setItem(storageKey(root), JSON.stringify(files))
  } catch {
    // Recents stay available for this session when storage is full or blocked.
  }
}

/**
 * The palette leads its empty-query list with the files this reader was last in,
 * so the list has to survive a relaunch. Kept per root: two projects do not share
 * a history, and switching roots must never write one project's list under the
 * other's key — hence the root travels with the list in state.
 */
export function useRecentFiles(root: string | null, selectedPath: string | null): readonly string[] {
  const [state, setState] = useState<RecentFilesState>(EMPTY_STATE)

  useEffect(() => {
    setState({ root, files: root == null ? NO_RECENT_FILES : loadRecentFiles(root) })
  }, [root])

  useEffect(() => {
    if (root == null || selectedPath == null) return
    setState((current) => {
      if (current.root !== root) return current
      const files = rememberRecentFile(current.files, selectedPath)
      return files === current.files ? current : { root, files }
    })
  }, [root, selectedPath])

  useEffect(() => {
    if (state.root == null || state.files.length === 0) return
    saveRecentFiles(state.root, state.files)
  }, [state])

  return state.root === root ? state.files : NO_RECENT_FILES
}
