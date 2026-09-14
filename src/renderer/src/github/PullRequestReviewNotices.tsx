export interface PullRequestReviewNoticesProps {
  message: string | null
  inlineCommentCount: number
  orphanedCommentCount: number
  viewerCanSubmitDecision: boolean
}

/** What will be posted with this review, and what stands in the way. */
export function PullRequestReviewNotices({
  message,
  inlineCommentCount,
  orphanedCommentCount,
  viewerCanSubmitDecision
}: PullRequestReviewNoticesProps): React.JSX.Element {
  return (
    <>
      {message == null ? null : <p className="success" role="alert">{message}</p>}
      {inlineCommentCount > 0 ? <p>{inlineCommentCount} unresolved inline {inlineCommentCount === 1 ? 'comment' : 'comments'} will be posted with this review.</p> : null}
      {orphanedCommentCount > 0 ? <p>{orphanedCommentCount} orphaned {orphanedCommentCount === 1 ? 'comment must' : 'comments must'} be reattached or dropped before submission.</p> : null}
      {viewerCanSubmitDecision ? null : <p>GitHub only allows comment reviews on your own pull request.</p>}
    </>
  )
}
