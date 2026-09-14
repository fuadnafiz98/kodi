import { IconInReview, IconRefresh } from '@pierre/icons'

export interface OpenPullRequestFormProps {
  query: string
  /** Why the query could not be parsed, or `null`. */
  error: string | null
  /** True while a review is being opened, which the button reports. */
  opening: boolean
  onQueryChange(query: string): void
  onSubmit(): void
}

/** `#123` or a GitHub URL, straight into a review. */
export function OpenPullRequestForm({
  query,
  error,
  opening,
  onQueryChange,
  onSubmit
}: OpenPullRequestFormProps): React.JSX.Element {
  return (
    <form className="pr-open-form" onSubmit={(event) => {
      event.preventDefault()
      onSubmit()
    }}>
      <label htmlFor="pr-open-input">Open pull request</label>
      <div>
        <input
          id="pr-open-input"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="#123 or GitHub URL"
          spellCheck={false}
          autoCapitalize="none"
          aria-describedby={error == null ? undefined : 'pr-open-error'}
          aria-invalid={error != null}
        />
        <button type="submit" disabled={query.trim() === ''} aria-busy={opening}>
          {opening ? <IconRefresh className="spin" /> : <IconInReview />}
          Review
        </button>
      </div>
      {error != null ? <span id="pr-open-error" role="alert">{error}</span> : null}
    </form>
  )
}
