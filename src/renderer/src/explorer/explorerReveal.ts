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

/**
 * Opening a file from the palette goes through the workspace for the same
 * reason. Selecting the path in app state was not enough: after a click on a
 * file and a scroll away from it, ⌘P back to that file set the value it already
 * held, nothing re-rendered, and the review stayed where it was.
 */
export type WorkspaceFileOpener = (path: string) => void

let fileOpener: WorkspaceFileOpener | null = null

export function setWorkspaceFileOpener(next: WorkspaceFileOpener): () => void {
  fileOpener = next
  return () => {
    if (fileOpener === next) fileOpener = null
  }
}

/** Returns false when no workspace is mounted to open in. */
export function openInWorkspace(path: string): boolean {
  if (fileOpener == null || path === '') return false
  fileOpener(path)
  return true
}
