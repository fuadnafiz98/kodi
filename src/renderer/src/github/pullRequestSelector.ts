import { extractGitHubPullRequestUrl } from '../../../shared/pullRequestUrl'

export function parsePullRequestSelector(value: string): number | string | null {
  const trimmedValue = value.trim()
  const directMatch = /^#?(\d+)$/.exec(trimmedValue)
  if (directMatch == null) return extractGitHubPullRequestUrl(trimmedValue)
  const rawNumber = directMatch?.[1]
  if (rawNumber == null) return null
  const number = Number(rawNumber)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}
