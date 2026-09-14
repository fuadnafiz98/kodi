import type { FolderCandidate } from '../../../shared/contracts'
import { displayUserPath } from '../../../shared/folderPath'
import { paletteScore } from '../palette/paletteCommands'
import type { RecentFolder } from './recentFolders'

export const MAX_FOLDER_PICKER_RESULTS = 20

export type FolderPickerRow =
  | { kind: 'folder'; id: string; group: 'Recents' | 'Folders'; folder: FolderCandidate }
  | { kind: 'native'; id: 'native' }

const PATH_SCORE_PENALTY = 200

export function candidateFromRecent(folder: RecentFolder, home: string): FolderCandidate {
  return {
    name: folder.name,
    path: folder.path,
    displayPath: displayUserPath(folder.path, home)
  }
}

export function buildFolderPickerRows(
  recents: readonly RecentFolder[],
  catalog: readonly FolderCandidate[],
  query: string,
  home: string
): FolderPickerRow[] {
  const recentCandidates = recents.map((folder) => candidateFromRecent(folder, home))
  const normalizedQuery = query.trim()
  if (normalizedQuery === '') {
    return [
      ...recentCandidates.map((folder) => ({
        kind: 'folder' as const,
        id: `recent:${folder.path}`,
        group: 'Recents' as const,
        folder
      })),
      { kind: 'native', id: 'native' }
    ]
  }

  const seen = new Set<string>()
  const combined: FolderCandidate[] = []
  for (const folder of [...recentCandidates, ...catalog]) {
    if (seen.has(folder.path)) continue
    seen.add(folder.path)
    combined.push(folder)
  }

  return [
    ...rankFolderCandidates(combined, normalizedQuery, MAX_FOLDER_PICKER_RESULTS).map((folder) => ({
      kind: 'folder' as const,
      id: `folder:${folder.path}`,
      group: 'Folders' as const,
      folder
    })),
    { kind: 'native', id: 'native' }
  ]
}

export function rankFolderCandidates(
  folders: readonly FolderCandidate[],
  query: string,
  limit = MAX_FOLDER_PICKER_RESULTS
): FolderCandidate[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (normalizedQuery === '') return folders.slice(0, limit)

  const scored: Array<{ folder: FolderCandidate; score: number; order: number }> = []
  for (const [order, folder] of folders.entries()) {
    const nameScore = paletteScore(folder.name, normalizedQuery)
    const pathScore = paletteScore(folder.displayPath, normalizedQuery)
    const score = nameScore ?? (pathScore == null ? null : pathScore + PATH_SCORE_PENALTY)
    if (score == null) continue
    scored.push({ folder, score, order })
  }
  scored.sort((left, right) => left.score - right.score || left.order - right.order)
  return scored.slice(0, limit).map((entry) => entry.folder)
}

export function preloadFolderCatalog(): void {
  void window.repository?.listFolderCandidates()
}
