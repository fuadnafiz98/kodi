import type {
  GitIntegrationSnapshot,
  InboxPullRequest,
  PullRequestInboxSnapshot,
  PullRequestSummary
} from '../../../shared/contracts'

export interface VisiblePullRequests {
  /** The inbox when it has anything, otherwise the repository's own list. */
  visible: readonly (PullRequestSummary | InboxPullRequest)[]
  inboxCount: number
}

export function visiblePullRequestsFor(
  inbox: PullRequestInboxSnapshot | null,
  integration: GitIntegrationSnapshot | null
): VisiblePullRequests {
  const sections = inbox?.available === true
    ? inbox.sections.filter((section) => section.pullRequests.length > 0)
    : []
  const inboxPullRequests = sections.flatMap((section) => section.pullRequests)
  return {
    visible: inboxPullRequests.length > 0 ? inboxPullRequests : integration?.pullRequests ?? [],
    inboxCount: inboxPullRequests.length
  }
}
