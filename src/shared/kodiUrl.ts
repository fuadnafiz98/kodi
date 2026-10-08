import { extractGitHubPullRequestUrl } from './pullRequestUrl.js'

export const KODI_PROTOCOL = 'kodi'
// Deep links and flags from before the rename keep working.
export const LEGACY_KODI_PROTOCOL = 'horus'
export const KODI_REVIEW_HOST = 'review'

export type KodiReviewIntent = 'open' | 'warmup'

export interface KodiReviewRequest {
  url: string
  intent: KodiReviewIntent
}

const KODI_URL_FLAGS = ['--kodi-url', '--horus-url'] as const
const KODI_FOLDER_FLAG = '--kodi-folder'
const KODI_REF_FLAG = '--kodi-ref'
const KODI_GUIDE_FILE_FLAG = '--kodi-guide-file'
const KODI_CLAUDE_SESSION_FLAG = '--kodi-claude-session'
// Flags whose space-form value must never be read as a folder.
const KODI_VALUE_FLAGS = [...KODI_URL_FLAGS, KODI_REF_FLAG, KODI_GUIDE_FILE_FLAG, KODI_CLAUDE_SESSION_FLAG] as const
const FULL_SHA = /^[0-9a-f]{40}$/i
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * Deep link used by the Raycast extension and `open kodi://…`.
 * `intent=open` is omitted so the common case stays short.
 */
export function formatKodiReviewUrl(pullRequestUrl: string, intent: KodiReviewIntent = 'open'): string | null {
  const url = extractGitHubPullRequestUrl(pullRequestUrl)
  if (url == null) return null
  const params = new URLSearchParams({ url })
  if (intent === 'warmup') params.set('intent', 'warmup')
  return `${KODI_PROTOCOL}://${KODI_REVIEW_HOST}?${params.toString()}`
}

export function parseKodiReviewUrl(value: string): KodiReviewRequest | null {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return extractReviewRequest(value)
  }

  const isKodiLink = parsed.protocol === `${KODI_PROTOCOL}:` || parsed.protocol === `${LEGACY_KODI_PROTOCOL}:`
  if (!isKodiLink || parsed.username !== '' || parsed.password !== '') {
    return extractReviewRequest(value)
  }

  const host = parsed.hostname.toLowerCase()
  if (host !== KODI_REVIEW_HOST && host !== '') return null
  if (host === '' && parsed.pathname.replace(/^\//, '').toLowerCase() !== KODI_REVIEW_HOST) return null

  const url = extractGitHubPullRequestUrl(parsed.searchParams.get('url') ?? '')
  if (url == null) return null
  const rawIntent = parsed.searchParams.get('intent')
  if (rawIntent != null && rawIntent !== 'open' && rawIntent !== 'warmup') return null
  return { url, intent: rawIntent === 'warmup' ? 'warmup' : 'open' }
}

/**
 * Picks a review request out of process argv. `--kodi-url` (or the legacy
 * `--horus-url`) wins, then a `kodi://`/`horus://` link, then a GitHub
 * pull-request URL. Electron helper flags and paths are ignored.
 */
export function findKodiReviewRequest(argv: readonly string[]): KodiReviewRequest | null {
  let flagged: KodiReviewRequest | null = null
  let deepLink: KodiReviewRequest | null = null
  let github: KodiReviewRequest | null = null

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument == null || argument === '') continue

    const urlFlag = KODI_URL_FLAGS.find((flag) => argument === flag || argument.startsWith(`${flag}=`))
    if (urlFlag != null) {
      const value = argument === urlFlag ? argv[index + 1] : argument.slice(urlFlag.length + 1)
      // A second-instance argv arrives switch-first and positional-last, so the
      // token after a space-form flag can be an injected switch, not the value.
      if (value != null && value !== '' && !value.startsWith('-')) {
        flagged = parseKodiReviewUrl(value) ?? extractReviewRequest(value)
      }
      continue
    }

    const fromDeepLink = parseKodiProtocolArgument(argument)
    if (fromDeepLink != null) {
      deepLink = fromDeepLink
      continue
    }

    const fromGitHub = extractReviewRequest(argument)
    if (fromGitHub != null) github = fromGitHub
  }

  return flagged ?? deepLink ?? github
}

/**
 * Picks a folder to open out of process argv — the `kodi .` path. An explicit
 * `--kodi-folder <path>` (what the bundled CLI passes) wins; with
 * `allowPositional` the last bare positional argument also counts, which is how
 * a direct `Kodi.app/Contents/MacOS/Kodi ./src` invocation arrives. Positional
 * parsing stays opt-in so a dev-mode `electron .` never looks like a request.
 */
export function findKodiFolderRequest(argv: readonly string[], allowPositional = false): string | null {
  let flagged: string | null = null
  let positional: string | null = null

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument == null || argument === '') continue

    if (argument === KODI_FOLDER_FLAG) {
      const value = argv[index + 1]
      index += 1
      // Same switch-first reconstruction: `--kodi-folder /path` arrives as the
      // bare flag with /path demoted to a positional, so a leading dash means
      // the real value is elsewhere in argv and the positional pass finds it.
      if (value != null && value !== '' && !value.startsWith('-')) flagged = value
      continue
    }
    if (argument.startsWith(`${KODI_FOLDER_FLAG}=`)) {
      flagged = argument.slice(KODI_FOLDER_FLAG.length + 1)
      continue
    }
    // A URL, ref or guide flag's value is never a folder candidate.
    if (KODI_VALUE_FLAGS.some((flag) => argument === flag)) {
      index += 1
      continue
    }
    if (allowPositional && !argument.startsWith('-') && !URL_SCHEME.test(argument)) {
      positional = argument
    }
  }

  return flagged ?? positional
}

function parseKodiProtocolArgument(value: string): KodiReviewRequest | null {
  const trimmed = value.trim()
  const lowered = trimmed.toLowerCase()
  if (!lowered.startsWith(`${KODI_PROTOCOL}:`) && !lowered.startsWith(`${LEGACY_KODI_PROTOCOL}:`)) return null
  return parseKodiReviewUrl(trimmed)
}

function extractReviewRequest(value: string): KodiReviewRequest | null {
  const url = extractGitHubPullRequestUrl(value)
  return url == null ? null : { url, intent: 'open' }
}

/**
 * The value of `--kodi-<name>=<value>` (what the bundled CLI passes) or of the
 * space form. A second-instance argv arrives switch-first, so a space-form
 * value that starts with a dash is an injected switch, not the value.
 */
function findFlagValue(argv: readonly string[], flag: string): string | null {
  let found: string | null = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument == null || argument === '') continue
    if (argument.startsWith(`${flag}=`)) {
      found = argument.slice(flag.length + 1)
      continue
    }
    if (argument === flag) {
      const value = argv[index + 1]
      index += 1
      if (value != null && value !== '' && !value.startsWith('-')) found = value
    }
  }
  return found
}

/** `kodi <ref>`: the commit the CLI resolved, as a full SHA; null for anything else. */
export function findKodiRefRequest(argv: readonly string[]): string | null {
  const value = findFlagValue(argv, KODI_REF_FLAG)?.trim()
  return value != null && FULL_SHA.test(value) ? value.toLowerCase() : null
}

/** `kodi --guide-file <json>`: an absolute path to a guide an agent wrote; null otherwise. */
export function findKodiGuideFileRequest(argv: readonly string[]): string | null {
  const value = findFlagValue(argv, KODI_GUIDE_FILE_FLAG)
  return value != null && value.startsWith('/') && !value.includes('\0') ? value : null
}

/** The Claude Code session that wrote the guide, so its last messages travel with it. */
export function findKodiClaudeSessionRequest(argv: readonly string[]): string | null {
  const value = findFlagValue(argv, KODI_CLAUDE_SESSION_FLAG)?.trim()
  return value != null && SESSION_ID.test(value) ? value.toLowerCase() : null
}
