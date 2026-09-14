import { clipboardText, openKodiPullRequest } from './lib/open'

export default async function Command(): Promise<void> {
  await openKodiPullRequest(await clipboardText())
}
