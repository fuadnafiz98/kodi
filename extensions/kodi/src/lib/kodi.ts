import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { formatKodiReviewUrl } from './github'

const execFileAsync = promisify(execFile)

export type KodiIntent = 'open' | 'warmup'

export const KODI_NOT_INSTALLED = 'Kodi is not installed. Build it with `bun run update:mac`.'
export const KODI_SCHEME_UNREGISTERED =
  'macOS has no handler for kodi://. Reinstall with `bun run update:mac`, then open Kodi once.'

export type KodiLaunchPlan =
  | { kind: 'none' }
  | { kind: 'scheme'; args: string[] }
  | { kind: 'launch'; args: string[] }

/**
 * A running Kodi is reached through the registered scheme, which lands on the
 * window that is already open instead of relaunching the app. Only a cold start
 * goes through `open -a`, and a warmup never does: warming is worth a message to
 * an app that is already up, not the cost of starting one in the background.
 */
export function kodiLaunchPlan(input: {
  deepLink: string
  intent: KodiIntent
  running: boolean
}): KodiLaunchPlan {
  if (input.running) {
    return {
      kind: 'scheme',
      args: input.intent === 'warmup' ? ['-g', input.deepLink] : [input.deepLink]
    }
  }
  if (input.intent === 'warmup') return { kind: 'none' }
  return { kind: 'launch', args: ['-a', 'Kodi', '--args', `--kodi-url=${input.deepLink}`] }
}

export async function isKodiRunning(): Promise<boolean> {
  try {
    await execFileAsync('pgrep', ['-x', 'Kodi'])
    return true
  } catch {
    // pgrep exits 1 when nothing matches, which is the answer rather than a failure.
    return false
  }
}

export async function sendToKodi(pullRequestUrl: string, intent: KodiIntent): Promise<void> {
  const startedAt = performance.now()
  const deepLink = formatKodiReviewUrl(pullRequestUrl, intent)
  if (deepLink == null) throw new Error('That is not a GitHub pull request URL.')

  const running = await isKodiRunning()
  const processDetectionMs = performance.now() - startedAt
  const plan = kodiLaunchPlan({ deepLink, intent, running })
  if (plan.kind === 'none') return
  try {
    await execFileAsync('open', plan.args)
    console.info('[kodi-performance]', JSON.stringify({
      processDetectionMs,
      openMs: performance.now() - startedAt,
      mode: plan.kind
    }))
  } catch {
    throw new Error(plan.kind === 'scheme' ? KODI_SCHEME_UNREGISTERED : KODI_NOT_INSTALLED)
  }
}
