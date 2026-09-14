import { isAllowedGitHubMediaUrl } from '../shared/markdownVideo.js'

export const MAX_AVATAR_BYTES = 256 * 1024

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * The renderer is offline by CSP (`img-src 'self' data:`), so remote avatars are
 * fetched here and handed back as `data:` URLs. GitHub avatar URLs are public,
 * so no token is needed; anything that is not an allowed GitHub image answers
 * null and the caller falls back to a monogram.
 */
export async function loadAvatarImage(
  rawUrl: unknown,
  fetchImpl: FetchLike = fetch
): Promise<string | null> {
  if (typeof rawUrl !== 'string' || !isAllowedGitHubMediaUrl(rawUrl)) return null
  try {
    const response = await fetchImpl(rawUrl, {
      headers: { Accept: 'image/*', 'User-Agent': 'Kodi' },
      redirect: 'follow'
    })
    if (!response.ok) return null
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
    if (!mimeType.startsWith('image/')) return null
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_AVATAR_BYTES) return null
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

// Authors repeat across a conversation's threads and reviews, so each URL is
// fetched at most once per session. Bounded so a long session cannot grow it.
const AVATAR_CACHE_LIMIT = 300
const avatarCache = new Map<string, Promise<string | null>>()

export function getAvatarDataUrl(rawUrl: unknown, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const key = typeof rawUrl === 'string' ? rawUrl : ''
  if (avatarCache.size >= AVATAR_CACHE_LIMIT) avatarCache.clear()
  let pending = avatarCache.get(key)
  if (pending == null) {
    pending = loadAvatarImage(key, fetchImpl)
    avatarCache.set(key, pending)
  }
  return pending
}
