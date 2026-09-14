import { Clipboard, closeMainWindow, showHUD } from '@raycast/api'

import { extractGitHubPullRequestUrl } from './github'
import { sendToKodi } from './kodi'

export function firstPullRequestUrl(...candidates: Array<string | undefined | null>): string | null {
  for (const candidate of candidates) {
    const url = extractGitHubPullRequestUrl(candidate ?? '')
    if (url != null) return url
  }
  return null
}

export async function openKodiPullRequest(...candidates: Array<string | undefined | null>): Promise<void> {
  const url = firstPullRequestUrl(...candidates)
  if (url == null) {
    await showHUD('Paste a GitHub pull request URL')
    return
  }
  // The deep link goes out first: closing the Raycast window is a round trip Kodi
  // does not need to wait behind before it starts resolving the checkout.
  const delivery = sendToKodi(url, 'open')
  await closeMainWindow({ clearRootSearch: true })
  try {
    await delivery
  } catch (error) {
    await showHUD(error instanceof Error ? error.message : 'Could not open Kodi')
  }
}

export async function clipboardText(): Promise<string> {
  return (await Clipboard.readText()) ?? ''
}
