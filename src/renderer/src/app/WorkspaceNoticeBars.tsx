export interface EditConflictBarProps {
  /** The file that moved under the draft, or `null` when there is no conflict. */
  conflict: { path: string } | null
  onKeepDraft(): void
  onReloadFromDisk(): void
}

export function EditConflictBar({
  conflict,
  onKeepDraft,
  onReloadFromDisk
}: EditConflictBarProps): React.JSX.Element | null {
  if (conflict == null) return null
  return (
    <div className="review-bar pr-review-readonly" role="alert">
      {conflict.path} changed on disk while you were editing it.
      <button className="bar-button" type="button" onClick={onKeepDraft}>Keep my draft</button>
      <button className="bar-button" type="button" onClick={onReloadFromDisk}>Reload from disk</button>
    </div>
  )
}
