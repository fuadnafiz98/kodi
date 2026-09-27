import { isAllowedGitHubMediaUrl, videoMimeTypeFromHref } from '../shared/markdownVideo.js'
import { runCommand } from './gitCommands.js'

export const MAX_MARKDOWN_MEDIA_BYTES = 48 * 1024 * 1024

export interface MarkdownMediaBytes {
  mimeType: string
  bytes: Uint8Array
}

const GH_EXECUTABLE_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'] as const

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export async function loadMarkdownMedia(
  rawUrl: unknown,
  fetchImpl: FetchLike = fetch,
  readToken: () => Promise<string | null> = () => readGitHubAuthToken()
): Promise<MarkdownMediaBytes> {
  if (typeof rawUrl !== 'string' || !isAllowedGitHubMediaUrl(rawUrl)) {
    throw new Error('Only GitHub-hosted videos can be previewed.')
  }
  const token = await readToken()
  const headers = new Headers({
    Accept: '*/*',
    'User-Agent': 'Kodi'
  })
  if (token != null) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetchImpl(rawUrl, { headers, redirect: 'follow' })
  if (!response.ok) {
    throw new Error(`The video could not be loaded (${response.status}).`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > MAX_MARKDOWN_MEDIA_BYTES) {
    throw new Error('This video is too large to preview here.')
  }
  const headerType = response.headers.get('content-type')?.split(';')[0]?.trim()
  const mimeType = headerType != null && headerType !== '' && headerType !== 'application/octet-stream'
    ? headerType
    : videoMimeTypeFromHref(rawUrl)
  return { mimeType, bytes: new Uint8Array(buffer) }
}

// A pull request description can embed several videos, and each one spawned
// `gh auth token` again. The token outlives a review by far, so it is asked for
// once per ten minutes; a miss is not remembered, so signing in takes effect on
// the next video rather than after the window.
export const GITHUB_TOKEN_TTL_MS = 10 * 60 * 1000

let cachedToken: { value: Promise<string | null>; expiresAt: number } | null = null

export function readGitHubAuthToken(
  spawnToken: () => Promise<string | null> = spawnGitHubAuthToken,
  now = Date.now()
): Promise<string | null> {
  if (cachedToken != null && cachedToken.expiresAt > now) return cachedToken.value
  const entry = {
    value: spawnToken().catch(() => null),
    expiresAt: now + GITHUB_TOKEN_TTL_MS
  }
  cachedToken = entry
  void entry.value.then((token) => {
    if (token == null && cachedToken === entry) cachedToken = null
  })
  return entry.value
}

export function resetGitHubAuthTokenForTests(): void {
  cachedToken = null
}

async function spawnGitHubAuthToken(): Promise<string | null> {
  for (const candidate of GH_EXECUTABLE_CANDIDATES) {
    try {
      // An embedded video is garnish beside the review it sits in, so the lookup
      // yields to the git and gh work the review itself is waiting on.
      const result = await runCommand(candidate, ['auth', 'token'], undefined, [], undefined, undefined, 'background')
      const token = result.stdout.toString('utf8').trim()
      if (token !== '') return token
    } catch {
    }
  }
  return null
}
