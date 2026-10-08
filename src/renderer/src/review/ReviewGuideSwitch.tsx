import { reviewGuideHost, useGuideSwitchStatus, useReviewView } from './reviewGuideView'

/** Diff | Guide for the review on screen; a dot says a guide is on its way or waiting. */
export function ReviewGuideSwitch({ worldId }: { worldId: string }): React.JSX.Element {
  const view = useReviewView(worldId)
  const status = useGuideSwitchStatus(worldId)
  const guide = view === 'guide'
  return (
    <div className="segmented-control review-guide-switch" role="group" aria-label="Review view">
      <button type="button" className={guide ? undefined : 'active'} aria-pressed={!guide}
        onClick={() => reviewGuideHost().setView(worldId, 'diff')}>Diff</button>
      <button type="button" data-review-guide-switch="" className={guide ? 'active' : undefined} aria-pressed={guide}
        title="Show guide ⌘⇧G" onClick={() => reviewGuideHost().setView(worldId, 'guide')}>
        Guide{status === 'loading' || (status === 'ready' && !guide)
          ? <i className="review-guide-dot" data-status={status} aria-label={status === 'loading' ? 'writing' : 'ready'} />
          : null}
      </button>
    </div>
  )
}
