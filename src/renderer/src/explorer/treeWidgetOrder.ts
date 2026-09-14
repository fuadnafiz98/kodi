import { prepareFileTreeInput } from '@pierre/trees'

/**
 * The explorer's own row order, straight from the tree widget. It lives apart
 * from `treeExpansion` so that importing `firstTreePath` — which the boot path
 * does — no longer drags @pierre/trees along with it.
 */
export function orderPathsForTree(filePaths: readonly string[]): string[] {
  return [...prepareFileTreeInput(filePaths).paths]
}
