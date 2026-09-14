import { Action, ActionPanel, Clipboard, Icon, LaunchProps, List, closeMainWindow, showHUD } from '@raycast/api'
import { useEffect, useRef, useState } from 'react'

import { describeGitHubPullRequest, extractGitHubPullRequestUrl } from './lib/github'
import { sendToKodi } from './lib/kodi'

export default function Command(props: LaunchProps<{ arguments: Arguments.OpenPullRequest; fallbackText?: string }>) {
  const incoming = extractGitHubPullRequestUrl(props.arguments.url ?? '')
    ?? extractGitHubPullRequestUrl(props.fallbackText ?? '')
  const [search, setSearch] = useState(incoming ?? '')
  const [clipboardUrl, setClipboardUrl] = useState<string | null>(null)
  const [opening, setOpening] = useState(incoming != null)
  const [warmedUrls, setWarmedUrls] = useState<readonly string[]>([])
  const warmed = useRef(new Set<string>())

  // Launched with a URL: hand it over straight away. The tail is cancellable so
  // a failure that lands after a re-run cannot clear a spinner it no longer owns.
  useEffect(() => {
    if (incoming == null) return
    let cancelled = false
    void deliver(incoming).then((message) => {
      if (message == null) return
      if (!cancelled) setOpening(false)
      void showHUD(message)
    })
    return () => {
      cancelled = true
    }
  }, [incoming])

  // Launched without one: offer whatever pull request URL is on the clipboard.
  useEffect(() => {
    if (incoming != null) return
    let cancelled = false
    void Clipboard.readText().then((text) => {
      if (cancelled) return
      setClipboardUrl(extractGitHubPullRequestUrl(text ?? ''))
    })
    return () => {
      cancelled = true
    }
  }, [incoming])

  // One warmup per URL, whether it was typed or came off the clipboard. The
  // badge belongs to whichever run is still current, so a superseded failure
  // leaves it alone; the claim is released either way so the URL stays retryable.
  const typed = extractGitHubPullRequestUrl(search)
  const candidate = typed ?? clipboardUrl
  useEffect(() => {
    if (candidate == null || !claimWarmup(candidate)) return
    let cancelled = false
    void sendToKodi(candidate, 'warmup').catch(() => {
      warmed.current.delete(candidate)
      if (cancelled) return
      setWarmedUrls((current) => current.filter((item) => item !== candidate))
    })
    return () => {
      cancelled = true
    }
  }, [candidate])

  /** Claims the URL for this caller, or answers false when it is already warming. */
  function claimWarmup(url: string): boolean {
    if (warmed.current.has(url)) return false
    warmed.current.add(url)
    setWarmedUrls((current) => current.includes(url) ? current : [...current, url])
    return true
  }

  /** The action-panel path: the same warmup, with no effect run to be superseded by. */
  async function warmUrl(url: string): Promise<void> {
    if (!claimWarmup(url)) return
    try {
      await sendToKodi(url, 'warmup')
    } catch {
      warmed.current.delete(url)
      setWarmedUrls((current) => current.filter((item) => item !== url))
    }
  }

  async function openUrl(url: string): Promise<void> {
    setOpening(true)
    const message = await deliver(url)
    if (message == null) return
    setOpening(false)
    await showHUD(message)
  }

  const description = candidate == null ? null : describeGitHubPullRequest(candidate)

  return (
    <List
      isLoading={opening}
      searchText={search}
      onSearchTextChange={setSearch}
      searchBarPlaceholder="Paste a GitHub pull request URL"
      throttle
    >
      {candidate != null && description != null ? (
        <List.Item
          title={`${description.owner}/${description.repository}#${description.number}`}
          subtitle={candidate}
          icon={Icon.Eye}
          accessories={[{ text: warmedUrls.includes(candidate) ? 'Warming in Kodi' : 'Open in Kodi' }]}
          actions={
            <ActionPanel>
              <Action title="Open in Kodi" icon={Icon.Eye} onAction={() => void openUrl(candidate)} />
              <Action title="Warm in Background" icon={Icon.Clock} onAction={() => void warmUrl(candidate)} />
            </ActionPanel>
          }
        />
      ) : (
        <List.EmptyView
          icon={Icon.Link}
          title={search.trim() === '' ? 'Paste a GitHub pull request URL' : 'Not a GitHub pull request URL'}
          description="Kodi starts loading the review as soon as the URL looks valid."
        />
      )}
    </List>
  )
}

/** Hands the URL to Kodi and closes Raycast; resolves with a message when that failed. */
async function deliver(url: string): Promise<string | null> {
  // Dispatched before the window closes so Kodi starts resolving the checkout
  // during the close, not after it.
  const delivery = sendToKodi(url, 'open')
  try {
    await closeMainWindow({ clearRootSearch: true })
    await delivery
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'Could not open Kodi'
  }
}
