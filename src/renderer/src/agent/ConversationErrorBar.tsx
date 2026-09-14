export interface ConversationErrorBarProps {
  /** Why the pull request conversation could not be loaded, or `null`. */
  message: string | null
  onRetry(): void
}

export function ConversationErrorBar({ message, onRetry }: ConversationErrorBarProps): React.JSX.Element | null {
  if (message == null) return null
  return (
    <div className="review-bar pr-review-readonly" role="alert">
      {message}
      <button className="bar-button" type="button" onClick={onRetry}>Retry</button>
    </div>
  )
}
