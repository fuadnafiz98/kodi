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
  readToken: () => Promise<string | null> = readGitHubAuthToken
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

async function readGitHubAuthToken(): Promise<string | null> {
  for (const candidate of GH_EXECUTABLE_CANDIDATES) {
    try {
      const result = await runCommand(candidate, ['auth', 'token'])
      const token = result.stdout.toString('utf8').trim()
      if (token !== '') return token
    } catch {
    }
  }
  return null
}
