/**
 * The command palette and the explorer live in sibling subtrees, so a directory
 * row cannot reach the tree through props. The workspace registers its reveal
 * while it is mounted and the palette calls the module function; nothing
 * re-renders on the way.
 */
export type ExplorerRevealHandler = (path: string) => void

let handler: ExplorerRevealHandler | null = null

export function setExplorerRevealHandler(next: ExplorerRevealHandler): () => void {
  handler = next
  return () => {
    if (handler === next) handler = null
  }
}

/** Returns false when no workspace is mounted to reveal in. */
export function revealInExplorer(path: string): boolean {
  if (handler == null || path === '') return false
  handler(path)
  return true
}
