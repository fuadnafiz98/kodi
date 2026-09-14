import type {
  InboxPullRequest,
  PullRequestInboxSectionKey,
  PullRequestInboxSnapshot
} from '../../../shared/contracts'
import { githubRepoSlugFromPullRequestUrl } from '../../../shared/pullRequestUrl'

export interface WelcomeInboxRow {
  key: PullRequestInboxSectionKey
  url: string
  number: number
  title: string
  repo: string
  isDraft: boolean
  authorLogin: string
  authorAvatarUrl: string
  updatedAt: string
}

export const WELCOME_INBOX_LIMIT = 5

// Same precedence as the inbox panel: what needs you first, your own last.
const SECTION_ORDER: Record<PullRequestInboxSectionKey, number> = {
  'review-requested': 0,
  assigned: 1,
  mentioned: 2,
  authored: 3
}

/** One flat feed: deduped by URL, needs-you sections first, freshest inside each. */
export function welcomeInboxRows(
  snapshot: PullRequestInboxSnapshot | null,
  limit = WELCOME_INBOX_LIMIT
): WelcomeInboxRow[] {
  if (snapshot == null || !snapshot.available) return []
  const rows: WelcomeInboxRow[] = []
  const seen = new Set<string>()
  for (const section of snapshot.sections) {
    for (const pullRequest of section.pullRequests) {
      const identity = pullRequest.url.toLowerCase()
      if (seen.has(identity)) continue
      seen.add(identity)
      rows.push(toRow(section.key, pullRequest))
    }
  }
  rows.sort((left, right) =>
    SECTION_ORDER[left.key] - SECTION_ORDER[right.key]
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  return rows.slice(0, limit)
}

function toRow(key: PullRequestInboxSectionKey, pullRequest: InboxPullRequest): WelcomeInboxRow {
  return {
    key,
    url: pullRequest.url,
    number: pullRequest.number,
    title: pullRequest.title,
    repo: githubRepoSlugFromPullRequestUrl(pullRequest.url) ?? '',
    isDraft: pullRequest.isDraft,
    authorLogin: pullRequest.author.login,
    authorAvatarUrl: pullRequest.author.avatarUrl ?? '',
    updatedAt: pullRequest.updatedAt
  }
}

/** Every repository in the raw snapshot — the Settings suggestion list. */
export function welcomeInboxRepos(snapshot: PullRequestInboxSnapshot | null): string[] {
  if (snapshot == null || !snapshot.available) return []
  const repos = new Set<string>()
  for (const section of snapshot.sections) {
    for (const pullRequest of section.pullRequests) {
      const slug = githubRepoSlugFromPullRequestUrl(pullRequest.url)
      if (slug != null) repos.add(slug)
    }
  }
  return [...repos].sort()
}

export const WELCOME_INBOX_TAG: Record<PullRequestInboxSectionKey, string> = {
  'review-requested': 'Review',
  assigned: 'Assigned',
  mentioned: 'Mentioned',
  authored: 'Authored'
}

const CACHE_KEY = 'kodi:welcome-inbox:v1'
const MEMORY_TTL_MS = 60_000

interface WelcomeInboxCacheEntry {
  rows: WelcomeInboxRow[]
  /** All repos in the last snapshot, not just the painted rows. */
  repos: string[]
  fetchedAt: number
  /** The repo allow-list the rows were fetched under; a changed scope is stale. */
  scope: string
  /**
   * Rows the last successful fetch produced, kept even when a scope change
   * discards the rows themselves: it is how many placeholders to reserve, and a
   * stored zero means the section stays away rather than flashing a placeholder.
   */
  count: number
}

/**
 * Placeholders to reserve before any fetch has ever reported a count. The feed
 * is capped, so a full list is the common answer and reserving the cap is what
 * makes the rows land in place; an emptier inbox over-reserves once and then
 * stores its real count, so the guess is only ever used on a first run.
 */
export const WELCOME_INBOX_ASSUMED_ROWS = WELCOME_INBOX_LIMIT

let memoryCache: WelcomeInboxCacheEntry | null = null

/** The last inbox that painted for this scope, so a reopened New tab does not flash empty. */
export function readWelcomeInboxCache(scope = ''): WelcomeInboxRow[] {
  const cached = memoryCache ?? readStoredCache()
  if (cached == null || cached.scope !== scope) return []
  return cached.rows.slice(0, WELCOME_INBOX_LIMIT)
}

/** True when a mount should hit GitHub again rather than reusing the memory entry. */
export function welcomeInboxIsStale(scope = '', now = Date.now()): boolean {
  const cached = memoryCache ?? readStoredCache()
  return cached?.scope !== scope || now - cached.fetchedAt > MEMORY_TTL_MS
}

export function writeWelcomeInboxCache(rows: readonly WelcomeInboxRow[], repos: readonly string[] = [], scope = '', fetchedAt = Date.now()): void {
  const kept = rows.slice(0, WELCOME_INBOX_LIMIT)
  const entry = { rows: kept, repos: [...repos], fetchedAt, scope, count: kept.length }
  memoryCache = entry
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry))
  } catch {
    // The rows still serve this session when storage is unavailable.
  }
}

/** A failed fetch keeps the stale rows on screen but still counts as a fetch. */
export function touchWelcomeInboxCache(scope = '', fetchedAt = Date.now()): void {
  const cached = memoryCache ?? readStoredCache()
  const sameScope = cached?.scope === scope
  memoryCache = {
    rows: sameScope ? cached.rows : [],
    repos: cached?.repos ?? [],
    fetchedAt,
    scope,
    count: cached?.count ?? WELCOME_INBOX_ASSUMED_ROWS
  }
}

/** Repositories the last snapshot named — what Settings offers as suggestions. */
export function readWelcomeInboxRepos(): string[] {
  return (memoryCache ?? readStoredCache())?.repos ?? []
}

/** How many placeholder rows to reserve while the first fetch is in flight. */
export function welcomeInboxExpectedRows(): number {
  const count = (memoryCache ?? readStoredCache())?.count
  if (count == null) return WELCOME_INBOX_ASSUMED_ROWS
  return Math.min(Math.max(count, 0), WELCOME_INBOX_LIMIT)
}

export function resetWelcomeInboxCacheForTests(): void {
  memoryCache = null
}

function readStoredCache(): WelcomeInboxCacheEntry | null {
  try {
    const stored = localStorage.getItem(CACHE_KEY)
    if (stored == null) return null
    const parsed = JSON.parse(stored) as unknown
    if (typeof parsed !== 'object' || parsed == null) return null
    const { rows, repos, fetchedAt, scope, count } = parsed as
      { rows?: unknown; repos?: unknown; fetchedAt?: unknown; scope?: unknown; count?: unknown }
    if (!Array.isArray(rows) || typeof fetchedAt !== 'number') return null
    const cleanRows = rows.filter(isWelcomeInboxRow)
    const entry: WelcomeInboxCacheEntry = {
      rows: cleanRows,
      // Entries written before repos were stored derive them from the rows.
      repos: Array.isArray(repos)
        ? [...new Set(repos.filter((repo): repo is string => typeof repo === 'string'))].sort()
        : [...new Set(cleanRows.map((row) => row.repo).filter((repo) => repo !== ''))].sort(),
      fetchedAt,
      scope: typeof scope === 'string' ? scope : '',
      count: typeof count === 'number' && Number.isFinite(count) ? count : cleanRows.length
    }
    memoryCache = entry
    return entry
  } catch {
    return null
  }
}

function isWelcomeInboxRow(value: unknown): value is WelcomeInboxRow {
  if (value == null || typeof value !== 'object') return false
  const row = value as Partial<WelcomeInboxRow>
  return typeof row.url === 'string'
    && typeof row.number === 'number'
    && typeof row.title === 'string'
    && typeof row.updatedAt === 'string'
    && typeof row.key === 'string'
    && row.key in SECTION_ORDER
}
