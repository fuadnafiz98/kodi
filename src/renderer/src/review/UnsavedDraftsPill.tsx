import type { FileEditControls } from '../app/AppView'

export function UnsavedDraftsPill({ fileEdit, currentPath }: {
  fileEdit: FileEditControls
  currentPath: string | null
}): React.JSX.Element | null {
  const others = fileEdit.unsavedPaths.filter((path) => path !== currentPath)
  const first = others[0]
  if (first == null) return null
  return (
    <button type="button" className="file-edit-state dirty"
      title={`Unsaved drafts:\n${others.join('\n')}`}
      onClick={() => fileEdit.onOpenPath(first)}>
      {others.length} unsaved
    </button>
  )
}
