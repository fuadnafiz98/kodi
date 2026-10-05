import type { RepositoryReview, RepositorySnapshot } from '../../../shared/contracts'
import type { WorkspaceView } from '../app/AppView'
import { firstTreePath } from './treeExpansion'

/**
 * Review is the primary workspace whenever there is something to review.
 * A clean repository and a plain folder use the single-file surface as a file
 * browser instead of presenting an empty review.
 */
export function automaticWorkspaceView(
  snapshot: Pick<RepositorySnapshot, 'kind' | 'statuses'>,
  repositoryReview: RepositoryReview | null
): WorkspaceView {
  return repositoryReview != null || (snapshot.kind === 'git' && snapshot.statuses.length > 0)
    ? 'multi'
    : 'file'
}

/**
 * A changed file opens in the review, anything else on its own. Editing is not
 * a mode to protect: a file's draft outlives leaving it, and the review edits
 * the same drafts in place.
 */
export function workspaceViewForTreePath(pathIsInReview: boolean): WorkspaceView {
  return pathIsInReview ? 'multi' : 'file'
}

/**
 * Paths that belong to the current review surface. A plain folder has no
 * review — treating every project file as one kept clicks stuck in
 * repository-review instead of opening the file.
 */
export function reviewPathsForSnapshot(
  snapshot: Pick<RepositorySnapshot, 'kind' | 'statuses'>,
  repositoryReview: Pick<RepositoryReview, 'files'> | null
): readonly string[] {
  if (repositoryReview != null) return repositoryReview.files.map((file) => file.path)
  if (snapshot.kind === 'git') return snapshot.statuses.map((status) => status.path)
  return []
}

/** First path the explorer would show: folders-first, not byte order. */
export function firstOpenPathForSnapshot(
  snapshot: Pick<RepositorySnapshot, 'kind' | 'statuses' | 'paths'>
): string | null {
  const reviewPaths = reviewPathsForSnapshot(snapshot, null)
  if (reviewPaths.length > 0) return firstTreePath(reviewPaths)
  if (snapshot.kind === 'folder') return firstTreePath(snapshot.paths)
  return null
}
