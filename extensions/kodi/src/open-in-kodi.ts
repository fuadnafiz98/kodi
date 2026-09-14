import { LaunchProps } from '@raycast/api'

import { clipboardText, firstPullRequestUrl, openKodiPullRequest } from './lib/open'

export default async function Command(props: LaunchProps): Promise<void> {
  const fallback = firstPullRequestUrl(props.fallbackText)
  await openKodiPullRequest(fallback ?? await clipboardText())
}
