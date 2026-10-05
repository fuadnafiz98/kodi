import { createLazyModule, useLazyModule } from '../app/lazyModule'

const pullRequestReviewParts = createLazyModule(() => import('./pullRequestReviewParts'))

/**
 * The pull request parts once they are here. A review that is a pull request
 * asks for them as it mounts — the chunk is local and arrives long before
 * GitHub answers for the conversation it draws — and a local review never does.
 */
export function usePullRequestReviewParts(pullRequest: boolean) {
  return useLazyModule(pullRequestReviewParts, pullRequest)
}
