import { folderNameFromPath } from '../../../shared/folderPath'
import type { PullRequestFolderPreview } from '../../../shared/contracts'
import type { NewWorld, ReviewWorld } from '../review/useReviewWorlds'

export function reviewFolderChip(
  world: NewWorld | null,
  suggested: PullRequestFolderPreview | null
): { name: string | null; path: string | null } {
  if (world == null) return { name: null, path: null }
  if (world.repositoryRoot != null) {
    return { name: folderNameFromPath(world.repositoryRoot), path: world.repositoryRoot }
  }
  return {
    name: suggested?.name ?? null,
    path: suggested?.displayPath ?? suggested?.root ?? null
  }
}

export function isPullRequestWorkspacePending(
  actionKey: string | null,
  activeWorld: ReviewWorld | null
): boolean {
  if (actionKey?.startsWith('review:') === true || actionKey === 'resolve:pull-request') {
    return true
  }
  return activeWorld?.source === 'patch'
    && activeWorld.loadStatus === 'loading'
    && activeWorld.review.files.length === 0
}
