import { LaunchProps } from '@raycast/api'

import { clipboardText, openKodiPullRequest } from './lib/open'

export default async function Command(props: LaunchProps): Promise<void> {
  await openKodiPullRequest(props.fallbackText, await clipboardText())
}
