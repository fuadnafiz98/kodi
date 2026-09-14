import type { RepositorySnapshot } from '../../../shared/contracts'

export interface RecentFolder {
  name: string
  path: string
  lastOpenedAt: number
}

const STORAGE_KEY = 'kodi:recent-folders:v1'
const MAX_RECENT_FOLDERS = 8

export function loadRecentFolders(): RecentFolder[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored == null) return []
    const folders = JSON.parse(stored) as unknown
    if (!Array.isArray(folders)) return []
    return folders.filter(isRecentFolder).slice(0, MAX_RECENT_FOLDERS)
  } catch {
    return []
  }
}

export function rememberRecentFolder(
  currentFolders: readonly RecentFolder[],
  snapshot: RepositorySnapshot,
  openedAt = Date.now()
): RecentFolder[] {
  return [
    { name: snapshot.name, path: snapshot.root, lastOpenedAt: openedAt },
    ...currentFolders.filter((folder) => folder.path !== snapshot.root)
  ].slice(0, MAX_RECENT_FOLDERS)
}

export function saveRecentFolders(folders: readonly RecentFolder[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(folders))
  } catch {
    // Recent folders remain available for the current session when storage is unavailable.
  }
}

function isRecentFolder(value: unknown): value is RecentFolder {
  if (value == null || typeof value !== 'object') return false
  const folder = value as Partial<RecentFolder>
  return typeof folder.name === 'string'
    && typeof folder.path === 'string'
    && typeof folder.lastOpenedAt === 'number'
}
