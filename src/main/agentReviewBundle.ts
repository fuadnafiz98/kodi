import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

import type {
  AgentRequestSubject,
  LocalBranchReview,
  OmittedDiffFile,
  PullRequestFile,
  PullRequestReview,
  RepositorySnapshot
} from '../shared/contracts.js'

interface CachedReviewPatch {
  headRefOid: string
  files: PullRequestFile[]
  omittedFiles: OmittedDiffFile[]
  patch: string
}

export const AGENT_REVIEW_DIR = '.kodi/review'
export const AGENT_REVIEW_PATCH_NAME = 'changes.patch'
export const AGENT_REVIEW_BRIEF_NAME = 'brief.md'
const AGENT_REVIEW_EXCLUDE = '.kodi/'
const LEGACY_AGENT_REVIEW_DIR = '.horus'
const LEGACY_AGENT_REVIEW_EXCLUDE = '.horus/'
const AGENT_CONTEXT_FILE_LIMIT = 80

/**
 * Rename-era migration: a repository Horus reviewed keeps `.horus/` until Kodi
 * opens it, then the whole directory moves to `.kodi/` and its git exclude line
 * follows so the store stays invisible to `git status`. Never throws — a
 * read-only checkout just keeps working off the unmigrated directory.
 */
export async function migrateLegacyReviewDirectory(root: string): Promise<void> {
  const legacy = join(root, LEGACY_AGENT_REVIEW_DIR)
  const current = join(root, '.kodi')
  const legacyInfo = await stat(legacy).catch(() => null)
  if (legacyInfo == null || !legacyInfo.isDirectory()) return
  if (await stat(current).catch(() => null) != null) return
  await rename(legacy, current).catch(() => null)
  if (await stat(current).catch(() => null) == null) return

  const gitDir = await resolveGitDirectory(root)
  if (gitDir == null) return
  const excludePath = join(gitDir, 'info', 'exclude')
  const text = await readFile(excludePath, 'utf8').catch(() => null)
  if (text == null || !text.includes(LEGACY_AGENT_REVIEW_EXCLUDE)) return
  const migrated = text
    .split('\n')
    .map((line) => (line.trim() === LEGACY_AGENT_REVIEW_EXCLUDE ? AGENT_REVIEW_EXCLUDE : line))
    .join('\n')
  await writeFile(excludePath, migrated, 'utf8').catch(() => null)
}

export interface RememberedAgentReview {
  key: string
  title: string
  pullRequestUrl?: string
  baseOid: string
  headOid: string
  files: PullRequestFile[]
  omittedFiles: OmittedDiffFile[]
  patch: string
}

export function rememberedAgentReviewFrom(
  review: PullRequestReview | LocalBranchReview
): RememberedAgentReview {
  if (review.kind === 'github') {
    return {
      key: reviewKey(review.baseOid, review.headOid),
      title: `#${review.pullRequest.number} ${review.pullRequest.title}`,
      pullRequestUrl: review.pullRequest.url,
      baseOid: review.baseOid,
      headOid: review.headOid,
      files: review.files,
      omittedFiles: review.omittedFiles,
      patch: review.patch
    }
  }
  return {
    key: reviewKey(review.baseOid, review.headOid),
    title: review.title,
    baseOid: review.baseOid,
    headOid: review.headOid,
    files: review.files,
    omittedFiles: review.omittedFiles,
    patch: review.patch
  }
}

export function reviewKey(baseOid: string, headOid: string): string {
  return `${baseOid}:${headOid}`
}

export const MAX_REMEMBERED_REVIEWS = 8
// Every pull request open and every local review lands here, and each resident
// repository keeps its own store, so a count alone let four sessions pin
// thirty-two whole patches — a single 3,000-file review is 30–60 MB.
export const MAX_REMEMBERED_REVIEW_BYTES = 32 * 1024 * 1024

/**
 * The reviews an agent request can be pointed at without reloading them, most
 * recently opened last. A patch's length stands in for its size: diffs are
 * overwhelmingly ASCII, which V8 stores a byte per character.
 */
export class RememberedReviewStore {
  readonly #maxEntries: number
  readonly #maxBytes: number
  #reviews = new Map<string, RememberedAgentReview>()
  #bytes = 0

  constructor(maxEntries = MAX_REMEMBERED_REVIEWS, maxBytes = MAX_REMEMBERED_REVIEW_BYTES) {
    this.#maxEntries = maxEntries
    this.#maxBytes = maxBytes
  }

  get size(): number {
    return this.#reviews.size
  }

  get bytes(): number {
    return this.#bytes
  }

  remember(review: RememberedAgentReview): void {
    this.#delete(review.key)
    // A patch bigger than the whole budget would evict every other review and
    // still not fit. Its title and file list are kept; the patch itself is read
    // back from the pull-request cache on disk when an agent asks for it.
    const kept = review.patch.length > this.#maxBytes ? { ...review, patch: '' } : review
    this.#reviews.set(kept.key, kept)
    this.#bytes += kept.patch.length
    while (this.#reviews.size > this.#maxEntries || this.#bytes > this.#maxBytes) {
      const oldest = this.#reviews.keys().next().value
      if (oldest == null) break
      this.#delete(oldest)
    }
  }

  get(key: string): RememberedAgentReview | null {
    return this.#reviews.get(key) ?? null
  }

  clear(): void {
    this.#reviews.clear()
    this.#bytes = 0
  }

  #delete(key: string): void {
    const existing = this.#reviews.get(key)
    if (existing == null) return
    this.#reviews.delete(key)
    this.#bytes -= existing.patch.length
  }
}

export function agentReviewPaths(root: string): { directory: string; patch: string; brief: string } {
  const directory = join(root, AGENT_REVIEW_DIR)
  return {
    directory,
    patch: join(directory, AGENT_REVIEW_PATCH_NAME),
    brief: join(directory, AGENT_REVIEW_BRIEF_NAME)
  }
}

export async function writeAgentReviewBundle(
  root: string,
  review: RememberedAgentReview,
  snapshot: RepositorySnapshot
): Promise<{ patchPath: string; briefPath: string }> {
  await ensureKodiExcluded(root)
  const paths = agentReviewPaths(root)
  await mkdir(paths.directory, { recursive: true })
  const brief = formatAgentReviewBrief(review, snapshot, paths.patch)
  await Promise.all([
    writeFile(paths.patch, review.patch, 'utf8'),
    writeFile(paths.brief, brief, 'utf8')
  ])
  return { patchPath: paths.patch, briefPath: paths.brief }
}

export async function prepareAgentReviewContext(options: {
  snapshot: RepositorySnapshot | null
  subject: AgentRequestSubject
  remembered: RememberedAgentReview | null
  cached: CachedReviewPatch | null
}): Promise<string> {
  const { snapshot, subject, remembered, cached } = options
  const review = withCachedPatch(remembered, rememberedFromCache(cached, subject))
  if (snapshot == null || snapshot.kind !== 'git') {
    return formatAgentReviewInstructions({
      subject,
      review,
      snapshot,
      patchPath: null,
      briefPath: null
    })
  }
  if (review != null && review.patch !== '') {
    const written = await writeAgentReviewBundle(snapshot.root, review, snapshot)
    return formatAgentReviewInstructions({
      subject,
      review,
      snapshot,
      patchPath: written.patchPath,
      briefPath: written.briefPath
    })
  }
  return formatAgentReviewInstructions({
    subject,
    review,
    snapshot,
    patchPath: null,
    briefPath: null
  })
}

export function formatAgentReviewInstructions(options: {
  subject: AgentRequestSubject
  review: RememberedAgentReview | null
  snapshot: RepositorySnapshot | null
  patchPath: string | null
  briefPath: string | null
}): string {
  const { subject, review, snapshot, patchPath, briefPath } = options
  const files = (review?.files ?? []).slice(0, AGENT_CONTEXT_FILE_LIMIT).map((file) => (
    `${file.path} (+${file.additions}/-${file.deletions})`
  ))
  const overflow = (review?.files.length ?? 0) > AGENT_CONTEXT_FILE_LIMIT
    ? [`…and ${(review?.files.length ?? 0) - AGENT_CONTEXT_FILE_LIMIT} more files`]
    : []
  const omitted = (review?.omittedFiles ?? []).map((file) => file.path)
  return [
    'Kodi already loaded this review. Do not fetch remotes, clone repositories, or call GitHub, gh, or the network.',
    'The working directory is the matching local checkout. Stay inside it.',
    `Local checkout: ${subject.repositoryRoot}`,
    `Current branch: ${subject.workingBranch ?? snapshot?.branch ?? 'unknown'} (this is the current codebase; it may differ from the pull-request head)`,
    review == null ? null : `Review: ${review.title}`,
    subject.pullRequestUrl == null ? null : `Pull request: ${subject.pullRequestUrl}`,
    patchPath == null
      ? 'No local patch file is available. Read the listed files from this checkout. Do not search for the pull-request commits with git fetch or gh.'
      : `Read this patch first: ${patchPath}`,
    briefPath == null ? null : `Review brief: ${briefPath}`,
    'After the patch, read only those files and their direct callers or callees in this checkout.',
    'When a flow, state machine, or sequence helps, include a mermaid diagram.',
    omitted.length === 0 ? null : `Omitted from the patch: ${omitted.join(', ')}`,
    files.length === 0 ? null : ['Changed files:', ...files, ...overflow].join('\n')
  ].filter((line): line is string => line != null && line !== '').join('\n')
}

function formatAgentReviewBrief(
  review: RememberedAgentReview,
  snapshot: RepositorySnapshot,
  patchPath: string
): string {
  const files = review.files.slice(0, AGENT_CONTEXT_FILE_LIMIT).map((file) => (
    `- ${file.path} (+${file.additions}/-${file.deletions})`
  ))
  const overflow = review.files.length > AGENT_CONTEXT_FILE_LIMIT
    ? [`- …and ${review.files.length - AGENT_CONTEXT_FILE_LIMIT} more files`]
    : []
  return [
    `# ${review.title}`,
    '',
    'This pull request is already loaded. Do not fetch from GitHub.',
    '',
    `- Repository: ${snapshot.name}`,
    `- Root: ${snapshot.root}`,
    `- Current branch: ${snapshot.branch ?? 'unknown'}`,
    review.pullRequestUrl == null ? null : `- Pull request: ${review.pullRequestUrl}`,
    `- Base: ${review.baseOid}`,
    `- Head: ${review.headOid}`,
    `- Patch: ${patchPath}`,
    '',
    '## Changed files',
    ...files,
    ...overflow
  ].filter((line): line is string => line != null).join('\n')
}

// A review too big to keep its patch in memory is remembered for its title and
// file list; the pull-request cache supplies the patch it gave up.
function withCachedPatch(
  remembered: RememberedAgentReview | null,
  cached: RememberedAgentReview | null
): RememberedAgentReview | null {
  if (remembered == null) return cached
  if (remembered.patch !== '' || cached == null) return remembered
  return { ...remembered, patch: cached.patch }
}

function rememberedFromCache(
  cached: CachedReviewPatch | null,
  subject: AgentRequestSubject
): RememberedAgentReview | null {
  if (cached == null || subject.baseOid == null || subject.headOid == null) return null
  if (cached.headRefOid !== subject.headOid || cached.patch === '') return null
  return {
    key: reviewKey(subject.baseOid, subject.headOid),
    title: subject.pullRequestUrl ?? subject.repositoryName,
    ...(subject.pullRequestUrl == null ? {} : { pullRequestUrl: subject.pullRequestUrl }),
    baseOid: subject.baseOid,
    headOid: subject.headOid,
    files: cached.files,
    omittedFiles: cached.omittedFiles,
    patch: cached.patch
  }
}

export async function resolveGitDirectory(root: string): Promise<string | null> {
  const gitPath = join(root, '.git')
  const info = await stat(gitPath).catch(() => null)
  if (info == null) return null
  if (info.isDirectory()) return gitPath
  if (!info.isFile()) return null
  const text = await readFile(gitPath, 'utf8')
  const match = /^gitdir:\s*(.+)$/m.exec(text)
  if (match?.[1] == null) return null
  const gitdir = match[1].trim()
  return isAbsolute(gitdir) ? gitdir : resolve(root, gitdir)
}

async function ensureKodiExcluded(root: string): Promise<void> {
  const gitDir = await resolveGitDirectory(root)
  if (gitDir == null) return
  const excludePath = join(gitDir, 'info', 'exclude')
  const current = await readFile(excludePath, 'utf8').catch(() => '')
  const lines = current.split('\n')
  if (lines.some((line) => line.trim() === AGENT_REVIEW_EXCLUDE)) return
  await mkdir(join(gitDir, 'info'), { recursive: true })
  const prefix = current === '' || current.endsWith('\n') ? current : `${current}\n`
  await writeFile(excludePath, `${prefix}${AGENT_REVIEW_EXCLUDE}\n`, 'utf8')
}
