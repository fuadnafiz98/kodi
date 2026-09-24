import { IconApproved, IconComment, IconCommentIssue } from '@pierre/icons'

import type { PullRequestReviewEvent, PullRequestSummary } from '../../../shared/contracts'
import type { ConfirmRequest } from '../app/ConfirmDialog'

function inlineComments(count: number): string {
  return `${count} inline ${count === 1 ? 'comment' : 'comments'}`
}

/**
 * The confirmation names the decision in its title and on its button — Approve,
 * not "Submit review" — and shows the pull request's own title, so the reader
 * confirms the right change with the right verdict.
 */
export function reviewSubmissionRequest(
  event: PullRequestReviewEvent,
  pullRequest: PullRequestSummary,
  commentCount: number
): ConfirmRequest {
  const number = `#${pullRequest.number}`
  const withComments = commentCount === 0 ? '' : ` with ${inlineComments(commentCount)}`
  const context = {
    title: pullRequest.title,
    meta: `${number} · ${pullRequest.headRefName} → ${pullRequest.baseRefName}`
  }
  if (event === 'approve') {
    return {
      title: `Approve ${number}?`,
      detail: `Your approval is posted to GitHub${withComments}.`,
      confirmLabel: 'Approve',
      icon: <IconApproved />,
      tone: 'success',
      context
    }
  }
  if (event === 'request-changes') {
    return {
      title: `Request changes on ${number}?`,
      detail: `Your review is posted to GitHub${withComments}, asking the author for changes.`,
      confirmLabel: 'Request changes',
      icon: <IconCommentIssue />,
      tone: 'warning',
      context
    }
  }
  return {
    title: `Comment on ${number}?`,
    detail: commentCount === 0
      ? 'Your review comment is posted to GitHub without approving or requesting changes.'
      : `Your ${inlineComments(commentCount)} ${commentCount === 1 ? 'is' : 'are'} posted to GitHub without approving or requesting changes.`,
    confirmLabel: 'Post review',
    icon: <IconComment />,
    context
  }
}

/** What the toast says once GitHub has the review. */
export function reviewSubmittedMessage(event: PullRequestReviewEvent, pullRequestNumber: number): string {
  if (event === 'approve') return `Approved #${pullRequestNumber}`
  if (event === 'request-changes') return `Requested changes on #${pullRequestNumber}`
  return `Commented on #${pullRequestNumber}`
}
