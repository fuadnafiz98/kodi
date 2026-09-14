// One `repo:` qualifier per slug in the inbox search; GitHub unions them, so
// this is an allow-list. Past a handful the queries buy nothing and a hostile
// renderer could otherwise stuff a whole catalog into every poll.
export const MAX_INBOX_REPOS = 30

const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const REPO_URL_PATH = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?(?:[?#/]|$)/

/**
 * `owner/name` either typed bare or pasted as a GitHub URL (`…/pull/…` paths
 * resolve to the repository too). Lowercased because slugs are
 * case-insensitive and the value doubles as a cache-scope key.
 */
export function inboxRepoSlug(value: string): string | null {
  const trimmed = value.trim()
  if (REPO_SLUG.test(trimmed)) return trimmed.toLowerCase()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null
  const match = REPO_URL_PATH.exec(url.pathname)
  return match == null ? null : `${match[1]}/${match[2]}`.toLowerCase()
}

/** Anything that is not a clean slug is dropped rather than searched. */
export function normalizeInboxRepos(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const slug = inboxRepoSlug(entry)
    if (slug != null) seen.add(slug)
    if (seen.size >= MAX_INBOX_REPOS) break
  }
  return [...seen]
}

/** The search tail appended to every inbox section query. Empty means all repos. */
export function inboxRepoScope(repos: readonly string[]): string {
  return repos.map((repo) => `repo:${repo}`).join(' ')
}
