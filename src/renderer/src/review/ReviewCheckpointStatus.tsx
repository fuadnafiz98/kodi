import { IconClockArrow } from '@pierre/icons'

import type { ReviewCheckpoint } from './reviewCheckpoints'
import { formatCommentAge } from '../github/RemoteReviewThreads'

export interface ReviewCheckpointBarProps {
  checkpoint: ReviewCheckpoint | null
  changedFileCount: number
  removedFileCount: number
  reviewReady: boolean
  onSetCheckpoint(): void
  onOpenSince(): void
}

/**
 * The status half of the review session bar: which baseline this review is
 * against, and the door into the file-level "since" view. The checkpoint's own
 * action button lives in the bar's action cluster.
 */
export function ReviewCheckpointStatus({
  checkpoint,
  changedFileCount,
  removedFileCount,
  onOpenSince
}: Pick<ReviewCheckpointBarProps, 'checkpoint' | 'changedFileCount' | 'removedFileCount' | 'onOpenSince'>): React.JSX.Element {
  const sinceLabel = changedFileCount === 0
    ? 'No files since checkpoint'
    : `${changedFileCount} since checkpoint${removedFileCount === 0 ? '' : ` · ${removedFileCount} removed`}`
  return (
    <>
      <span
        className="review-session-checkpoint"
        title={checkpoint == null ? undefined : `Checkpoint ${checkpoint.headOid} · ${new Date(checkpoint.createdAt).toLocaleString()}`}
      >
        <IconClockArrow aria-hidden="true" />
        {checkpoint == null
          ? 'No review checkpoint'
          : <>Checkpoint <code>{checkpoint.headOid.slice(0, 8)}</code> · {formatCommentAge(checkpoint.createdAt, Date.now())}</>}
      </span>
      {checkpoint == null ? null : changedFileCount === 0 ? (
        <span className="review-session-since muted">{sinceLabel}</span>
      ) : (
        <button type="button" className="review-session-since" onClick={onOpenSince}>{sinceLabel}</button>
      )}
    </>
  )
}
