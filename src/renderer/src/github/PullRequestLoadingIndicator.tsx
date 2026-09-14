import { IconInReview, IconRefresh } from '@pierre/icons'

export function PullRequestLoadingIndicator({ closing }: { closing?: boolean }): React.JSX.Element {
  return (
    <div className="pr-loading-indicator" role="status" aria-live="polite"
      data-state={closing === true ? 'closing' : undefined}>
      <span className="pr-loading-icon">
        <IconInReview />
        <IconRefresh className="spin" />
      </span>
      <span><strong>Loading pull request</strong><small>Preparing the multi-file review…</small></span>
    </div>
  )
}
