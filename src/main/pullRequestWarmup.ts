import { extractGitHubPullRequestUrl } from '../shared/pullRequestUrl.js'

export interface ClipboardWarmupDecision {
  /** The clipboard text to compare against on the next poll. */
  seen: string
  /** The pull request to warm, or null when there is nothing to do. */
  url: string | null
}

/**
 * A hidden Kodi must not react to the clipboard at all — the copy usually
 * belongs to another app — and it must not consume the text either, or the URL
 * is stale by the time the window comes back.
 */
export function clipboardWarmupDecision(input: {
  text: string
  seen: string
  windowVisible: boolean
}): ClipboardWarmupDecision {
  if (!input.windowVisible) return { seen: input.seen, url: null }
  if (input.text === input.seen) return { seen: input.seen, url: null }
  return { seen: input.text, url: extractGitHubPullRequestUrl(input.text) }
}

/**
 * A pull request with no local checkout costs as much to look for as one that
 * resolves, so the cooldown starts before the work rather than after a hit.
 */
export function warmupCooledDown(input: {
  lastWarmedAt: number | undefined
  now: number
  cooldownMs: number
}): boolean {
  return input.lastWarmedAt == null || input.now - input.lastWarmedAt >= input.cooldownMs
}
