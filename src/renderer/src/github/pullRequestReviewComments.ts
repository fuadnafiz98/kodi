import type { PullRequestReviewComment } from '../../../shared/contracts'
import type { ReviewThread } from '../review/ReviewComments'

function githubSide(side: 'additions' | 'deletions' | undefined): 'LEFT' | 'RIGHT' {
  return side === 'deletions' ? 'LEFT' : 'RIGHT'
}

function commentBody(thread: ReviewThread): string {
  if (thread.replies.length === 0) return thread.body
  return [thread.body, ...thread.replies.map((reply) => reply.body)].join('\n\n')
}

export function createPullRequestReviewComments(
  threadsByPath: Readonly<Record<string, readonly ReviewThread[]>>
): PullRequestReviewComment[] {
  return Object.entries(threadsByPath).flatMap(([path, threads]) =>
    threads.flatMap((thread) => {
      if (thread.resolved || thread.orphaned) return []
      const startSide = githubSide(thread.range.side)
      const side = githubSide(thread.range.endSide ?? thread.range.side)
      return [{
        path,
        body: commentBody(thread),
        line: thread.range.end,
        side,
        ...(thread.range.start === thread.range.end
          ? {}
          : {
              startLine: thread.range.start,
              startSide
            })
      }]
    })
  )
}
