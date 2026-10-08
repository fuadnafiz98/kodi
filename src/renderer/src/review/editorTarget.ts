// The line the reader last pointed at in a file (a selected line in the review
// or the single-file view), so "Open in editor" lands there.
let lastPath: string | null = null
let preferredCommand = ''
let lastLine: number | null = null

export function noteEditorLine(path: string | null, line: number | null): void {
  lastPath = path
  lastLine = line
}

export function editorLineFor(path: string): number | null {
  return lastPath === path ? lastLine : null
}

/** Settings › Editor › External editor, as the app last saw it. */
export function setEditorCommand(command: string): void {
  preferredCommand = command
}

/** Opens a repository file in the reader's editor; errors go to the caller. */
export function openFileInEditor(path: string, line: number | null, editorCommand = preferredCommand): Promise<void> {
  return window.repository?.openInEditor(path, line ?? editorLineFor(path), editorCommand) ?? Promise.resolve()
}
