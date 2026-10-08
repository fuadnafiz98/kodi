import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants as fileConstants } from 'node:fs'
import { access, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { cpus, homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path'

import type {
  AgentRequestSubject,
  ContentSearchResult,
  DiffFileContents,
  FileComparison,
  ImagePreviewSide,
  GitCommit,
  GitIntegrationSnapshot,
  RepositoryPullRequests,
  GitRemote,
  InboxPullRequest,
  LocalBranch,
  LocalBranchReview,
  LocalReviewProgress,
  OmittedDiffFile,
  PullRequestChecks,
  PullRequestFile,
  PullRequestInboxSection,
  PullRequestInboxSectionKey,
  PullRequestInboxSnapshot,
  PullRequestConversation,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestReviewEvent,
  PullRequestSnapshotIdentity,
  PullRequestSummary,
  RemoteBranch,
  RemoteReviewComment,
  RemoteReviewSummary,
  RemoteReviewThread,
  RepositoryFileStatus,
  RepositorySnapshot,
  RepositoryStatusEntry,
  WorkingFileSaveRequest,
  WorkingTreePatch
} from '../shared/contracts.js'
import { createImagePreviewSide } from '../shared/imagePreview.js'
import { inboxRepoScope } from '../shared/inboxRepos.js'
import { parseDiffGitHeaderPaths } from '../shared/patchHeaders.js'
import { normalizeGitHubPullRequestUrl } from '../shared/pullRequestUrl.js'
import { MAX_CACHED_PATHS } from '../shared/workspaceCache.js'
import {
  COMMAND_ABORTED_MESSAGE,
  COMMAND_EXECUTION_TIMEOUT_MESSAGE,
  awaitAll,
  comparePaths,
  GitObjectReader,
  MAX_DIFF_FILE_BYTES,
  mapWithConcurrency,
  runCommand,
  splitNullDelimited,
  type CommandLane,
  type CommandLaneSource,
  type CommandResult,
  type GitObjectRead
} from './gitCommands.js'
import {
  buildPullRequestPatchFromFiles,
  chunkPatchByFileCount,
  chunkPathspecGroups,
  createNewFilePatch,
  isolateFirstPathspec,
  isolateFirstPathspecGroup,
  pathspecGroupForFile,
  diffFilesFromChurn,
  filesFromPatch,
  isPullRequestDiffTooLargeError,
  limitPatchFileSize,
  MAX_PULL_REQUEST_FILES,
  parseNumstat,
  PULL_REQUEST_FILES_PAGE_SIZE,
  selectOversizedDiffFiles,
  type RawPullRequestFile
} from './patchBuilder.js'
import {
  MAX_REMEMBERED_REVIEW_BYTES,
  prepareAgentReviewContext,
  resolveRememberedReview,
  rememberedAgentReviewFrom,
  RememberedReviewStore,
  reviewKey,
  type RememberedAgentReview
} from './agentReviewBundle.js'
import {
  PullRequestReviewFlight,
  ReviewFlight,
  type PullRequestProgressListener
} from './pullRequestFlights.js'
import {
  EXCLUDED_DIRECTORIES,
  EXCLUDED_DIRECTORY_SET,
  EXCLUDED_IGNORED_EXTENSIONS,
  listIgnoredPaths,
  withIgnoredListingDeadline
} from './ignoredListing.js'
import { listRootSnapshot } from './workspaceListing.js'

// Re-exported so the process, object-reading and patch primitives keep one import
// site for callers and tests while living in their own modules.
export {
  GitObjectReader,
  readGitObject,
  type GitObjectRead
} from './gitCommands.js'
export {
  buildPullRequestPatchFromFiles,
  chunkPatchByFileCount,
  chunkPathspecGroups,
  chunkPathspecs,
  createNewFilePatch,
  isolateFirstPathspec,
  isolateFirstPathspecGroup,
  pathspecGroupForFile,
  diffFilesFromChurn,
  filesFromPatch,
  isPullRequestDiffTooLargeError,
  limitPatchFileSize,
  parseNumstat,
  pullRequestFilePageWave,
  selectOversizedDiffFiles,
  type DiffChurnEntry,
  type RawPullRequestFile
} from './patchBuilder.js'

export function pullRequestReviewReply(
  review: PullRequestReview,
  streamed: boolean
): PullRequestReview {
  return streamed
    ? {
        ...review,
        files: [],
        patch: '',
        omittedFiles: [],
        expectedFileCount: review.files.length
      }
    : review
}

/**
 * Splits a cached review into the pages a fresh download would have streamed.
 * The file list is not one entry per patch section — a file too large to diff
 * is listed but has no section — so each page takes the files from its own first
 * section up to the next page's, found by path. A page whose first path cannot
 * be matched hands its files to the page before it, so every file is still
 * delivered exactly once and in order.
 */
export function cachedPullRequestPages(entry: {
  patch: string
  files: PullRequestFile[]
  omittedFiles: OmittedDiffFile[]
}): Array<{ patch: string; files: PullRequestFile[]; omittedFiles: OmittedDiffFile[] }> {
  const chunks = chunkPatchByFileCount(entry.patch)
  if (chunks.length <= 1) {
    return [{ patch: entry.patch, files: entry.files, omittedFiles: entry.omittedFiles }]
  }
  const starts: Array<number | null> = [0]
  let cursor = 0
  for (let index = 1; index < chunks.length; index += 1) {
    const path = firstPatchSectionPath(chunks[index]!)
    let found: number | null = null
    for (let fileIndex = cursor; path != null && fileIndex < entry.files.length; fileIndex += 1) {
      if (entry.files[fileIndex]!.path !== path) continue
      found = fileIndex
      break
    }
    starts.push(found)
    if (found != null) cursor = found
  }
  return chunks.map((patch, index) => {
    const start = starts[index]
    let end = entry.files.length
    for (let next = index + 1; next < starts.length; next += 1) {
      const nextStart = starts[next]
      if (nextStart == null) continue
      end = nextStart
      break
    }
    return {
      patch,
      files: start == null ? [] : entry.files.slice(start, end),
      omittedFiles: index === 0 ? entry.omittedFiles : []
    }
  })
}

function firstPatchSectionPath(patch: string): string | null {
  const newline = patch.indexOf('\n')
  return parseDiffGitHeaderPaths(newline === -1 ? patch : patch.slice(0, newline))?.path ?? null
}

// The palette renders eight. Two hundred hits crossed IPC and were ranked for
// nothing, and the last of them cost the whole scan.
const MAX_SEARCH_RESULTS = 24
// The diff marks every hit in the file on screen, which a repository-wide cap of 24
// cannot cover, so the open file gets its own bounded pass.
const MAX_OPEN_FILE_SEARCH_RESULTS = 200
const CONTENT_SEARCH_MATCHES_PER_FILE = 20
// Above this a file is a bundle or a fixture, not something anyone reads in a
// palette row, and scanning them is most of a cold search.
const CONTENT_SEARCH_MAX_FILESIZE = '1M'
// Ripgrep defaults to one thread per core. On a laptop already running a refresh
// and a review fetch that only makes every one of them slower.
const CONTENT_SEARCH_THREADS = Math.max(1, Math.min(4, cpus().length))
// The byte cap is the real guard: at a 2 MB per-entry ceiling 512 typical source
// files cost a few MB, while 16 entries evicted the first file of any review page
// before the reader could scroll back to it.
const MAX_HEAD_CACHE_ENTRIES = 512
const MAX_HEAD_CACHE_BYTES = 64 * 1024 * 1024
const MAX_WORKING_CACHE_ENTRIES = 256
const MAX_WORKING_CACHE_BYTES = 64 * 1024 * 1024
const MAX_PATCH_COMMAND_CONCURRENCY = 4
const DISCARD_UNLINK_CONCURRENCY = 8
const MAX_PULL_REQUEST_REVIEW_COMMENTS = 100
const PULL_REQUEST_LIST_LIMIT = 30
// A pull request's diff is immutable for a given head oid, so a reopen — after
// closing the panel, after switching to the working tree and back, after a
// restart — can serve it from disk instead of repeating a download the code's own
// comment measures at nearly two minutes for a 3000-file review. A force-push
// produces a new oid and therefore a new key, so staleness is impossible.
const PULL_REQUEST_CACHE_VERSION = 4
const PULL_REQUEST_SNAPSHOT_FORMAT_EPOCH = 1
const MAX_PULL_REQUEST_CACHE_ENTRIES = 60
const MAX_PULL_REQUEST_CACHE_BYTES = 200 * 1024 * 1024
// Written beside the diff so a reopen can paint from disk before `gh` answers:
// the diff is keyed on the head oid, which only `gh pr view` knows, so without a
// URL-keyed pointer even a warm cache waited out the metadata hop.
const PULL_REQUEST_INDEX_SUFFIX = '.latest.json'
const PULL_REQUEST_INDEX_VERSION = 2

export interface CachedPullRequestReview {
  version: number
  snapshotIdentity: PullRequestSnapshotIdentity
  files: PullRequestFile[]
  patch: string
  omittedFiles: OmittedDiffFile[]
}

interface CachedPullRequestReviewMetadata {
  version: number
  snapshotIdentity: PullRequestSnapshotIdentity
  files: PullRequestFile[]
  omittedFiles: OmittedDiffFile[]
  patchLength: number
}

interface PullRequestPatchPage {
  patch: string
  files: PullRequestFile[]
  omittedFiles: OmittedDiffFile[]
}

/** Everything needed to open a review from disk before the first `gh` answer. */
export interface CachedPullRequestIndex {
  version: number
  url: string
  headRefOid: string
  baseRefOid: string
  snapshotIdentity: PullRequestSnapshotIdentity
  viewerCanSubmitDecision: boolean
  summary: PullRequestSummary
  writtenAt: number
}

export function pullRequestSnapshotIdentity(review: PullRequestReview): PullRequestSnapshotIdentity {
  const normalized = normalizeGitHubPullRequestUrl(review.pullRequest.url)
  const match = normalized == null ? null : new URL(normalized)
  const [owner = '', repository = ''] = match?.pathname.split('/').filter(Boolean) ?? []
  return {
    formatEpoch: PULL_REQUEST_SNAPSHOT_FORMAT_EPOCH,
    host: match?.host.toLowerCase() ?? '',
    repository: `${owner}/${repository}`.toLowerCase(),
    number: review.pullRequest.number,
    baseRefName: review.pullRequest.baseRefName,
    baseOid: review.baseOid,
    headRefName: review.pullRequest.headRefName,
    headOid: review.headOid,
    effectiveBaseOid: review.baseOid,
    patchSource: 'github'
  }
}

function sameSnapshotIdentity(
  left: PullRequestSnapshotIdentity,
  right: PullRequestSnapshotIdentity
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
const MAX_REVIEW_BODY_LENGTH = 65_536
// `gh search prs --json` only exposes these pull request fields; richer fields need `gh pr view`.
const PULL_REQUEST_LIST_FIELDS = 'number,title,url,state,isDraft,author,headRefName,baseRefName,reviewDecision,updatedAt,additions,deletions,changedFiles'
// `files` and the check fields used to ride this hop. `files` duplicates what the
// diff already carries and the check rollup is the slowest field GitHub serves, so
// the call that opens the review now asks for neither.
const PULL_REQUEST_REVIEW_FIELDS = `${PULL_REQUEST_LIST_FIELDS},baseRefOid,headRefOid`
// Past this, `gh pr diff` returns one document that has to arrive in full before a
// single file can be shown, while the files API streams a page at a time.
const PULL_REQUEST_FILES_API_THRESHOLD = 300
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const GIT_REVISION_PATTERN = /^[0-9a-f]{7,64}$/i
// Requested separately because older `gh` builds reject the whole command when a field name is unknown.
const PULL_REQUEST_CHECK_FIELDS = 'statusCheckRollup,mergeable'
const PASSING_CHECK_RESULTS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const FAILING_CHECK_RESULTS = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'ACTION_REQUIRED', 'CANCELLED', 'CANCELED'])
// Listed in precedence order: the first section that claims a pull request keeps it.
const PULL_REQUEST_INBOX_SECTIONS = [
  { key: 'review-requested', title: 'Needs your review', alias: 'reviewRequested', qualifier: 'review-requested' },
  { key: 'assigned', title: 'Assigned to you', alias: 'assigned', qualifier: 'assignee' },
  { key: 'mentioned', title: 'Mentions you', alias: 'mentioned', qualifier: 'mentions' },
  { key: 'authored', title: 'Your open PRs', alias: 'authored', qualifier: 'author' }
] as const satisfies readonly {
  key: PullRequestInboxSectionKey
  title: string
  alias: string
  qualifier: string
}[]

// One aliased search per section in a single request. As four `gh search prs`
// spawns this cost four processes and four calls against the search API's 30/min
// budget on every poll tick; batched it is one of each.
const PULL_REQUEST_INBOX_QUERY = `
  query PullRequestInbox($reviewRequested: String!, $assigned: String!, $mentioned: String!, $authored: String!) {
    reviewRequested: search(type: ISSUE, query: $reviewRequested, first: 50) { nodes { ...InboxPullRequest } }
    assigned: search(type: ISSUE, query: $assigned, first: 50) { nodes { ...InboxPullRequest } }
    mentioned: search(type: ISSUE, query: $mentioned, first: 50) { nodes { ...InboxPullRequest } }
    authored: search(type: ISSUE, query: $authored, first: 50) { nodes { ...InboxPullRequest } }
  }
  fragment InboxPullRequest on PullRequest {
    number
    title
    url
    state
    isDraft
    updatedAt
    author { login avatarUrl }
  }
`

// GraphQL reports PullRequestState as an enum (OPEN), while `gh search prs --json`
// reported it lowercase. The renderer contract keeps the lowercase spelling.
export function parsePullRequestInboxResponse(value: unknown): PullRequestInboxEntry[] {
  const data = (value as { data?: Record<string, unknown> })?.data
  if (typeof data !== 'object' || data == null) return []
  const entries: PullRequestInboxEntry[] = []
  for (const { key, alias } of PULL_REQUEST_INBOX_SECTIONS) {
    const nodes = (data[alias] as { nodes?: unknown })?.nodes
    if (!Array.isArray(nodes)) continue
    for (const node of nodes) {
      if (typeof node !== 'object' || node == null) continue
      const record = node as Record<string, unknown>
      entries.push({
        key,
        pullRequest: {
          ...record,
          state: typeof record.state === 'string' ? record.state.toLowerCase() : record.state
        }
      })
    }
  }
  return entries
}
const SELF_REVIEW_DECISION_ERROR = 'GitHub does not allow you to approve or request changes on your own pull request. Submit the review as a comment instead.'
const ADD_PULL_REQUEST_REVIEW_MUTATION = `
  mutation AddPullRequestReview($input: AddPullRequestReviewInput!) {
    addPullRequestReview(input: $input) {
      pullRequestReview { id }
    }
  }
`
const PULL_REQUEST_THREADS_QUERY = `
  query PullRequestThreads($owner: String!, $name: String!, $number: Int!, $threadCursor: String, $reviewCursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        body
        headRefOid
        reviewThreads(first: 100, after: $threadCursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            startLine
            originalLine
            originalStartLine
            diffSide
            comments(first: 100) {
              pageInfo { hasNextPage endCursor }
              nodes { id body diffHunk author { login avatarUrl } createdAt }
            }
          }
        }
        reviews(first: 50, after: $reviewCursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id state body submittedAt author { login avatarUrl } }
        }
      }
    }
  }
`
const PULL_REQUEST_THREAD_COMMENTS_QUERY = `
  query PullRequestThreadComments($id: ID!, $cursor: String) {
    node(id: $id) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes { id body author { login avatarUrl } createdAt }
        }
      }
    }
  }
`
const MAX_CONVERSATION_PAGES = 20
const MAX_CONVERSATION_BYTES = 8 * 1024 * 1024
const CONVERSATION_CACHE_TTL_MS = 10_000
const conversationCache = new Map<string, { value: PullRequestConversation; fetchedAt: number }>()
const conversationFlights = new Map<string, Promise<PullRequestConversation>>()

export function conversationCacheEntryCount(): number {
  return conversationCache.size
}
const ADD_REVIEW_THREAD_REPLY_MUTATION = `
  mutation AddReviewThreadReply($input: AddPullRequestReviewThreadReplyInput!) {
    addPullRequestReviewThreadReply(input: $input) {
      comment { id }
    }
  }
`
const RESOLVE_REVIEW_THREAD_MUTATION = `
  mutation ResolveReviewThread($input: ResolveReviewThreadInput!) {
    resolveReviewThread(input: $input) { thread { id isResolved } }
  }
`
const UNRESOLVE_REVIEW_THREAD_MUTATION = `
  mutation UnresolveReviewThread($input: UnresolveReviewThreadInput!) {
    unresolveReviewThread(input: $input) { thread { id isResolved } }
  }
`
const MAX_REMOTE_THREAD_BODY_LENGTH = 65_536
const GH_EXECUTABLE_CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'] as const
// Refreshing reads the index, and git can still rewrite it (an ancient index
// version, a racy stat) even with the optional locks off. The watcher is told the
// write is ours so it does not answer our own read with another refresh.
const GIT_INDEX_PATH = '.git/index'
// The watcher forgets a self-write one second after it is announced
// (`SELF_WRITE_WINDOW_MS`). An index write re-announces well inside that, so
// its window never lapses however long the command runs.
const SELF_WRITE_HEARTBEAT_MS = 400
// The gitignored listing is the only part of a refresh that can outlive the
// branch and the statuses, so it gets its own window: beat this and it joins the
// snapshot, miss it and the snapshot ships without it and merges the set later.
const IGNORED_LISTING_DEADLINE_MS = 400
// A pathological tree must not keep a walk (and a git child) alive forever.
const IGNORED_LISTING_TIMEOUT_MS = 10_000
const SEARCH_CANCELLED_MESSAGE = 'The search was cancelled before it finished.'
const SEARCH_INTERRUPTED_MESSAGE = 'The search stopped before it finished.'
const RIPGREP_EXCLUSION_ARGS = [
  ...EXCLUDED_DIRECTORIES.flatMap((directory) => [
    '--glob',
    `!${directory}/**`,
    '--glob',
    `!**/${directory}/**`
  ]),
  ...[...EXCLUDED_IGNORED_EXTENSIONS].flatMap((extension) => [
    '--glob',
    `!*${extension}`
  ])
]
const RIPGREP_VISIBLE_FILE_ARGS = [
  '--hidden',
  '--no-ignore-vcs',
  '--glob',
  '!.git/**',
  ...RIPGREP_EXCLUSION_ARGS
]

// `file` is the materialized diff side, built once when the version is read.
// Rebuilding it per comparison re-ran a utf8 decode and a sha1 over the whole
// buffer on every navigation, scroll hydration and post-save refetch.
type ReadVersion = {
  file: DiffFileContents | null
  binary: boolean
  oversized: boolean
  image?: ImagePreviewSide | null
}

type WorkingFileRead = ReadVersion & {
  contents: Buffer | null
  revision: string
}

export function isSameGitHubLogin(firstLogin: string, secondLogin: string): boolean {
  return firstLogin.trim().toLowerCase() === secondLogin.trim().toLowerCase()
}

const require = createRequire(import.meta.url)
const { rgPath } = require('@vscode/ripgrep') as { rgPath: string }
export const RIPGREP_EXECUTABLE = resolvePackagedExecutablePath(rgPath)

export function resolvePackagedExecutablePath(executablePath: string): string {
  return executablePath.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

let ghExecutablePromise: Promise<string> | null = null

function getGhExecutable(): Promise<string> {
  ghExecutablePromise ??= (async () => {
    for (const candidate of GH_EXECUTABLE_CANDIDATES) {
      try {
        await access(candidate, fileConstants.X_OK)
        return candidate
      } catch {
      }
    }
    return 'gh'
  })()
  return ghExecutablePromise
}


export type PullRequestReviewIntent = 'foreground' | 'warmup'

/**
 * A warmup is speculative — nobody is waiting on it — so its `gh` hops queue
 * behind the ones a reader is watching instead of racing them for slots.
 */
export function pullRequestReviewLane(intent: PullRequestReviewIntent): CommandLane {
  return intent === 'warmup' ? 'background' : 'interactive'
}

function isTransientGitHubError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /HTTP\s+(?:502|503|504)\b|timed?\s*out|timeout|connection reset/i.test(message)
}

const GITHUB_MUTATION_SPACING_MS = 1_000
let githubMutationTail: Promise<void> = Promise.resolve()
let lastGitHubMutationStartedAt = 0

function runGitHubMutation<Result>(operation: () => Promise<Result>): Promise<Result> {
  const run = githubMutationTail.catch(() => undefined).then(async () => {
    const waitMs = Math.max(0, GITHUB_MUTATION_SPACING_MS - (Date.now() - lastGitHubMutationStartedAt))
    if (waitMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs))
    lastGitHubMutationStartedAt = Date.now()
    return operation()
  })
  githubMutationTail = run.then(() => undefined, () => undefined)
  return run.catch((error: unknown) => {
    if (error instanceof Error && error.message === COMMAND_EXECUTION_TIMEOUT_MESSAGE) {
      throw new Error('GitHub may have accepted this change, but Kodi could not confirm the outcome. Refresh before you resend it.')
    }
    throw error
  })
}

/**
 * Exported for the lane test: the retry loop is the one place a `gh` hop can
 * silently lose the lane it was queued on.
 */
export async function runGitHubReadCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
  lane: CommandLaneSource = 'interactive'
): Promise<CommandResult> {
  const retryDelays = [0, 250, 750] as const
  let lastError: unknown
  for (const retryDelay of retryDelays) {
    if (signal?.aborted === true) throw new Error(COMMAND_ABORTED_MESSAGE)
    if (retryDelay > 0) await new Promise((resolve) => setTimeout(resolve, retryDelay))
    try {
      return await runCommand(executable, args, cwd, [], undefined, signal, lane)
    } catch (error) {
      lastError = error
      if (!isTransientGitHubError(error)) throw error
    }
  }
  throw lastError
}

function gitHubIntegrationErrorMessage(error: unknown): string {
  if (isTransientGitHubError(error)) {
    return 'GitHub timed out while loading the pull request list. Retry, or open a pull request directly by number or URL.'
  }
  return error instanceof Error ? error.message : String(error)
}

const COMMIT_EXECUTION_TIMEOUT_MS = 10 * 60_000
const MAX_COMMIT_MESSAGE_LENGTH = 64 * 1024

export function parseCommitRequest(value: unknown): { message: string; amend: boolean; all: boolean } {
  if (typeof value !== 'object' || value == null) throw new Error('The commit request is invalid.')
  const record = value as Record<string, unknown>
  if (typeof record.message !== 'string' || record.message.length > MAX_COMMIT_MESSAGE_LENGTH) {
    throw new Error('The commit message must be text under 64 KB.')
  }
  return {
    message: record.message.trim(),
    amend: record.amend === true,
    all: record.all === true
  }
}

export type IndexOperation = 'stage' | 'unstage' | 'discard'

/**
 * The paths one index operation names for the entries the reader picked. A
 * staged rename has already dropped its original path from the index and the
 * working tree, so handing it to `add` or `restore --worktree` fails the whole
 * batch; unstaging needs both halves back, or the index keeps the deletion
 * without the addition. An unstaged rename (an intent-to-add file) still has
 * its original in the index, and staging or discarding it needs that path too.
 * Discarding never restores an intent-to-add path itself: its index entry is an
 * empty placeholder, so `restore --worktree` emptied the file and left it
 * listed as added. `discardPaths` drops those entries and deletes the files.
 * A fully staged entry has no working-tree side to stage or discard — a staged
 * deletion would match nothing at all — and an untracked one has nothing to
 * unstage.
 */
export function indexPathspecs(entries: readonly RepositoryStatusEntry[], operation: IndexOperation): string[] {
  const pathspecs = new Set<string>()
  for (const entry of entries) {
    if (operation === 'unstage') {
      if (entry.status === 'untracked') continue
      pathspecs.add(entry.path)
      if (entry.previousPath != null) pathspecs.add(entry.previousPath)
      continue
    }
    if (entry.staged === 'all') continue
    if (operation === 'stage' || !isIntentToAdd(entry)) pathspecs.add(entry.path)
    if (entry.previousPath != null && entry.staged == null) pathspecs.add(entry.previousPath)
  }
  return [...pathspecs]
}

/**
 * `git add -N`: the index holds a placeholder for the path and nothing else, so
 * the whole file is working-tree work. Porcelain reports it as ` A`, or as ` R`
 * when git pairs it with a deleted tracked file.
 */
export function isIntentToAdd(entry: RepositoryStatusEntry): boolean {
  return entry.staged == null && (entry.status === 'added' || entry.status === 'renamed')
}

function discardFailure(path: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | null)?.code
  const reason = code === 'EACCES' || code === 'EPERM'
    ? 'permission denied'
    : code === 'EBUSY' ? 'it is in use' : 'it could not be removed'
  return new Error(`Could not delete ${path}: ${reason}.`, { cause: error })
}

export function mapGitStatus(indexStatus: string, workingStatus: string): RepositoryFileStatus {
  if (indexStatus === '?' && workingStatus === '?') return 'untracked'
  // Unmerged combinations from git-status(1): DD, AU, UD, UA, DU, AA, UU.
  if (
    indexStatus === 'U' || workingStatus === 'U' ||
    (indexStatus === 'A' && workingStatus === 'A') ||
    (indexStatus === 'D' && workingStatus === 'D')
  ) return 'conflicted'
  if (indexStatus === 'R' || workingStatus === 'R') return 'renamed'
  if (indexStatus === 'A' || workingStatus === 'A') return 'added'
  if (indexStatus === 'D' || workingStatus === 'D') return 'deleted'
  return 'modified'
}

// The index half of an XY pair. A conflict is neither: it has to be resolved
// before it can be staged, so it always lists with the working-tree changes.
export function stagedState(
  status: RepositoryFileStatus,
  indexStatus: string,
  workingStatus: string
): RepositoryStatusEntry['staged'] {
  if (status === 'conflicted' || status === 'untracked' || indexStatus === ' ') return undefined
  return workingStatus === ' ' ? 'all' : 'partial'
}

// A full refresh rebuilds the snapshot from a whole-tree status walk. A save
// touches one file, so the entry for that path is swapped in place instead —
// preserving the order a full refresh would produce (tracked entries in path
// order, then untracked ones) so the two never disagree.
export function replaceStatusEntry(
  statuses: readonly RepositoryStatusEntry[],
  path: string,
  next: RepositoryStatusEntry | null
): RepositoryStatusEntry[] {
  const tracked: RepositoryStatusEntry[] = []
  const untracked: RepositoryStatusEntry[] = []
  for (const entry of statuses) {
    if (entry.path === path) continue
    if (entry.status === 'untracked') untracked.push(entry)
    else tracked.push(entry)
  }
  if (next != null) {
    const target = next.status === 'untracked' ? untracked : tracked
    const index = target.findIndex((entry) => comparePaths(entry.path, path) > 0)
    target.splice(index === -1 ? target.length : index, 0, next)
  }
  return [...tracked, ...untracked]
}

export interface PorcelainV2Status {
  branch: string | null
  head: string | null
  statuses: RepositoryStatusEntry[]
  untrackedPaths: string[]
}

// `--porcelain=v2 --branch` carries the branch name and HEAD oid in its header
// lines and the untracked set in its `?` records, so one call replaces the four
// that `refresh()` used to make (status, branch --show-current, rev-parse HEAD,
// and a second working-tree walk via `ls-files --others`).
export function parsePorcelainV2Status(buffer: Buffer): PorcelainV2Status {
  const fields = splitNullDelimited(buffer)
  const statuses: RepositoryStatusEntry[] = []
  const untrackedPaths: string[] = []
  let branch: string | null = null
  let head: string | null = null

  // v2 spells "unmodified" as '.' where v1 used a space.
  const statusChar = (value: string | undefined): string => (value === '.' ? ' ' : value ?? ' ')
  const entryFor = (path: string, xy: string, previousPath?: string): RepositoryStatusEntry => {
    const status = mapGitStatus(statusChar(xy[0]), statusChar(xy[1]))
    const staged = stagedState(status, statusChar(xy[0]), statusChar(xy[1]))
    return {
      path,
      ...(previousPath == null ? {} : { previousPath }),
      status,
      ...(staged == null ? {} : { staged })
    }
  }

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (field == null || field === '') continue

    if (field.startsWith('# branch.head ')) {
      const value = field.slice('# branch.head '.length).trim()
      branch = value === '(detached)' ? null : value
      continue
    }
    if (field.startsWith('# branch.oid ')) {
      const value = field.slice('# branch.oid '.length).trim()
      head = value === '(initial)' ? null : value
      continue
    }
    if (field.startsWith('# ')) continue

    if (field.startsWith('? ')) {
      untrackedPaths.push(field.slice(2))
      continue
    }
    if (field.startsWith('! ')) continue

    const parts = field.split(' ')
    const kind = parts[0]
    // Paths may contain spaces, so the remainder is rejoined rather than indexed.
    if (kind === '1' && parts.length > 8) {
      statuses.push(entryFor(parts.slice(8).join(' '), parts[1] ?? '..'))
      continue
    }
    if (kind === '2' && parts.length > 9) {
      // A rename record is followed by its original path in the next NUL field.
      const previousPath = fields[index + 1]
      index += 1
      statuses.push(entryFor(parts.slice(9).join(' '), parts[1] ?? '..', previousPath))
      continue
    }
    if (kind === 'u' && parts.length > 10) {
      statuses.push(entryFor(parts.slice(10).join(' '), parts[1] ?? '..'))
    }
  }

  for (const path of untrackedPaths) {
    statuses.push({ path, status: 'untracked' })
  }

  return { branch, head, statuses, untrackedPaths }
}

function isWithinRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function createCacheKey(...parts: Array<string | Buffer | null>): string {
  const hash = createHash('sha1')
  for (const part of parts) {
    if (part != null) hash.update(part)
    hash.update('\0')
  }
  return hash.digest('hex')
}

function isBinary(contents: Buffer): boolean {
  const inspectionLength = Math.min(contents.length, 8_000)
  for (let byteIndex = 0; byteIndex < inspectionLength; byteIndex += 1) {
    if (contents[byteIndex] === 0) return true
  }
  return false
}

// Answered per parent directory rather than per path: on a 100k-path snapshot the
// split-and-scan version cost 67 ms of the 120 ms refresh, and every path under a
// directory shares its answer.
const excludedDirectoryMemo = new Map<string, boolean>()

const MAX_EXCLUDED_DIRECTORY_MEMO_ENTRIES = 100_000

function isExcludedDirectory(directory: string): boolean {
  const memoized = excludedDirectoryMemo.get(directory)
  if (memoized !== undefined) return memoized
  if (excludedDirectoryMemo.size >= MAX_EXCLUDED_DIRECTORY_MEMO_ENTRIES) excludedDirectoryMemo.clear()
  const separator = Math.max(directory.lastIndexOf('/'), directory.lastIndexOf('\\'))
  const segment = separator === -1 ? directory : directory.slice(separator + 1)
  const excluded = EXCLUDED_DIRECTORY_SET.has(segment)
    || (separator > 0 && isExcludedDirectory(directory.slice(0, separator)))
  excludedDirectoryMemo.set(directory, excluded)
  return excluded
}

function isExcludedPath(path: string): boolean {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator > 0 && isExcludedDirectory(path.slice(0, separator))
}

function lastPathSegment(path: string): string {
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separator === -1 ? path : path.slice(separator + 1)
}

function ignoredFileExtension(path: string): string {
  const name = lastPathSegment(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

function isExcludedIgnoredPath(path: string): boolean {
  return isExcludedPath(path)
    || EXCLUDED_DIRECTORY_SET.has(lastPathSegment(path))
    || EXCLUDED_IGNORED_EXTENSIONS.has(ignoredFileExtension(path))
}

// Joining a promise only to sequence work after it, whether it kept or broke.
function ignoreSettled(): void {}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index])
}

function prepareVisiblePaths(buffer: Buffer): string[] {
  const paths: string[] = []
  for (const rawPath of splitNullDelimited(buffer)) {
    const path = rawPath.replace(/^\.\//, '')
    if (!isExcludedPath(path)) paths.push(path)
  }
  return paths.sort(comparePaths)
}

// Tracked paths come from `ls-files`, untracked ones from the same status call
// that produced the statuses, ignored ones from a second `ls-files` that skips
// heavy generated directories. A file can appear in more than one list, so the
// set is deduplicated.
//
// The build-output exclusion applies only to the untracked and ignored sides. A
// repository that commits its `dist/` is telling git those files matter; hiding
// them made them unreviewable and made commit reviews disagree with their own
// patch, which never carried the exclusion.
export function mergeVisiblePaths(
  trackedBuffer: Buffer,
  untrackedPaths: readonly string[],
  ignoredPaths: readonly string[] = []
): string[] {
  return mergeSortedUnique(sortedTrackedPaths(trackedBuffer), extraVisiblePaths(untrackedPaths, ignoredPaths))
}

function sortedTrackedPaths(trackedBuffer: Buffer): string[] {
  return [...new Set(splitNullDelimited(trackedBuffer))].sort(comparePaths)
}

function extraVisiblePaths(untrackedPaths: readonly string[], ignoredPaths: readonly string[]): string[] {
  const extra = new Set<string>()
  for (const rawPath of untrackedPaths) {
    const path = rawPath.replace(/^\.\//, '')
    if (!isExcludedPath(path)) extra.add(path)
  }
  for (const rawPath of ignoredPaths) {
    const path = rawPath.replace(/^\.\//, '')
    if (!isExcludedIgnoredPath(path)) extra.add(path)
  }
  return [...extra].sort(comparePaths)
}

/** Union of two sorted, individually duplicate-free lists, in one pass. */
function mergeSortedUnique(left: readonly string[], right: readonly string[]): string[] {
  if (right.length === 0) return [...left]
  const merged: string[] = []
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    const order = comparePaths(left[leftIndex]!, right[rightIndex]!)
    if (order <= 0) merged.push(left[leftIndex++]!)
    else merged.push(right[rightIndex++]!)
    if (order === 0) rightIndex += 1
  }
  while (leftIndex < left.length) merged.push(left[leftIndex++]!)
  while (rightIndex < right.length) merged.push(right[rightIndex++]!)
  return merged
}


export function classifySearchCompletion(outcome: {
  cancelled: boolean
  code: number | null
  signal: string | null
  resultCount: number
  errorOutput: string
  resultCap?: number
}): { kind: 'results' } | { kind: 'error'; message: string } {
  if (outcome.cancelled) return { kind: 'error', message: SEARCH_CANCELLED_MESSAGE }
  if (outcome.resultCount >= (outcome.resultCap ?? MAX_SEARCH_RESULTS)) return { kind: 'results' }
  if (outcome.signal != null) return { kind: 'error', message: SEARCH_INTERRUPTED_MESSAGE }
  if (outcome.code != null && outcome.code > 1) {
    return {
      kind: 'error',
      message: outcome.errorOutput.trim() || `Search failed with exit code ${outcome.code}.`
    }
  }
  return { kind: 'results' }
}

/**
 * The path of the file the reader has open, as ripgrep will accept it. Anything
 * that could climb out of the repository is refused rather than corrected.
 */
export function contentSearchOpenPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.trim().replace(/^\.\//, '')
  if (path === '' || path.length > 1024 || isAbsolute(path)) return null
  if (path.split(/[\\/]/).some((segment) => segment === '..')) return null
  return path
}

function contentSearchResultKey(result: ContentSearchResult): string {
  return `${result.path}:${result.line}:${result.column}`
}

/** Repository hits first — the palette reads from the top — then whatever the
 * open file's own pass found that they missed. */
export function mergeContentSearchResults(
  workspace: readonly ContentSearchResult[],
  openFile: readonly ContentSearchResult[]
): ContentSearchResult[] {
  const merged = [...workspace]
  if (openFile.length === 0) return merged
  const seen = new Set(merged.map(contentSearchResultKey))
  for (const result of openFile) {
    const key = contentSearchResultKey(result)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(result)
  }
  return merged
}

export function isPathWithinApprovedRoots(roots: readonly string[], candidate: string): boolean {
  return roots.some((root) => isWithinRoot(root, candidate))
}

// The key identifies content, not the read that produced it. Folding the commit
// oid or the file's mtime in here re-keyed every open file after any commit or
// any byte-identical rewrite, which both re-tokenized the whole diff in the
// worker pool and made a pending draft unsavable against its own unchanged file.
function toDiffFile(name: string, contents: Buffer): DiffFileContents {
  return {
    name,
    contents: contents.toString('utf8'),
    cacheKey: createCacheKey(name, contents)
  }
}

function parseJson<T>(result: CommandResult, label: string): T {
  try {
    return JSON.parse(result.stdout.toString('utf8')) as T
  } catch {
    throw new Error(`${label} returned invalid JSON.`)
  }
}

function parseBranches(result: CommandResult): LocalBranch[] {
  return result.stdout.toString('utf8').split('\n').flatMap((line) => {
    if (line === '') return []
    const [head, name, upstream = ''] = line.split('\t')
    if (name == null || name === '') return []
    return [{ name, current: head === '*', upstream: upstream || null }]
  })
}

function parseRemoteBranches(result: CommandResult): RemoteBranch[] {
  return result.stdout.toString('utf8').split('\n').flatMap((name) => {
    if (name === '' || name.endsWith('/HEAD')) return []
    const separatorIndex = name.indexOf('/')
    if (separatorIndex < 1) return []
    return [{ name, remote: name.slice(0, separatorIndex) }]
  })
}

export function parseRemotes(result: CommandResult): GitRemote[] {
  const remotes = new Map<string, GitRemote>()
  for (const line of result.stdout.toString('utf8').split('\n')) {
    const match = /^(\S+)\s+(.+)\s+\((fetch|push)\)$/.exec(line)
    if (match == null) continue
    const [, name, url, direction] = match
    if (name == null || url == null || direction == null) continue
    const remote = remotes.get(name) ?? { name, fetchUrl: '', pushUrl: '' }
    if (direction === 'fetch') remote.fetchUrl = url
    else remote.pushUrl = url
    remotes.set(name, remote)
  }
  return [...remotes.values()]
}

function parseCommits(result: CommandResult | null): GitCommit[] {
  if (result == null) return []
  return result.stdout.toString('utf8').split('\x1e').flatMap((record) => {
    const trimmedRecord = record.replace(/^\n+|\n+$/g, '')
    if (trimmedRecord === '') return []
    const [oid, shortOid, parents = '', authorName, authorEmail, authoredAt, subject, decorations = ''] = trimmedRecord.split('\x1f')
    if (oid == null || shortOid == null || authorName == null || authorEmail == null || authoredAt == null || subject == null) return []
    return [{
      oid,
      shortOid,
      parents: parents === '' ? [] : parents.split(' '),
      authorName,
      authorEmail,
      authoredAt,
      subject,
      decorations: decorations === '' ? [] : decorations.split(', ').map((decoration) => decoration.trim())
    }]
  })
}

function parseAheadBehind(result: CommandResult | null): { ahead: number; behind: number } {
  if (result == null) return { ahead: 0, behind: 0 }
  const [aheadText = '0', behindText = '0'] = result.stdout.toString('utf8').trim().split(/\s+/)
  return { ahead: Number(aheadText) || 0, behind: Number(behindText) || 0 }
}

function requirePullRequestNumber(number: number): void {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error('Pull request number must be a positive integer.')
  }
}

export function normalizePullRequestSelector(selector: number | string): string {
  if (typeof selector === 'number') {
    requirePullRequestNumber(selector)
    return String(selector)
  }
  const trimmedSelector = selector.trim()
  const numberMatch = /^#?(\d+)$/.exec(trimmedSelector)
  if (numberMatch != null) {
    const pullRequestNumber = Number(numberMatch[1])
    requirePullRequestNumber(pullRequestNumber)
    return String(pullRequestNumber)
  }
  const pullRequestUrl = normalizeGitHubPullRequestUrl(trimmedSelector)
  if (pullRequestUrl != null) return pullRequestUrl
  throw new Error('Pull request selector must be a positive number or a GitHub pull request URL.')
}

export function githubRepoSlugFromRemoteUrl(url: string): string | null {
  // https://github.com/owner/repo(.git), git@github.com:owner/repo(.git), ssh://git@github.com/owner/repo(.git).
  const match = /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i
    .exec(url.trim())
  if (match == null) return null
  const [, owner, repository] = match
  if (owner == null || repository == null) return null
  return `${owner}/${repository}`.toLowerCase()
}

export interface PullRequestInboxEntry {
  key: PullRequestInboxSectionKey
  pullRequest: unknown
}

type RawPullRequestSummary = Omit<PullRequestSummary, 'checks' | 'mergeable'> & {
  statusCheckRollup?: unknown
  mergeable?: unknown
}

function normalizeCheckToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const token = value.trim().toUpperCase()
  return token === '' ? null : token
}

// `statusCheckRollup` mixes CheckRun entries (status plus conclusion) with StatusContext entries (state).
export function summarizeCheckRollup(value: unknown): PullRequestChecks | null {
  if (!Array.isArray(value)) return null
  const checks = { passing: 0, failing: 0, pending: 0 }
  for (const entry of value) {
    if (typeof entry !== 'object' || entry == null) continue
    const { status, conclusion, state } = entry as Record<string, unknown>
    const statusToken = normalizeCheckToken(status)
    const conclusionToken = normalizeCheckToken(conclusion)
    const stateToken = normalizeCheckToken(state)
    if (statusToken == null && conclusionToken == null && stateToken == null) continue
    // A check run carries no verdict until it completes.
    const verdict = statusToken != null && statusToken !== 'COMPLETED' ? null : conclusionToken ?? stateToken
    if (verdict != null && PASSING_CHECK_RESULTS.has(verdict)) checks.passing += 1
    else if (verdict != null && FAILING_CHECK_RESULTS.has(verdict)) checks.failing += 1
    else checks.pending += 1
  }
  return checks
}

function toPullRequestSummary(value: RawPullRequestSummary): PullRequestSummary {
  const { statusCheckRollup, mergeable, ...pullRequest } = value
  return {
    ...pullRequest,
    checks: summarizeCheckRollup(statusCheckRollup),
    mergeable: typeof mergeable === 'string' ? mergeable : null
  }
}

function parsePullRequestSummaries(result: CommandResult): PullRequestSummary[] {
  const summaries: PullRequestSummary[] = []
  for (const value of parseJson<RawPullRequestSummary[]>(result, 'GitHub CLI')) {
    summaries.push(toPullRequestSummary(value))
  }
  return summaries
}

function toInboxPullRequest(value: unknown): InboxPullRequest | null {
  if (typeof value !== 'object' || value == null) return null
  const { number, title, url, state, isDraft, author, updatedAt } = value as Record<string, unknown>
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) return null
  if (typeof title !== 'string' || typeof state !== 'string' || typeof updatedAt !== 'string') return null
  if (typeof url !== 'string' || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/i.test(url)) return null
  const login = typeof author === 'object' && author != null ? (author as Record<string, unknown>).login : null
  if (typeof login !== 'string' || login === '') return null
  const avatarUrl = typeof author === 'object' && author != null ? (author as Record<string, unknown>).avatarUrl : null
  return {
    number,
    title,
    url,
    state,
    isDraft: isDraft === true,
    author: { login, avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : '' },
    updatedAt
  }
}

// The welcome inbox is not tied to a checkout: one viewer login answers for the
// whole app run, and the search runs against every repository the viewer can see.
let globalViewerLogin: Promise<string> | null = null

async function getGlobalViewerLogin(ghExecutable: string): Promise<string> {
  globalViewerLogin ??= runGitHubReadCommand(
    ghExecutable,
    ['api', 'user', '--jq', '.login'],
    homedir()
  ).then((result) => {
    const login = result.stdout.toString('utf8').trim()
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(login)) {
      throw new Error('GitHub returned an invalid viewer login.')
    }
    return login
  }, (error: unknown) => {
    globalViewerLogin = null
    throw error
  })
  return globalViewerLogin
}

/** One search string per section — every section shares the same repo scope. */
export function pullRequestInboxVariables(base: string, login: string): Record<string, string> {
  const variables: Record<string, string> = {}
  for (const { alias, qualifier } of PULL_REQUEST_INBOX_SECTIONS) {
    variables[alias] = `${base} ${qualifier}:${login}`
  }
  return variables
}

/** The sessionless welcome-screen inbox: what needs the viewer across all repositories. */
export async function loadGlobalPullRequestInbox(repos: readonly string[] = []): Promise<PullRequestInboxSnapshot> {
  try {
    const ghExecutable = await getGhExecutable()
    const login = await getGlobalViewerLogin(ghExecutable)
    const scope = inboxRepoScope(repos)
    const variables = pullRequestInboxVariables(`is:pr is:open${scope === '' ? '' : ` ${scope}`}`, login)
    const result = await runCommand(
      ghExecutable,
      ['api', 'graphql', '--input', '-'],
      homedir(),
      [],
      JSON.stringify({ query: PULL_REQUEST_INBOX_QUERY, variables })
    )
    const entries = parsePullRequestInboxResponse(parseJson<unknown>(result, 'GitHub CLI'))
    return { available: true, message: null, sections: sectionPullRequestInbox(entries) }
  } catch (error) {
    return { available: false, message: gitHubIntegrationErrorMessage(error), sections: [] }
  }
}

export function sectionPullRequestInbox(entries: readonly PullRequestInboxEntry[]): PullRequestInboxSection[] {
  const claimedUrls = new Set<string>()
  return PULL_REQUEST_INBOX_SECTIONS.map(({ key, title }) => {
    const pullRequests: InboxPullRequest[] = []
    for (const entry of entries) {
      if (entry.key !== key) continue
      const pullRequest = toInboxPullRequest(entry.pullRequest)
      if (pullRequest == null) continue
      const identity = pullRequest.url.toLowerCase()
      if (claimedUrls.has(identity)) continue
      claimedUrls.add(identity)
      pullRequests.push(pullRequest)
    }
    return { key, title, pullRequests }
  })
}

function readString(value: unknown, maxLength = MAX_REMOTE_THREAD_BODY_LENGTH): string {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

function parseRemoteReviewComments(value: unknown): RemoteReviewComment[] {
  const nodes = (value as { nodes?: unknown })?.nodes
  if (!Array.isArray(nodes)) return []
  const comments: RemoteReviewComment[] = []
  for (const node of nodes) {
    if (typeof node !== 'object' || node == null) continue
    const { id, body, author, createdAt } = node as Record<string, unknown>
    if (typeof id !== 'string' || id === '') continue
    comments.push({
      id,
      body: readString(body),
      authorLogin: readString((author as { login?: unknown } | null)?.login, 256),
      authorAvatarUrl: readString((author as { avatarUrl?: unknown } | null)?.avatarUrl, 2048),
      createdAt: readString(createdAt, 64)
    })
  }
  return comments
}

/** GitHub hangs `diffHunk` off each comment; the thread's hunk is the first one's. */
function firstComment(value: unknown): Record<string, unknown> | null {
  const nodes = (value as { nodes?: unknown })?.nodes
  if (!Array.isArray(nodes)) return null
  const first = nodes.find((node) => typeof node === 'object' && node != null)
  return (first as Record<string, unknown> | undefined) ?? null
}

// GitHub reports a thread's position on the diff side it was left on; anything
// unexpected is treated as a right-side (addition) comment.
export function parsePullRequestConversation(value: unknown): Omit<PullRequestConversation, 'available' | 'message'> {
  const pullRequest = (value as { data?: { repository?: { pullRequest?: unknown } } })?.data?.repository?.pullRequest
  if (typeof pullRequest !== 'object' || pullRequest == null) {
    return { body: '', headOid: '', threads: [], reviews: [] }
  }
  const { body, headRefOid, reviewThreads, reviews } = pullRequest as Record<string, unknown>
  const threadNodes = (reviewThreads as { nodes?: unknown })?.nodes
  const threads: RemoteReviewThread[] = []
  if (Array.isArray(threadNodes)) {
    for (const node of threadNodes) {
      if (typeof node !== 'object' || node == null) continue
      const thread = node as Record<string, unknown>
      const path = readString(thread.path, 4096)
      if (typeof thread.id !== 'string' || thread.id === '' || path === '') continue
      threads.push({
        id: thread.id,
        path,
        line: typeof thread.line === 'number' ? thread.line : null,
        startLine: typeof thread.startLine === 'number' ? thread.startLine : null,
        originalLine: typeof thread.originalLine === 'number' ? thread.originalLine : null,
        originalStartLine: typeof thread.originalStartLine === 'number' ? thread.originalStartLine : null,
        // Only the first comment carries the hunk the thread was opened on.
        diffHunk: readString(firstComment(thread.comments)?.diffHunk, 8192),
        side: thread.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
        resolved: thread.isResolved === true,
        outdated: thread.isOutdated === true,
        comments: parseRemoteReviewComments(thread.comments)
      })
    }
  }
  const reviewNodes = (reviews as { nodes?: unknown })?.nodes
  const summaries: RemoteReviewSummary[] = []
  if (Array.isArray(reviewNodes)) {
    for (const node of reviewNodes) {
      if (typeof node !== 'object' || node == null) continue
      const review = node as Record<string, unknown>
      if (typeof review.id !== 'string' || review.id === '') continue
      summaries.push({
        id: review.id,
        state: readString(review.state, 64),
        body: readString(review.body),
        authorLogin: readString((review.author as { login?: unknown } | null)?.login, 256),
        authorAvatarUrl: readString((review.author as { avatarUrl?: unknown } | null)?.avatarUrl, 2048),
        submittedAt: typeof review.submittedAt === 'string' ? review.submittedAt.slice(0, 64) : null
      })
    }
  }
  return { body: readString(body), headOid: readString(headRefOid, 64), threads, reviews: summaries }
}

export function pullRequestTargetsRemotes(remotes: readonly GitRemote[], pullRequestUrl: string): boolean {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/\d+(?:\/.*)?$/i
    .exec(pullRequestUrl.trim())
  if (match == null) return false
  const [, owner, repository] = match
  if (owner == null || repository == null) return false
  const targetSlug = `${owner}/${repository}`.toLowerCase()
  return remotes.some((remote) => [remote.fetchUrl, remote.pushUrl]
    .some((remoteUrl) => githubRepoSlugFromRemoteUrl(remoteUrl) === targetSlug))
}

function validatePullRequestTarget(url: string, number: number): void {
  requirePullRequestNumber(number)
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?:\/.*)?$/i.exec(url)
  if (match == null || Number(match[3]) !== number) {
    throw new Error('GitHub returned an invalid pull request URL.')
  }
}

function validatePullRequestReviewComments(value: unknown): PullRequestReviewComment[] {
  if (!Array.isArray(value)) throw new Error('Pull request review comments must be a list.')
  if (value.length > MAX_PULL_REQUEST_REVIEW_COMMENTS) {
    throw new Error(`A review can contain at most ${MAX_PULL_REQUEST_REVIEW_COMMENTS} inline comments.`)
  }

  return value.map((comment, index) => {
    if (comment == null || typeof comment !== 'object') {
      throw new Error(`Inline comment ${index + 1} is invalid.`)
    }
    const candidate = comment as Partial<PullRequestReviewComment>
    const path = typeof candidate.path === 'string' ? candidate.path.trim() : ''
    const body = typeof candidate.body === 'string' ? candidate.body.trim() : ''
    const safePath = path !== ''
      && !path.startsWith('/')
      && !path.includes('\\')
      && !path.split('/').includes('..')
      && !path.includes('\0')
    if (!safePath) throw new Error(`Inline comment ${index + 1} has an invalid path.`)
    if (body === '' || body.length > MAX_REVIEW_BODY_LENGTH) {
      throw new Error(`Inline comment ${index + 1} has an invalid body.`)
    }
    if (!Number.isSafeInteger(candidate.line) || candidate.line! < 1) {
      throw new Error(`Inline comment ${index + 1} has an invalid line.`)
    }
    if (candidate.side !== 'LEFT' && candidate.side !== 'RIGHT') {
      throw new Error(`Inline comment ${index + 1} has an invalid side.`)
    }
    if (candidate.startLine != null) {
      if (!Number.isSafeInteger(candidate.startLine) || candidate.startLine < 1) {
        throw new Error(`Inline comment ${index + 1} has an invalid start line.`)
      }
      if (candidate.startSide !== 'LEFT' && candidate.startSide !== 'RIGHT') {
        throw new Error(`Inline comment ${index + 1} has an invalid start side.`)
      }
    } else if (candidate.startSide != null) {
      throw new Error(`Inline comment ${index + 1} has a start side without a start line.`)
    }
    return {
      path,
      body,
      line: candidate.line!,
      side: candidate.side,
      ...(candidate.startLine == null
        ? {}
        : { startLine: candidate.startLine, startSide: candidate.startSide })
    }
  })
}

export function createPullRequestReviewPayload(
  commitIdValue: unknown,
  reviewEvent: string,
  bodyValue: unknown,
  commentsValue: unknown
): Record<string, unknown> {
  if (typeof commitIdValue !== 'string' || !/^[0-9a-f]{40}$/i.test(commitIdValue)) {
    throw new Error('The pull request commit ID is invalid.')
  }
  const events: PullRequestReviewEvent[] = ['approve', 'comment', 'request-changes']
  if (!events.includes(reviewEvent as PullRequestReviewEvent)) {
    throw new Error('Unknown pull request review action.')
  }
  if (typeof bodyValue !== 'string') throw new Error('Pull request review body must be text.')
  const body = bodyValue.trim()
  if (body.length > MAX_REVIEW_BODY_LENGTH) throw new Error('Pull request review body is too long.')
  const comments = validatePullRequestReviewComments(commentsValue)
  if (reviewEvent !== 'approve' && body === '' && comments.length === 0) {
    throw new Error('Add a review summary or at least one inline comment for this action.')
  }
  return {
    commitOID: commitIdValue,
    event: reviewEvent === 'request-changes' ? 'REQUEST_CHANGES' : reviewEvent.toUpperCase(),
    ...(body === '' ? {} : { body }),
    threads: comments.map((comment) => ({
      path: comment.path,
      body: comment.body,
      line: comment.line,
      side: comment.side,
      ...(comment.startLine == null
        ? {}
        : { startLine: comment.startLine, startSide: comment.startSide })
    }))
  }
}

interface ActiveContentSearch {
  // Two: the repository-wide pass and, when the reader has a file open, that file's
  // own wider pass. Cancelling the search has to end both.
  children: Set<ReturnType<typeof spawn>>
  cancelled: boolean
  startedAt: number
}

export interface ContentSearchMetrics {
  spawned: number
  cancelled: number
  completed: number
  durationsMs: number[]
}

export class PullRequestReviewCache {
  #directory: string
  #pendingPatchWrites = new Map<string, number>()

  constructor(directory: string) {
    this.#directory = directory
  }

  // Hashed rather than composed from the slug: a pull request URL is remote input
  // and must never decide a path segment.
  #entryPaths(url: string, identity: PullRequestSnapshotIdentity): { metadata: string; patch: string } {
    const base = resolve(this.#directory, createCacheKey(url, JSON.stringify(identity)))
    return { metadata: `${base}.json`, patch: `${base}.patch` }
  }

  // The reader and the writer reach the pointer from different spellings of the
  // same pull request — a pasted URL with a `#files` fragment on one side, the
  // canonical URL GitHub reports on the other — so both are normalized first.
  #indexPath(url: string): string | null {
    const normalized = normalizeGitHubPullRequestUrl(url)
    if (normalized == null) return null
    return resolve(this.#directory, `${createCacheKey('index', normalized)}${PULL_REQUEST_INDEX_SUFFIX}`)
  }

  #beginPatchCommit(path: string): void {
    this.#pendingPatchWrites.set(path, (this.#pendingPatchWrites.get(path) ?? 0) + 1)
  }

  #endPatchCommit(path: string): void {
    const remaining = (this.#pendingPatchWrites.get(path) ?? 1) - 1
    if (remaining === 0) this.#pendingPatchWrites.delete(path)
    else this.#pendingPatchWrites.set(path, remaining)
  }

  async read(
    url: string,
    expected: PullRequestSnapshotIdentity | string
  ): Promise<CachedPullRequestReview | null> {
    const identity = typeof expected === 'string'
      ? (await this.readIndex(url))?.snapshotIdentity ?? null
      : expected
    if (identity == null || (typeof expected === 'string' && identity.headOid !== expected)) return null
    if (identity.headOid === '' || identity.baseOid === '') return null
    try {
      const paths = this.#entryPaths(url, identity)
      const entry = JSON.parse(await readFile(paths.metadata, 'utf8')) as CachedPullRequestReviewMetadata
      if (
        entry.version !== PULL_REQUEST_CACHE_VERSION
        || !sameSnapshotIdentity(entry.snapshotIdentity, identity)
        || !Array.isArray(entry.files)
        || !Array.isArray(entry.omittedFiles)
        || !Number.isSafeInteger(entry.patchLength)
        || entry.patchLength < 0
      ) return null
      const patch = await readFile(paths.patch, 'utf8')
      if (patch.length !== entry.patchLength) return null
      return {
        version: entry.version,
        snapshotIdentity: entry.snapshotIdentity,
        files: entry.files,
        patch,
        omittedFiles: entry.omittedFiles
      }
    } catch {
      // A missing, truncated or half-written entry is simply a miss.
      return null
    }
  }

  /**
   * The pointer from a pull request URL to the diff last cached for it. A stale
   * pointer costs nothing: the entry read it leads to simply misses and the
   * caller falls back to `gh`.
   */
  async readIndex(url: string): Promise<CachedPullRequestIndex | null> {
    const path = this.#indexPath(url)
    if (path == null) return null
    try {
      const entry = JSON.parse(await readFile(path, 'utf8')) as CachedPullRequestIndex
      if (
        entry.version !== PULL_REQUEST_INDEX_VERSION
        || typeof entry.url !== 'string'
        || typeof entry.headRefOid !== 'string'
        || entry.headRefOid === ''
        || typeof entry.baseRefOid !== 'string'
        || typeof entry.snapshotIdentity !== 'object'
        || entry.snapshotIdentity == null
        || entry.snapshotIdentity.formatEpoch !== PULL_REQUEST_SNAPSHOT_FORMAT_EPOCH
        || entry.snapshotIdentity.headOid !== entry.headRefOid
        || entry.snapshotIdentity.baseOid !== entry.baseRefOid
        || typeof entry.viewerCanSubmitDecision !== 'boolean'
        || typeof entry.summary !== 'object'
        || entry.summary == null
        || typeof entry.summary.number !== 'number'
        || typeof entry.summary.url !== 'string'
      ) return null
      return entry
    } catch {
      return null
    }
  }

  async #writeIndex(url: string, headRefOid: string, review: PullRequestReview): Promise<void> {
    const path = this.#indexPath(url)
    if (path == null) return
    const entry: CachedPullRequestIndex = {
      version: PULL_REQUEST_INDEX_VERSION,
      url,
      headRefOid,
      baseRefOid: review.baseOid,
      snapshotIdentity: pullRequestSnapshotIdentity(review),
      viewerCanSubmitDecision: review.viewerCanSubmitDecision,
      summary: review.pullRequest,
      writtenAt: Date.now()
    }
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, JSON.stringify(entry), 'utf8')
      await rename(temporaryPath, path)
    } catch {
      await unlink(temporaryPath).catch(() => {})
    }
  }

  async write(url: string, headRefOid: string, review: PullRequestReview): Promise<void> {
    if (headRefOid === '' || headRefOid !== review.headOid || review.files.length === 0) return
    const snapshotIdentity = pullRequestSnapshotIdentity(review)
    const entry: CachedPullRequestReviewMetadata = {
      version: PULL_REQUEST_CACHE_VERSION,
      snapshotIdentity,
      files: review.files,
      omittedFiles: review.omittedFiles,
      patchLength: review.patch.length
    }
    const paths = this.#entryPaths(url, snapshotIdentity)
    const writeId = randomUUID()
    const temporaryPatchPath = `${paths.patch}.${writeId}.tmp`
    const temporaryMetadataPath = `${paths.metadata}.${writeId}.tmp`
    let committingPatch = false
    try {
      await mkdir(this.#directory, { recursive: true })
      await writeFile(temporaryPatchPath, review.patch, 'utf8')
      committingPatch = true
      this.#beginPatchCommit(paths.patch)
      await rename(temporaryPatchPath, paths.patch)
      await writeFile(temporaryMetadataPath, JSON.stringify(entry), 'utf8')
      await rename(temporaryMetadataPath, paths.metadata)
      await this.#writeIndex(url, headRefOid, review)
      await this.sweep()
    } catch {
      // The cache is an optimisation; failing to write it must never fail a review.
      await Promise.all([
        unlink(temporaryPatchPath).catch(() => {}),
        unlink(temporaryMetadataPath).catch(() => {})
      ])
    } finally {
      if (committingPatch) this.#endPatchCommit(paths.patch)
    }
  }

  // Pointers are tiny and self-healing, so they are capped by count and mtime
  // rather than reconciled against the entries they name.
  async #sweepIndexes(names: readonly string[]): Promise<void> {
    const indexNames = names.filter((name) => name.endsWith(PULL_REQUEST_INDEX_SUFFIX))
    if (indexNames.length <= MAX_PULL_REQUEST_CACHE_ENTRIES) return
    const entries = await mapWithConcurrency(indexNames, MAX_PATCH_COMMAND_CONCURRENCY, async (name) => {
      const path = resolve(this.#directory, name)
      const info = await stat(path).catch(() => null)
      return info == null ? null : { path, modifiedAt: info.mtimeMs }
    })
    const present = entries.filter((entry) => entry != null)
    present.sort((left, right) => right.modifiedAt - left.modifiedAt)
    await Promise.all(present
      .slice(MAX_PULL_REQUEST_CACHE_ENTRIES)
      .map((entry) => unlink(entry.path).catch(() => {})))
  }

  async sweep(): Promise<void> {
    const names = await readdir(this.#directory).catch(() => [] as string[])
    await this.#sweepIndexes(names)
    const metadataNames = new Set(names.filter((name) =>
      name.endsWith('.json') && !name.endsWith(PULL_REQUEST_INDEX_SUFFIX)))
    const entries = await mapWithConcurrency(
      [...metadataNames],
      MAX_PATCH_COMMAND_CONCURRENCY,
      async (name) => {
        const metadataPath = resolve(this.#directory, name)
        const patchPath = resolve(this.#directory, `${name.slice(0, -'.json'.length)}.patch`)
        try {
          const [metadata, patch] = await Promise.all([stat(metadataPath), stat(patchPath)])
          return {
            metadataPath,
            patchPath,
            bytes: metadata.size + patch.size,
            modifiedAt: metadata.mtimeMs
          }
        } catch {
          await Promise.all([
            unlink(metadataPath).catch(() => {}),
            unlink(patchPath).catch(() => {})
          ])
          return null
        }
      }
    )
    const present = entries.filter((entry) => entry != null)
    present.sort((left, right) => right.modifiedAt - left.modifiedAt)
    let bytes = 0
    const expired = present.filter((entry, index) => {
      bytes += entry.bytes
      return index >= MAX_PULL_REQUEST_CACHE_ENTRIES || bytes > MAX_PULL_REQUEST_CACHE_BYTES
    })
    const orphanPatches: string[] = []
    for (const name of names) {
      if (!name.endsWith('.patch')) continue
      if (metadataNames.has(`${name.slice(0, -'.patch'.length)}.json`)) continue
      const path = resolve(this.#directory, name)
      if (!this.#pendingPatchWrites.has(path)) orphanPatches.push(path)
    }
    await Promise.all([
      ...orphanPatches.map((path) => unlink(path).catch(() => {})),
      ...expired.flatMap((entry) => [
        unlink(entry.metadataPath).catch(() => {}),
        unlink(entry.patchPath).catch(() => {})
      ])
    ])
  }
}

type LocalReviewListener = (progress: LocalReviewProgress) => void

/**
 * A loaded local review whose patch is still in pages. Callers that were streamed
 * those pages never need them joined, so the join waits until one does.
 */
interface LocalReviewResult {
  /** Everything but the patch, which is left empty. */
  review: LocalBranchReview
  patchParts: readonly string[]
}

let lastPathsRevision = 0

function nextPathsRevision(): number {
  lastPathsRevision += 1
  return lastPathsRevision
}

function joinedPatchLength(parts: readonly string[]): number {
  return parts.reduce((total, part) => total + part.length, Math.max(0, parts.length - 1))
}

export class RepositoryService {
  #root: string | null = null
  #kind: RepositorySnapshot['kind'] = 'folder'
  #snapshot: RepositorySnapshot | null = null
  #snapshotRevision = 0
  #pathSet = new Set<string>()
  #statusByPath = new Map<string, RepositoryStatusEntry>()
  #headFileCache = new Map<string, { promise: Promise<ReadVersion | null>; bytes: number }>()
  #headFileCacheBytes = 0
  #objectReader: GitObjectReader | null = null
  #trackedPathsCache: {
    buffer: Buffer
    untrackedPaths: string[]
    // Held by reference: the listing owns the array and never mutates it, so an
    // unchanged ignored set is recognised without rescanning it.
    ignoredPaths: readonly string[]
    /** `buffer` split, deduplicated and sorted: the costly part of a merge. */
    trackedPaths: string[]
    paths: string[]
  } | null = null
  #ignoredPaths: string[] = []
  #ignoredRun: AbortController | null = null
  #refreshRun: Promise<RepositorySnapshot> | null = null
  #refreshGeneration = 0
  // Counts writes to the working tree or the index, so a refresh that started
  // before one can never be handed to a caller that asked after it.
  #mutation = 0
  #refreshMutation = 0
  #folderPathsCache: { buffer: Buffer; paths: string[] } | null = null
  #workingFileCache = new Map<string, { read: WorkingFileRead; bytes: number }>()
  #workingFileCacheBytes = 0
  #pendingComparisons = new Map<string, Promise<FileComparison>>()
  #revisionFetches = new Map<string, Promise<boolean>>()
  #pendingWorkingTreePatches = new Map<string, ReviewFlight<WorkingTreePatch, WorkingTreePatch[]>>()
  #pendingLocalReviews = new Map<string, ReviewFlight<LocalReviewProgress, LocalReviewResult>>()
  #selfWriteObserver: ((path: string, stillOurs?: () => Promise<boolean>) => void) | null = null
  #indexWritesInFlight = 0
  #indexWriteHeartbeat: ReturnType<typeof setInterval> | null = null
  #snapshotObserver: ((snapshot: RepositorySnapshot) => void) | null = null
  #checkFieldsSupported = true
  // requestId -> the flight it is waiting on. Several requests share one flight, so
  // cancelling one of them must not abort the fetch the others are still reading.
  #reviewRequests = new Map<string, PullRequestReviewFlight>()
  #reviewFlights = new Map<string, PullRequestReviewFlight>()
  #reviewsRequiringRefresh = new Set<string>()
  #pullRequestCache: PullRequestReviewCache | null = null
  #pullRequestCacheDirectory: string | null = null
  #activeSearch: ActiveContentSearch | null = null
  #contentSearchMetrics: ContentSearchMetrics = { spawned: 0, cancelled: 0, completed: 0, durationsMs: [] }
  #githubViewerLogin: string | null = null
  #githubViewerResolvedAt = 0
  #githubAccountId: string | null = null
  #githubAccountResolvedAt = 0
  #githubAuthEpoch = 0
  // undefined means "not resolved yet"; null means "resolved, no GitHub remote".
  #githubSlug: string | null | undefined = undefined
  #remotes: Promise<GitRemote[]> | undefined
  // A pull request's owner, repository, and number never change, so the identity
  // lookup is resolved once instead of on every conversation poll.
  #pullRequestIdentities = new Map<string, { owner: string; name: string; number: number }>()
  #rememberedReviews = new RememberedReviewStore()

  getSessionSnapshot(): RepositorySnapshot | null {
    return this.#snapshot
  }

  // The watcher needs to know a write is ours before it lands, or it refreshes
  // the whole tree for a file the app just wrote and already has the contents of.
  setSelfWriteObserver(observe: ((path: string, stillOurs?: () => Promise<boolean>) => void) | null): void {
    this.#selfWriteObserver = observe
  }

  // Announces a snapshot the service produced on its own, outside a refresh the
  // caller is awaiting — today only the gitignored set arriving after its
  // deadline. Refresh and hydrate results are published by their caller.
  setSnapshotObserver(observe: ((snapshot: RepositorySnapshot) => void) | null): void {
    this.#snapshotObserver = observe
  }

  // Passed in from the main entry point so this module keeps no Electron import.
  setPullRequestCacheDirectory(directory: string | null): void {
    this.#pullRequestCacheDirectory = directory
    this.#pullRequestCache = directory == null ? null : new PullRequestReviewCache(directory)
  }

  async prepareAgentReview(subject: AgentRequestSubject): Promise<string> {
    const { remembered, cached } = await this.#lookupAgentReview(subject)
    return prepareAgentReviewContext({ snapshot: this.#snapshot, subject, remembered, cached })
  }

  async #lookupAgentReview(subject: AgentRequestSubject): Promise<{
    remembered: RememberedAgentReview | null
    cached: (CachedPullRequestReview & { headRefOid: string }) | null
  }> {
    const remembered = this.#findRememberedReview(subject)
    // A review remembered without its patch was too big to keep one in memory, so
    // the copy on disk is read for it exactly as for a review never remembered.
    const needsPatch = remembered == null || remembered.patch === ''
    const index = needsPatch && subject.pullRequestUrl != null && subject.headOid != null
      ? await this.#pullRequestCache?.readIndex(subject.pullRequestUrl) ?? null
      : null
    const cached = index != null && index.headRefOid === subject.headOid
      ? await this.#pullRequestCache?.read(index.url, index.snapshotIdentity) ?? null
      : null
    return {
      remembered,
      cached: cached == null ? null : { ...cached, headRefOid: cached.snapshotIdentity.headOid }
    }
  }

  /**
   * The whole patch a review tab shows, for the guide: the working tree's
   * changes against HEAD, or the remembered (or cached) patch of a pull request,
   * branch comparison or commit. Null when there is nothing to describe.
   */
  async resolveReviewPatch(subject: AgentRequestSubject): Promise<{ patch: string; title: string | null } | null> {
    if (subject.source === 'workingTree') {
      const snapshot = this.#snapshot
      if (snapshot == null || snapshot.kind !== 'git' || snapshot.statuses.length === 0) return null
      const paths = snapshot.statuses.map((status) => status.path)
      const { patch } = await this.getWorkingTreePatch(paths)
      return patch.trim() === '' ? null : { patch, title: null }
    }
    const { remembered, cached } = await this.#lookupAgentReview(subject)
    const review = resolveRememberedReview(remembered, cached, subject)
    if (review == null || review.patch.trim() === '') return null
    return { patch: review.patch, title: review.title }
  }

  #rememberAgentReview(review: PullRequestReview | LocalBranchReview): void {
    if (review.patch === '' && review.files.length === 0) return
    this.#rememberedReviews.remember(rememberedAgentReviewFrom(review))
  }

  #findRememberedReview(subject: AgentRequestSubject): RememberedAgentReview | null {
    if (subject.baseOid == null || subject.headOid == null) return null
    return this.#rememberedReviews.get(reviewKey(subject.baseOid, subject.headOid))
  }

  getContentSearchMetricsForTests(): ContentSearchMetrics {
    return {
      ...this.#contentSearchMetrics,
      durationsMs: [...this.#contentSearchMetrics.durationsMs]
    }
  }

  getRememberedReviewStatsForTests(): { entries: number; bytes: number } {
    return { entries: this.#rememberedReviews.size, bytes: this.#rememberedReviews.bytes }
  }

  resetContentSearchMetricsForTests(): void {
    this.#contentSearchMetrics = { spawned: 0, cancelled: 0, completed: 0, durationsMs: [] }
  }

  getHeadCacheStatsForTests(): {
    entries: number
    bytes: number
    workingEntries: number
    workingBytes: number
    objectReaderSpawns: number
  } {
    return {
      entries: this.#headFileCache.size,
      bytes: this.#headFileCacheBytes,
      workingEntries: this.#workingFileCache.size,
      workingBytes: this.#workingFileCacheBytes,
      objectReaderSpawns: this.#objectReader?.spawnCountForTests ?? 0
    }
  }

  dispose(): void {
    this.#cancelActiveSearch()
    this.cancelPullRequestReview()
    this.#clearHeadFileCache()
    this.#workingFileCache.clear()
    this.#workingFileCacheBytes = 0
    this.#pendingComparisons.clear()
    for (const flight of this.#pendingWorkingTreePatches.values()) flight.abort.abort()
    this.#pendingWorkingTreePatches.clear()
    for (const flight of this.#pendingLocalReviews.values()) flight.abort.abort()
    this.#pendingLocalReviews.clear()
    this.#pullRequestIdentities.clear()
    // `open()` reuses this instance for whatever folder comes next, and a disposed
    // session is kept around only to be reopened, so neither needs these patches.
    this.#rememberedReviews.clear()
    this.#ignoredRun?.abort()
    this.#ignoredRun = null
    this.#ignoredPaths = []
    this.#refreshRun = null
    this.#refreshGeneration += 1
    this.#mutation = 0
    this.#refreshMutation = 0
    this.#trackedPathsCache = null
    this.#folderPathsCache = null
    this.#githubSlug = undefined
    this.#remotes = undefined
    this.#githubViewerLogin = null
    this.#objectReader?.dispose()
    this.#objectReader = null
    this.#root = null
    this.#kind = 'folder'
    this.#snapshot = null
    this.#snapshotRevision = 0
    this.#pathSet.clear()
    this.#statusByPath.clear()
  }

  trimCaches(floorBytes: number): void {
    const targetBytes = Math.max(0, Math.floor(floorBytes))
    while (this.#headFileCacheBytes > targetBytes) {
      const oldestObject = this.#headFileCache.keys().next().value
      if (oldestObject == null) break
      this.#deleteHeadCacheEntry(oldestObject)
    }
    while (this.#workingFileCacheBytes > targetBytes) {
      const oldestPath = this.#workingFileCache.keys().next().value
      if (oldestPath == null) break
      this.#deleteWorkingCacheEntry(oldestPath)
    }
  }

  /**
   * `resolved` says the caller has already run the path through `realpath`, so an
   * open resolves it once for the whole stack instead of once per layer.
   */
  async open(folderPath: string, resolved = false): Promise<RepositorySnapshot> {
    const selectedRoot = resolved ? folderPath : await realpath(folderPath)
    const rootResult = await runCommand('git', [
      '-C', selectedRoot, 'rev-parse', '--show-toplevel'
    ]).catch(() => null)

    this.dispose()
    this.#kind = rootResult == null ? 'folder' : 'git'
    this.#root = rootResult?.stdout.toString('utf8').trim() || selectedRoot
    const listing = listRootSnapshot(this.#root)
    return this.hydrate({
      ...listing,
      root: this.#root,
      kind: this.#kind
    })
  }

  /** Paint a remembered tree without waiting on git status. */
  hydrate(snapshot: RepositorySnapshot): RepositorySnapshot {
    this.#kind = snapshot.kind
    this.#root = snapshot.root
    this.#setSnapshot(snapshot)
    return snapshot
  }

  /**
   * Restore, the folder-open handler, the watcher and every mutation ask for a
   * refresh, often in the same tick. Two runs against the same index cost twice
   * as much and answer the same thing, so callers that want the state a run is
   * already fetching share it; a caller that wants state written since then gets
   * a fresh run chained behind it rather than racing it.
   */
  refresh(): Promise<RepositorySnapshot> {
    const pending = this.#refreshRun
    if (pending != null && this.#refreshMutation === this.#mutation) return pending
    // Starting late is a feature: a queued run reads whatever was written while
    // it waited its turn.
    const start = (): Promise<RepositorySnapshot> => {
      this.#refreshMutation = this.#mutation
      return this.#refreshSnapshot()
    }
    this.#refreshGeneration += 1
    const generation = this.#refreshGeneration
    // Released as part of settling, not in a `finally` chained after it: a caller
    // that asks again the microtask after its own `await` must get a new cycle,
    // not the run it just consumed.
    const release = (): void => {
      if (this.#refreshGeneration === generation) this.#refreshRun = null
    }
    const run = (pending == null ? start() : pending.then(ignoreSettled, ignoreSettled).then(start))
      .then(
        (snapshot) => {
          release()
          return snapshot
        },
        (error: unknown) => {
          release()
          throw error
        }
      )
    this.#refreshRun = run
    this.#refreshMutation = this.#mutation
    return run
  }

  /**
   * The watcher reports writes nobody here made, so a run already in flight may
   * have read the tree before the change landed. Counting the tick as a mutation
   * chains a fresh cycle behind that run instead of handing back its stale
   * answer, while the restore/open/handler storm still collapses into one run.
   */
  refreshAfterExternalChange(): Promise<RepositorySnapshot> {
    this.#mutation += 1
    return this.refresh()
  }

  async #refreshSnapshot(): Promise<RepositorySnapshot> {
    const root = this.#requireRoot()
    if (this.#kind === 'folder') return this.#refreshFolder(root)

    // Two parallel spawns on the critical path: `status --porcelain=v2 --branch`
    // reports the branch, the HEAD oid and the untracked set; `ls-files --cached`
    // lists tracked files. The gitignored listing runs alongside them but only
    // joins this snapshot if it beats its deadline.
    this.#selfWriteObserver?.(GIT_INDEX_PATH)
    const ignoredListing = this.#startIgnoredListing()
    const [trackedResult, statusResult, settledIgnoredPaths] = await Promise.all([
      this.#git(['ls-files', '--cached', '-z']),
      this.#git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
      ignoredListing
    ])
    // Re-armed on the way out so the event that lands after the commands finish
    // is still inside the window, however long they took.
    this.#selfWriteObserver?.(GIT_INDEX_PATH)

    const status = parsePorcelainV2Status(statusResult.stdout)
    const ignoredPaths = settledIgnoredPaths ?? this.#ignoredPaths
    const head = status.head
    const branch = status.branch || head?.slice(0, 8) || 'No commits'
    const snapshot: RepositorySnapshot = {
      root,
      name: basename(root),
      kind: 'git',
      branch,
      head,
      paths: this.#visiblePaths(trackedResult.stdout, status.untrackedPaths, ignoredPaths),
      statuses: status.statuses.filter((entry) => entry.status !== 'untracked' || !isExcludedPath(entry.path)),
      stage: 'live'
    }

    this.#setSnapshot(snapshot)
    return snapshot
  }

  /**
   * Starts (or restarts) the gitignored listing and resolves with its paths only
   * if they land inside `IGNORED_LISTING_DEADLINE_MS`. A listing that misses the
   * deadline keeps running and merges into the published snapshot when it lands,
   * so a slow ignored walk never holds up the branch and the statuses.
   */
  #startIgnoredListing(): Promise<string[] | null> {
    this.#ignoredRun?.abort()
    const abort = new AbortController()
    // Kept past the listing's own resolution: it is the run's identity, and a set
    // that lands after a newer refresh replaced it must be recognised as stale.
    this.#ignoredRun = abort
    const timeout = setTimeout(() => abort.abort(), IGNORED_LISTING_TIMEOUT_MS)
    timeout.unref?.()
    // Nobody is waiting on the ignored set: it misses the snapshot deadline on a
    // large repository anyway, so it must never delay the status the user is
    // watching for.
    const listing = listIgnoredPaths((args, signal) => this.#git(args, signal, 'background'), {
      root: this.#requireRoot(),
      excludedDirectories: EXCLUDED_DIRECTORY_SET,
      excludedExtensions: EXCLUDED_IGNORED_EXTENSIONS,
      maxPaths: MAX_CACHED_PATHS,
      signal: abort.signal
    }).then((paths) => {
      if (this.#ignoredRun === abort) this.#ignoredPaths = paths
      return paths
    }).finally(() => {
      clearTimeout(timeout)
    })
    return withIgnoredListingDeadline(
      listing,
      IGNORED_LISTING_DEADLINE_MS,
      abort,
      (paths, run) => this.#mergeIgnoredPaths(paths, run)
    )
  }

  // A late ignored set only adds paths to the snapshot the refresh already
  // published, so it is folded into that exact snapshot and announced on its own
  // rather than costing another git cycle. Aborting a walk only takes effect on
  // its next directory, so a superseded run can still resolve with a set the
  // refresh that replaced it has already moved past; its run identity is the only
  // reliable way to tell.
  #mergeIgnoredPaths(ignoredPaths: string[], run: AbortController | null): void {
    if (this.#ignoredRun !== run) return
    const snapshot = this.#snapshot
    const cached = this.#trackedPathsCache
    if (snapshot == null || cached == null || snapshot.paths !== cached.paths) return
    const paths = this.#visiblePaths(cached.buffer, cached.untrackedPaths, ignoredPaths)
    if (paths === snapshot.paths) return
    const merged = { ...snapshot, paths }
    this.#setSnapshot(merged)
    this.#snapshotObserver?.(merged)
  }

  // The late merge only runs when a listing misses its 400 ms deadline and a
  // newer refresh replaced it in the microseconds before it resolved: two real
  // git walks cannot be lined up that way from a test, so the callback is driven
  // directly here. The listing itself is covered by `ignoredListing.test.ts`.
  mergeIgnoredPathsForTests(ignoredPaths: string[], run: 'current' | 'superseded'): void {
    this.#mergeIgnoredPaths(ignoredPaths, run === 'current' ? this.#ignoredRun : new AbortController())
  }

  // Editing a file leaves both lists byte-for-byte identical, which is the
  // common watcher tick. Re-splitting, re-filtering and re-sorting 100k paths for
  // that cost ~120 ms of blocked main process per tick. Cache repositories with
  // untracked files too; otherwise one draft file disabled the fast path.
  #visiblePaths(
    trackedBuffer: Buffer,
    untrackedPaths: readonly string[],
    ignoredPaths: readonly string[]
  ): string[] {
    const cached = this.#trackedPathsCache
    if (
      cached != null
      && cached.buffer.equals(trackedBuffer)
      && sameStringList(cached.untrackedPaths, untrackedPaths)
      && (cached.ignoredPaths === ignoredPaths || sameStringList(cached.ignoredPaths, ignoredPaths))
    ) {
      return cached.paths
    }
    // A new untracked file changes only the small side of the merge; the tracked
    // side is reused and the two are merged in one pass instead of re-splitting
    // and re-sorting every path (15 ms on Bun, 120 ms on V8 at 100k paths).
    const trackedPaths = cached != null && cached.buffer.equals(trackedBuffer)
      ? cached.trackedPaths
      : sortedTrackedPaths(trackedBuffer)
    const paths = mergeSortedUnique(trackedPaths, extraVisiblePaths(untrackedPaths, ignoredPaths))
    this.#trackedPathsCache = {
      buffer: trackedBuffer,
      untrackedPaths: [...untrackedPaths],
      ignoredPaths,
      trackedPaths,
      paths
    }
    return paths
  }

  async #refreshFolder(root: string): Promise<RepositorySnapshot> {
    const pathsResult = await runCommand(
      RIPGREP_EXECUTABLE,
      [
        '--files',
        '--no-require-git',
        ...RIPGREP_VISIBLE_FILE_ARGS,
        '--null'
      ],
      root,
      [1]
    )
    const cached = this.#folderPathsCache
    const paths = cached != null && cached.buffer.equals(pathsResult.stdout)
      ? cached.paths
      : prepareVisiblePaths(pathsResult.stdout)
    if (paths !== cached?.paths) this.#folderPathsCache = { buffer: pathsResult.stdout, paths }
    const snapshot: RepositorySnapshot = {
      root,
      name: basename(root),
      kind: 'folder',
      branch: null,
      head: null,
      paths,
      statuses: [],
      stage: 'live'
    }

    this.#setSnapshot(snapshot)
    return snapshot
  }

  getComparison(path: string): Promise<FileComparison> {
    const pending = this.#pendingComparisons.get(path)
    if (pending != null) return pending
    // App.tsx, the multi-file viewer's scroll hydration and the editor can each
    // ask for the same path in the same tick; without this they each ran the
    // whole read/decode/hash pipeline.
    const comparison = this.#loadComparison(path).finally(() => {
      this.#pendingComparisons.delete(path)
    })
    this.#pendingComparisons.set(path, comparison)
    return comparison
  }

  /**
   * One side of a reviewed file at a commit. A patch only carries its hunks, so
   * the review asks for this to tokenize the whole file: a block comment or
   * docstring that closes between two hunks otherwise leaks into the next one.
   */
  async getRevisionFile(revision: unknown, path: unknown): Promise<DiffFileContents | null> {
    this.#requireGitRepository()
    if (typeof revision !== 'string' || !GIT_REVISION_PATTERN.test(revision)) {
      throw new Error('The revision is invalid.')
    }
    if (typeof path !== 'string' || path === '' || /[\n\0]/.test(path) || isAbsolute(path)) {
      throw new Error('The revision path is invalid.')
    }
    return (await this.#readHeadFile(path, revision))?.file ?? null
  }

  async hasRevision(revision: unknown): Promise<boolean> {
    this.#requireGitRepository()
    if (typeof revision !== 'string' || !GIT_REVISION_PATTERN.test(revision)) return false
    const read = await this.#readObject(`${revision}^{commit}`).catch(() => null)
    return read != null && !read.missing
  }

  /**
   * Makes both ends of a pull request readable, fetching them when the clone
   * has never seen them — a branch nobody pulled, or a push since the last
   * fetch. Without them the review can only show the patch: no expanding
   * context, and every hunk tokenized on its own, so a docstring that opens
   * above a hunk reads as code inside it. GitHub serves any commit reachable
   * from the repository by id; `refs/pull/N/head` covers a head that only a
   * fork's branch reaches. Nothing is written but objects: no ref, no
   * FETCH_HEAD.
   */
  async ensurePullRequestRevisions(pullRequestUrl: unknown, baseOid: unknown, headOid: unknown): Promise<boolean> {
    this.#requireGitRepository()
    if (typeof baseOid !== 'string' || !GIT_REVISION_PATTERN.test(baseOid)
      || typeof headOid !== 'string' || !GIT_REVISION_PATTERN.test(headOid)
      || typeof pullRequestUrl !== 'string') return false
    const readable = async (): Promise<boolean> =>
      (await Promise.all([this.hasRevision(baseOid), this.hasRevision(headOid)])).every(Boolean)
    if (await readable()) return true
    const number = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/(\d+)(?:\/.*)?$/i
      .exec(pullRequestUrl.trim())?.[1]
    if (number == null) return false
    const key = `${baseOid}:${headOid}`
    const inFlight = this.#revisionFetches.get(key)
    if (inFlight != null) return await inFlight
    const run = (async () => {
      const remote = (await this.getRemotes().catch(() => []))
        .find((candidate) => pullRequestTargetsRemotes([candidate], pullRequestUrl))
      if (remote == null) return false
      const fetch = (refs: string[]): Promise<unknown> => this.#gitAllowFailure(
        ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', remote.name, ...refs])
      await fetch([headOid, baseOid])
      if (await readable()) return true
      await fetch([`refs/pull/${number}/head`, baseOid])
      return await readable()
    })()
    this.#revisionFetches.set(key, run)
    try {
      return await run
    } finally {
      this.#revisionFetches.delete(key)
    }
  }

  async #loadComparison(path: string): Promise<FileComparison> {
    const root = this.#requireRoot()
    const snapshot = this.#requireSnapshot()
    if (!this.#pathSet.has(path)) {
      const workingVersion = await this.#readWorkingFile(path, root)
      if (workingVersion == null) {
        throw new Error(`“${basename(path)}” is no longer in the folder.`)
      }
      return {
        path,
        mode: 'file',
        status: 'unchanged',
        oldFile: null,
        newFile: workingVersion.binary || workingVersion.oversized ? null : workingVersion.file,
        binary: Boolean(workingVersion.binary),
        oversized: Boolean(workingVersion.oversized),
        image: workingVersion.image == null ? null : { old: null, new: workingVersion.image }
      }
    }

    const status = this.#statusByPath.get(path)
    const oldPath = status?.previousPath ?? path
    // Clean files and pre-status clicks only need the working copy. git show
    // HEAD contended with the background status walk and made every preview wait.
    const [oldVersion, workingVersion] = await Promise.all([
      snapshot.kind === 'git' && status != null
        ? this.#readHeadFile(oldPath, snapshot.head)
        : null,
      this.#readWorkingFile(path, root)
    ])
    const binary = Boolean(oldVersion?.binary || workingVersion?.binary)
    const oversized = Boolean(oldVersion?.oversized || workingVersion?.oversized)
    const oldImage = oldVersion?.image ?? null
    const newImage = workingVersion?.image ?? null

    return {
      path,
      mode: snapshot.kind === 'git' && status != null ? 'diff' : 'file',
      status: status?.status ?? 'unchanged',
      oldFile: binary || oversized ? null : oldVersion?.file ?? null,
      newFile: binary || oversized ? null : workingVersion?.file ?? null,
      binary,
      oversized,
      image: oldImage != null || newImage != null ? { old: oldImage, new: newImage } : null
    }
  }

  async saveWorkingFile(input: unknown): Promise<FileComparison> {
    const request = input as Partial<WorkingFileSaveRequest> | null
    if (
      request == null
      || typeof request.path !== 'string'
      || typeof request.contents !== 'string'
      || typeof request.expectedCacheKey !== 'string'
    ) {
      throw new Error('The file save request is invalid.')
    }

    const { path, contents, expectedCacheKey } = request
    const root = this.#requireRoot()
    if (!this.#pathSet.has(path)) throw new Error('The selected path is not in the repository.')
    if (Buffer.byteLength(contents, 'utf8') > MAX_DIFF_FILE_BYTES) {
      throw new Error('Files larger than 2 MB cannot be edited in Kodi.')
    }
    if (contents.includes('\0')) throw new Error('Binary files cannot be edited in Kodi.')

    // The conflict check is the one place that must see the disk, not the cache.
    const currentVersion = await this.#readWorkingFile(path, root, true)
    if (
      currentVersion?.file == null
      || currentVersion.binary
      || currentVersion.oversized
    ) {
      throw new Error('This working file is not editable.')
    }
    const currentFile = currentVersion.file
    if (currentFile.cacheKey !== expectedCacheKey) {
      throw new Error('The file changed on disk. Reload it before saving your draft.')
    }
    if (currentFile.contents === contents) return this.getComparison(path)

    const candidate = resolve(root, path)
    if (!isWithinRoot(root, candidate)) throw new Error('The selected path escapes the repository.')
    const metadata = await lstat(candidate)
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error('Symbolic links and non-file paths cannot be edited.')
    }
    const resolvedPath = await realpath(candidate)
    if (!isWithinRoot(root, resolvedPath)) {
      throw new Error('The selected file resolves outside the repository.')
    }

    const temporaryPath = resolve(dirname(resolvedPath), `.kodi-save-${randomUUID()}`)
    try {
      await writeFile(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: metadata.mode })
      this.#selfWriteObserver?.(path, async () => {
        try {
          return await readFile(resolvedPath, 'utf8') === contents
        } catch {
          return false
        }
      })
      await rename(temporaryPath, resolvedPath)
    } finally {
      await unlink(temporaryPath).catch(() => {})
    }

    this.#mutation += 1
    this.#snapshotRevision += 1
    this.#deleteWorkingCacheEntry(path)
    this.#pendingComparisons.delete(path)
    // A single-file write cannot change the tracked path list, the branch or HEAD,
    // so the whole-tree `ls-files` + `status --untracked-files=all` pair the save
    // used to run is replaced by one status call scoped to the saved path.
    if (!await this.#refreshSavedPathStatus(path)) await this.refresh()
    return this.getComparison(path)
  }

  async #refreshSavedPathStatus(path: string): Promise<boolean> {
    const snapshot = this.#snapshot
    if (snapshot == null || snapshot.kind !== 'git') return false
    let result: CommandResult
    try {
      result = await this.#git([
        'status', '--porcelain=v2', '-z', '--untracked-files=all', '--', `:(literal)${path}`
      ])
    } catch {
      return false
    }
    const entries = parsePorcelainV2Status(result.stdout).statuses
    // A rename record or a report about another path means the narrow view is
    // wrong about what moved; fall back to the whole-tree walk.
    if (entries.length > 1 || entries.some((entry) => entry.path !== path || entry.previousPath != null)) {
      return false
    }
    const next = entries[0] ?? null
    const previous = this.#statusByPath.get(path) ?? null
    if (
      previous?.status === next?.status
      && previous?.previousPath === next?.previousPath
      && previous?.staged === next?.staged
    ) return true
    this.#setSnapshot({ ...snapshot, statuses: replaceStatusEntry(snapshot.statuses, path, next) })
    return true
  }

  async getWorkingTreePatch(
    pathsValue: unknown,
    onProgress?: (page: WorkingTreePatch) => void
  ): Promise<WorkingTreePatch> {
    this.#requireGitRepository()
    if (!Array.isArray(pathsValue) || pathsValue.length > this.#pathSet.size) {
      throw new Error('Working tree patch paths must be a valid list.')
    }
    const paths = pathsValue.map((path) => {
      if (typeof path !== 'string' || !this.#pathSet.has(path)) {
        throw new Error('Working tree patch path is not in the repository.')
      }
      return path
    })
    // A watcher refresh changes the logical working tree even when the visible
    // path list stays the same. Include its revision so a newer edit aborts an
    // older same-path build instead of reusing a stale patch.
    const key = `${this.#snapshotRevision}\0${[...paths].sort().join('\0')}`
    const pages = await this.#runKeyedFlight(
      this.#pendingWorkingTreePatches,
      key,
      (signal, emit) => this.#loadWorkingTreePatch(paths, signal, emit),
      onProgress
    )
    if (onProgress == null) return this.#joinWorkingTreePages(pages)
    // A listening caller has every page already: the flight replays what it
    // emitted before they joined, and a page is only skipped when it carries
    // nothing. The renderer keeps what it was streamed and waits for the
    // stream's `done` before trusting this reply (a reply is not ordered against
    // progress events) — joining the pages here cloned the whole diff over IPC a
    // second time.
    return { patch: '', omittedFiles: pages.flatMap((page) => page.omittedFiles) }
  }

  async #loadWorkingTreePatch(
    paths: string[],
    signal: AbortSignal,
    onProgress?: (page: WorkingTreePatch) => void
  ): Promise<WorkingTreePatch[]> {
    if (paths.length === 0) return []

    const root = this.#requireRoot()
    const snapshot = this.#requireSnapshot()
    const { first, rest } = isolateFirstPathspec(paths)
    const firstWork = this.#loadWorkingTreePathsPatch([first!], root, snapshot, signal)
    const restWork = rest.length === 0
      ? Promise.resolve({ patch: '', omittedFiles: [] as OmittedDiffFile[] })
      : this.#loadWorkingTreePathsPatch(rest, root, snapshot, signal)
    try {
      const firstPage = await firstWork
      this.#emitWorkingTreePage(firstPage, signal, onProgress)
      const restPage = await restWork
      this.#emitWorkingTreePage(restPage, signal, onProgress)
      return [firstPage, restPage]
    } catch (error) {
      await restWork.catch(() => {})
      throw error
    }
  }

  #emitWorkingTreePage(
    page: WorkingTreePatch,
    signal: AbortSignal,
    onProgress?: (page: WorkingTreePatch) => void
  ): void {
    if (signal.aborted) throw new Error(COMMAND_ABORTED_MESSAGE)
    if (onProgress == null || (page.patch === '' && page.omittedFiles.length === 0)) return
    onProgress(page)
  }

  #joinWorkingTreePages(pages: readonly WorkingTreePatch[]): WorkingTreePatch {
    const omittedFiles = pages.flatMap((page) => page.omittedFiles)
    const limited = limitPatchFileSize(
      pages.flatMap((page) => page.patch === '' ? [] : [page.patch]).join('\n'),
      MAX_DIFF_FILE_BYTES
    )
    return { patch: limited.patch, omittedFiles: [...omittedFiles, ...limited.omittedFiles] }
  }

  #workingTreePathspecGroups(paths: readonly string[]): string[][] {
    return paths.map((path) =>
      pathspecGroupForFile({ path, previousPath: this.#statusByPath.get(path)?.previousPath })
    )
  }

  async #loadWorkingTreePathsPatch(
    paths: string[],
    root: string,
    snapshot: RepositorySnapshot,
    signal: AbortSignal
  ): Promise<WorkingTreePatch> {
    if (paths.length === 0) return { patch: '', omittedFiles: [] }

    const untrackedPaths = paths.filter((path) => this.#statusByPath.get(path)?.status === 'untracked')
    const trackedPaths = snapshot.head == null
      ? []
      : paths.filter((path) => this.#statusByPath.get(path)?.status !== 'untracked')
    const omittedFiles: OmittedDiffFile[] = []
    const patchParts: string[] = []

    if (trackedPaths.length > 0) {
      const head = snapshot.head!
      const churnChunks = await mapWithConcurrency(
        chunkPathspecGroups(this.#workingTreePathspecGroups(trackedPaths)),
        MAX_PATCH_COMMAND_CONCURRENCY,
        async (chunk) => parseNumstat(
          (await this.#git(['diff', '--numstat', '-z', '--find-renames', head, '--', ...chunk], signal)).stdout
        )
      )
      const oversized = selectOversizedDiffFiles(churnChunks.flat())
      omittedFiles.push(...oversized.omittedFiles)
      const oversizedPaths = new Set(oversized.omittedFiles.map((file) => file.path))
      const includedPaths = trackedPaths.filter((path) => !oversizedPaths.has(path))
      const patchChunks = await mapWithConcurrency(
        chunkPathspecGroups(this.#workingTreePathspecGroups(includedPaths)),
        MAX_PATCH_COMMAND_CONCURRENCY,
        async (chunk) => (
          await this.#git(['diff', '--no-color', '--find-renames', '--unified=3', head, '--', ...chunk], signal)
        ).stdout.toString('utf8')
      )
      for (const patch of patchChunks) {
        if (patch !== '') patchParts.push(patch)
      }
    }

    const newPaths = snapshot.head == null ? paths : untrackedPaths
    const newFilePatches = await mapWithConcurrency(
      newPaths,
      MAX_PATCH_COMMAND_CONCURRENCY,
      (path) => this.#createNewFilePatch(path, root, signal)
    )
    for (const newFilePatch of newFilePatches) {
      if (newFilePatch.patch !== '') patchParts.push(newFilePatch.patch)
      if (newFilePatch.omitted != null) omittedFiles.push(newFilePatch.omitted)
    }

    const limited = limitPatchFileSize(patchParts.join('\n'), MAX_DIFF_FILE_BYTES)
    return { patch: limited.patch, omittedFiles: [...omittedFiles, ...limited.omittedFiles] }
  }

  async #createNewFilePatch(
    path: string,
    root: string,
    signal: AbortSignal
  ): Promise<{ patch: string; omitted: OmittedDiffFile | null }> {
    if (signal.aborted) throw new Error(COMMAND_ABORTED_MESSAGE)
    const version = await this.#readWorkingFile(path, root)
    if (signal.aborted) throw new Error(COMMAND_ABORTED_MESSAGE)
    if (version == null) return { patch: '', omitted: null }
    if (version.oversized) {
      return { patch: '', omitted: { path, reason: 'too-large', additions: 0, deletions: 0 } }
    }
    if (version.contents == null) return { patch: '', omitted: null }
    return {
      patch: createNewFilePatch(
        path,
        version.binary ? '' : version.contents.toString('utf8'),
        version.binary
      ),
      omitted: null
    }
  }

  cancelContentSearch(): void {
    this.#cancelActiveSearch()
  }

  /**
   * `forOpenPath` adds a second, wider pass over the one file the reader is looking
   * at: the palette only needs a couple of dozen hits across the repository, but the
   * diff marks every hit in the file on screen and a 24-result cap cannot cover it.
   */
  async searchContent(query: string, forOpenPath?: string | null): Promise<ContentSearchResult[]> {
    const trimmedQuery = query.trim()
    this.#cancelActiveSearch()
    if (trimmedQuery.length < 2) return []
    const root = this.#requireRoot()
    const search: ActiveContentSearch = {
      children: new Set(),
      cancelled: false,
      startedAt: performance.now()
    }
    this.#contentSearchMetrics.spawned += 1
    this.#activeSearch = search
    const openPath = contentSearchOpenPath(forOpenPath)

    try {
      const [workspaceResults, openFileResults] = await Promise.all([
        this.#runContentSearch(search, root, trimmedQuery, {
          cap: MAX_SEARCH_RESULTS,
          matchesPerFile: CONTENT_SEARCH_MATCHES_PER_FILE,
          path: null
        }),
        openPath == null
          ? Promise.resolve<ContentSearchResult[]>([])
          // A deleted or renamed open file must not fail the search the palette is
          // waiting on, so this pass reports nothing rather than throwing.
          : this.#runContentSearch(search, root, trimmedQuery, {
            cap: MAX_OPEN_FILE_SEARCH_RESULTS,
            matchesPerFile: MAX_OPEN_FILE_SEARCH_RESULTS,
            path: openPath
          }).catch(() => [])
      ])
      return mergeContentSearchResults(workspaceResults, openFileResults)
    } finally {
      this.#contentSearchMetrics.completed += 1
      if (!search.cancelled) {
        this.#contentSearchMetrics.durationsMs.push(performance.now() - search.startedAt)
        this.#contentSearchMetrics.durationsMs = this.#contentSearchMetrics.durationsMs.slice(-100)
      }
      for (const child of search.children) child.kill()
      search.children.clear()
      if (this.#activeSearch === search) this.#activeSearch = null
    }
  }

  #runContentSearch(
    search: ActiveContentSearch,
    root: string,
    query: string,
    options: { cap: number; matchesPerFile: number; path: string | null }
  ): Promise<ContentSearchResult[]> {
    return new Promise((resolveSearch, rejectSearch) => {
      const child = spawn(
        RIPGREP_EXECUTABLE,
        [
          '--json',
          '--fixed-strings',
          '--smart-case',
          ...RIPGREP_VISIBLE_FILE_ARGS,
          '--max-columns',
          '500',
          '--max-count',
          String(options.matchesPerFile),
          '--max-filesize',
          CONTENT_SEARCH_MAX_FILESIZE,
          '--threads',
          String(CONTENT_SEARCH_THREADS),
          '--',
          query,
          options.path ?? '.'
        ],
        { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      search.children.add(child)
      const results: ContentSearchResult[] = []
      let pending = ''
      let errorOutput = ''
      let capped = false

      const processLine = (line: string): void => {
        if (results.length >= options.cap || line.length === 0) return
        try {
          const event = JSON.parse(line) as {
            type: string
            data?: {
              path?: { text?: string }
              line_number?: number
              lines?: { text?: string }
              submatches?: Array<{ start: number }>
            }
          }
          if (event.type !== 'match' || event.data?.path?.text == null) return
          const rawPath = event.data.path.text.replace(/^\.\//, '')
          if (isExcludedPath(rawPath)) return
          results.push({
            path: rawPath,
            line: event.data.line_number ?? 1,
            column: (event.data.submatches?.[0]?.start ?? 0) + 1,
            preview: event.data.lines?.text?.trimEnd() ?? ''
          })
        } catch {
          // Ignore incomplete diagnostic records from a terminated search.
        }
      }

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (capped) return
        pending += chunk
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) processLine(line)
        if (results.length < options.cap) return
        // Killing the child still left a batch of buffered matches to concatenate
        // and JSON-parse for results nobody will read, so the stream is dropped too.
        capped = true
        pending = ''
        child.stdout.destroy()
        child.kill()
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        errorOutput += chunk
      })
      child.on('error', (error) => {
        search.children.delete(child)
        rejectSearch(error)
      })
      child.on('close', (code, signal) => {
        search.children.delete(child)
        if (!capped) processLine(pending)
        const completion = classifySearchCompletion({
          cancelled: search.cancelled,
          code,
          signal,
          resultCount: results.length,
          errorOutput,
          resultCap: options.cap
        })
        if (completion.kind === 'error') {
          rejectSearch(new Error(completion.message))
          return
        }
        resolveSearch(results)
      })
    })
  }

  async getPullRequestConversation(
    selector: number | string,
    options: { force?: boolean } = {}
  ): Promise<PullRequestConversation> {
    this.#requireGitRepository()
    const normalizedSelector = normalizePullRequestSelector(selector)
    const ghExecutable = await getGhExecutable()
    const attemptedAt = Date.now()
    let cacheKey = ''
    try {
      const [{ owner, name, number }, accountId] = await Promise.all([
        this.#resolvePullRequestIdentity(ghExecutable, normalizedSelector),
        this.#getGitHubAccountId(ghExecutable)
      ])
      cacheKey = `github.com:${accountId}:${this.#githubAuthEpoch}:${owner.toLowerCase()}/${name.toLowerCase()}:${number}:conversation:v2`
      let cached = conversationCache.get(cacheKey)
      if (cached == null) {
        cached = await this.#readConversationCache(cacheKey)
        if (cached != null) conversationCache.set(cacheKey, cached)
      }
      // `force` is the reader asking, or a write of our own that has to be read
      // back. Either way a cached answer is the wrong answer.
      if (options.force !== true && cached != null
        && attemptedAt - cached.fetchedAt < CONVERSATION_CACHE_TTL_MS) {
        return { ...cached.value, stale: false, attemptedAt }
      }
      const pending = conversationFlights.get(cacheKey)
      if (pending != null) return pending
      const flight = this.#loadPullRequestConversationPages(
        ghExecutable,
        { owner, name, number },
        attemptedAt
      ).then((conversation) => {
        conversationCache.set(cacheKey, { value: conversation, fetchedAt: conversation.fetchedAt ?? Date.now() })
        void this.#writeConversationCache(cacheKey, conversation)
        while (conversationCache.size > 100) conversationCache.delete(conversationCache.keys().next().value as string)
        return conversation
      }).catch((error: unknown) => {
        const lastGood = conversationCache.get(cacheKey)?.value
        if (lastGood == null) throw error
        return {
          ...lastGood,
          available: false,
          message: gitHubIntegrationErrorMessage(error),
          stale: true,
          attemptedAt,
          partialError: gitHubIntegrationErrorMessage(error)
        }
      }).finally(() => {
        if (conversationFlights.get(cacheKey) === flight) conversationFlights.delete(cacheKey)
      })
      conversationFlights.set(cacheKey, flight)
      return await flight
    } catch (error) {
      return {
        available: false,
        message: gitHubIntegrationErrorMessage(error),
        body: '',
        headOid: '',
        threads: [],
        reviews: [],
        complete: false,
        stale: false,
        attemptedAt,
        partialError: gitHubIntegrationErrorMessage(error)
      }
    }
  }

  async #readConversationCache(
    key: string
  ): Promise<{ value: PullRequestConversation; fetchedAt: number } | undefined> {
    const directory = this.#pullRequestCacheDirectory
    if (directory == null) return undefined
    try {
      const raw = JSON.parse(await readFile(resolve(directory, `conversation-${createCacheKey(key)}.json`), 'utf8')) as {
        version?: number
        fetchedAt?: number
        value?: PullRequestConversation
      }
      if (raw.version !== 1 || typeof raw.fetchedAt !== 'number' || raw.value?.available !== true
        || raw.value.complete !== true || !Array.isArray(raw.value.threads) || !Array.isArray(raw.value.reviews)) {
        return undefined
      }
      return { value: raw.value, fetchedAt: raw.fetchedAt }
    } catch {
      return undefined
    }
  }

  async #writeConversationCache(key: string, value: PullRequestConversation): Promise<void> {
    const directory = this.#pullRequestCacheDirectory
    if (directory == null || value.available !== true || value.complete !== true) return
    const path = resolve(directory, `conversation-${createCacheKey(key)}.json`)
    const temporaryPath = `${path}.${randomUUID()}.tmp`
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(temporaryPath, JSON.stringify({ version: 1, fetchedAt: value.fetchedAt, value }), 'utf8')
      await rename(temporaryPath, path)
    } catch {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }

  async #loadPullRequestConversationPages(
    ghExecutable: string,
    identity: { owner: string; name: string; number: number },
    attemptedAt: number
  ): Promise<PullRequestConversation> {
    const threads = new Map<string, RemoteReviewThread>()
    const reviews = new Map<string, RemoteReviewSummary>()
    let body = ''
    let headOid = ''
    let threadCursor: string | null = null
    let reviewCursor: string | null = null
    let pages = 0
    let bytes = 0
    let complete = true
    do {
      const result = await runCommand(
        ghExecutable,
        ['api', 'graphql', '--input', '-'],
        this.#requireRoot(),
        [],
        JSON.stringify({
          query: PULL_REQUEST_THREADS_QUERY,
          variables: { ...identity, threadCursor, reviewCursor }
        }),
        undefined,
        'interactive',
        { executionMs: 45_000 }
      )
      pages += 1
      bytes += result.stdout.length
      const raw = JSON.parse(result.stdout.toString('utf8')) as unknown
      const parsed = parsePullRequestConversation(raw)
      body = parsed.body || body
      headOid = parsed.headOid || headOid
      for (const thread of parsed.threads) threads.set(thread.id, thread)
      for (const review of parsed.reviews) reviews.set(review.id, review)
      const pullRequest = (raw as { data?: { repository?: { pullRequest?: Record<string, unknown> } } })
        ?.data?.repository?.pullRequest
      const threadPage = (pullRequest?.reviewThreads as { pageInfo?: { hasNextPage?: boolean; endCursor?: string } } | undefined)?.pageInfo
      const reviewPage = (pullRequest?.reviews as { pageInfo?: { hasNextPage?: boolean; endCursor?: string } } | undefined)?.pageInfo
      threadCursor = threadPage?.hasNextPage === true ? threadPage.endCursor ?? null : null
      reviewCursor = reviewPage?.hasNextPage === true ? reviewPage.endCursor ?? null : null
      if (pages >= MAX_CONVERSATION_PAGES || bytes >= MAX_CONVERSATION_BYTES) {
        complete = threadCursor == null && reviewCursor == null
        break
      }
    } while (threadCursor != null || reviewCursor != null)

    for (const thread of threads.values()) {
      if (pages >= MAX_CONVERSATION_PAGES || bytes >= MAX_CONVERSATION_BYTES) {
        complete = false
        break
      }
      const comments = new Map(thread.comments.map((comment) => [comment.id, comment]))
      let cursor = await this.#threadCommentCursor(ghExecutable, thread.id, null, comments, (size) => { bytes += size })
      while (cursor != null && pages < MAX_CONVERSATION_PAGES && bytes < MAX_CONVERSATION_BYTES) {
        pages += 1
        cursor = await this.#threadCommentCursor(ghExecutable, thread.id, cursor, comments, (size) => { bytes += size })
      }
      if (cursor != null) complete = false
      thread.comments = [...comments.values()]
    }
    const fetchedAt = Date.now()
    return {
      available: true,
      message: null,
      body,
      headOid,
      threads: [...threads.values()],
      reviews: [...reviews.values()],
      complete,
      stale: false,
      fetchedAt,
      attemptedAt,
      partialError: complete ? null : 'GitHub conversation page or byte budget reached.'
    }
  }

  async #threadCommentCursor(
    ghExecutable: string,
    threadId: string,
    cursor: string | null,
    comments: Map<string, RemoteReviewComment>,
    countBytes: (bytes: number) => void
  ): Promise<string | null> {
    if (cursor == null && comments.size < 100) return null
    const result = await runCommand(
      ghExecutable,
      ['api', 'graphql', '--input', '-'],
      this.#requireRoot(),
      [],
      JSON.stringify({ query: PULL_REQUEST_THREAD_COMMENTS_QUERY, variables: { id: threadId, cursor } }),
      undefined,
      'interactive',
      { executionMs: 45_000 }
    )
    countBytes(result.stdout.length)
    const raw = JSON.parse(result.stdout.toString('utf8')) as {
      data?: { node?: { comments?: { nodes?: unknown; pageInfo?: { hasNextPage?: boolean; endCursor?: string } } } }
    }
    const connection = raw.data?.node?.comments
    for (const comment of parseRemoteReviewComments(connection)) comments.set(comment.id, comment)
    return connection?.pageInfo?.hasNextPage === true ? connection.pageInfo.endCursor ?? null : null
  }

  async #resolvePullRequestIdentity(
    ghExecutable: string,
    selector: string,
    lane: CommandLaneSource = 'interactive'
  ): Promise<{ owner: string; name: string; number: number }> {
    const cached = this.#pullRequestIdentities.get(selector)
    if (cached != null) return cached
    const detailsResult = await runGitHubReadCommand(
      ghExecutable,
      ['pr', 'view', selector, '--json', 'number,url'],
      this.#requireRoot(),
      undefined,
      lane
    )
    const details = parseJson<{ number: number; url: string }>(detailsResult, 'GitHub CLI')
    validatePullRequestTarget(details.url, details.number)
    const slug = githubRepoSlugFromRemoteUrl(details.url.replace(/\/pull\/\d+.*$/, ''))
    const [owner, name] = slug?.split('/') ?? []
    if (owner == null || name == null) throw new Error('GitHub returned an invalid pull request URL.')
    const identity = { owner, name, number: details.number }
    this.#pullRequestIdentities.set(selector, identity)
    return identity
  }

  async replyToPullRequestThread(threadId: unknown, body: unknown): Promise<void> {
    this.#requireGitRepository()
    if (typeof threadId !== 'string' || threadId === '' || threadId.length > 256) {
      throw new Error('The review thread could not be identified.')
    }
    const replyBody = typeof body === 'string' ? body.trim() : ''
    if (replyBody === '') throw new Error('A reply cannot be empty.')
    if (replyBody.length > MAX_REVIEW_BODY_LENGTH) throw new Error('This reply is too long to send.')
    const ghExecutable = await getGhExecutable()
    await runGitHubMutation(() => runCommand(
      ghExecutable,
      ['api', 'graphql', '--input', '-'],
      this.#requireRoot(),
      [],
      JSON.stringify({
        query: ADD_REVIEW_THREAD_REPLY_MUTATION,
        variables: { input: { pullRequestReviewThreadId: threadId, body: replyBody } }
      }),
      undefined,
      'interactive',
      { executionMs: 60_000 }
    ))
  }

  async setPullRequestThreadResolved(threadId: unknown, resolved: unknown): Promise<void> {
    this.#requireGitRepository()
    if (typeof threadId !== 'string' || threadId === '' || threadId.length > 256) {
      throw new Error('The review thread could not be identified.')
    }
    const ghExecutable = await getGhExecutable()
    await runGitHubMutation(() => runCommand(
      ghExecutable,
      ['api', 'graphql', '--input', '-'],
      this.#requireRoot(),
      [],
      JSON.stringify({
        query: resolved === true ? RESOLVE_REVIEW_THREAD_MUTATION : UNRESOLVE_REVIEW_THREAD_MUTATION,
        variables: { input: { threadId } }
      }),
      undefined,
      'interactive',
      { executionMs: 60_000 }
    ))
  }

  async mergePullRequest(selector: number | string, strategy: unknown): Promise<void> {
    this.#requireGitRepository()
    const normalizedSelector = normalizePullRequestSelector(selector)
    // Merging is irreversible: an unrecognized strategy is a caller bug, not a
    // reason to pick one.
    if (strategy !== 'merge' && strategy !== 'rebase' && strategy !== 'squash') {
      throw new Error('Unknown merge strategy.')
    }
    const mergeFlag = strategy === 'merge' ? '--merge' : strategy === 'rebase' ? '--rebase' : '--squash'
    const ghExecutable = await getGhExecutable()
    const [remotes, detailsResult] = await Promise.all([
      this.getRemotes(),
      runGitHubReadCommand(
        ghExecutable,
        ['pr', 'view', normalizedSelector, '--json', 'number,url,baseRefOid,headRefOid'],
        this.#requireRoot()
      )
    ])
    const details = parseJson<{ number: number; url: string; baseRefOid: string; headRefOid: string }>(detailsResult, 'GitHub CLI')
    validatePullRequestTarget(details.url, details.number)
    // Merging is irreversible, so it is refused unless the pull request lives in the open repository.
    if (!pullRequestTargetsRemotes(remotes, details.url)) {
      throw new Error('This pull request belongs to a different repository than the open one.')
    }
    const opened = await this.#pullRequestCache?.readIndex(details.url) ?? null
    if (opened != null && (opened.baseRefOid !== details.baseRefOid || opened.headRefOid !== details.headRefOid)) {
      throw new Error('This pull request has new commits since you opened it. Load the new commits, then merge.')
    }
    await runGitHubMutation(() => runCommand(
      ghExecutable,
      ['pr', 'merge', normalizedSelector, mergeFlag],
      this.#requireRoot(),
      [],
      undefined,
      undefined,
      'interactive',
      { executionMs: 120_000 }
    ))
  }

  async markPullRequestReady(selector: number | string): Promise<void> {
    this.#requireGitRepository()
    const normalizedSelector = normalizePullRequestSelector(selector)
    const ghExecutable = await getGhExecutable()
    // Marking ready is a remote write, so it is held to the same rule as merging:
    // a pasted URL must name the repository that is open.
    const [remotes, detailsResult] = await Promise.all([
      this.getRemotes(),
      runGitHubReadCommand(
        ghExecutable,
        ['pr', 'view', normalizedSelector, '--json', 'number,url'],
        this.#requireRoot()
      )
    ])
    const details = parseJson<{ number: number; url: string }>(detailsResult, 'GitHub CLI')
    validatePullRequestTarget(details.url, details.number)
    if (!pullRequestTargetsRemotes(remotes, details.url)) {
      throw new Error('This pull request belongs to a different repository than the open one.')
    }
    await runGitHubMutation(() => runCommand(
      ghExecutable,
      ['pr', 'ready', normalizedSelector],
      this.#requireRoot(),
      [],
      undefined,
      undefined,
      'interactive',
      { executionMs: 60_000 }
    ))
  }

  // The remote slug cannot change while a repository is open, so it is resolved
  // once instead of spawning `git remote -v` on every poll tick.
  async #getGitHubSlug(): Promise<string | null> {
    if (this.#githubSlug !== undefined) return this.#githubSlug
    const remotes = await this.getRemotes()
    let slug: string | null = null
    for (const remote of remotes) {
      slug = githubRepoSlugFromRemoteUrl(remote.fetchUrl) ?? githubRepoSlugFromRemoteUrl(remote.pushUrl)
      if (slug != null) break
    }
    this.#githubSlug = slug
    return slug
  }

  async getPullRequestInbox(): Promise<PullRequestInboxSnapshot> {
    this.#requireGitRepository()
    const slug = await this.#getGitHubSlug()
    if (slug == null) {
      return { available: false, message: 'This repository has no GitHub remote.', sections: [] }
    }
    const ghExecutable = await getGhExecutable()
    try {
      // GraphQL search does not understand `@me`, so the viewer login is
      // substituted in; it is cached for the life of the repository.
      const login = await this.#getGitHubViewerLogin(ghExecutable)
      const variables = pullRequestInboxVariables(`repo:${slug} is:pr is:open`, login)
      const result = await runCommand(
        ghExecutable,
        ['api', 'graphql', '--input', '-'],
        this.#requireRoot(),
        [],
        JSON.stringify({ query: PULL_REQUEST_INBOX_QUERY, variables })
      )
      const entries = parsePullRequestInboxResponse(parseJson<unknown>(result, 'GitHub CLI'))
      return { available: true, message: null, sections: sectionPullRequestInbox(entries) }
    } catch (error) {
      return { available: false, message: gitHubIntegrationErrorMessage(error), sections: [] }
    }
  }

  /**
   * `pullRequests: false` answers from local git alone. The GitHub list is the
   * slow half — seconds against a busy repository, next to tens of milliseconds
   * for refs and log — so the panel asks for the two separately and paints
   * branches, history and changes without waiting on the network.
   */
  async getGitIntegration(options: { pullRequests?: boolean } = {}): Promise<GitIntegrationSnapshot> {
    this.#requireGitRepository()
    const includePullRequests = options.pullRequests !== false
    const branchesPromise = this.#git([
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(HEAD)%09%(refname:short)%09%(upstream:short)',
      'refs/heads'
    ])
    // Open pull requests only, and without `statusCheckRollup`/`mergeable`.
    // Measured against vercel/next.js: 100 PRs with the check fields answered
    // HTTP 504 after 11.3 s (retried three times by runGitHubReadCommand), the
    // same call without them 6.5 s, and `--state open --limit 30` 2.4 s. Nothing
    // in the panel renders check data; the review of a single pull request still
    // asks for it. Closed and merged rows load on demand instead.
    const pullRequestsPromise = includePullRequests
      ? this.getRepositoryPullRequests()
      : Promise.resolve({ pullRequests: [] as PullRequestSummary[], githubAvailable: true, githubMessage: null })

    const [branchesResult, remoteBranchesResult, remotes, commitsResult, defaultBranchResult, aheadBehindResult, githubResult] = await Promise.all([
      branchesPromise,
      this.#git(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/remotes']),
      this.getRemotes(),
      this.#gitAllowFailure(['log', '-100', '--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D%x1e']),
      this.#gitAllowFailure(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']),
      this.#gitAllowFailure(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
      pullRequestsPromise
    ])
    const branches = parseBranches(branchesResult)
    const defaultRemoteBranch = defaultBranchResult?.stdout.toString('utf8').trim() || null
    const defaultBranch = defaultRemoteBranch?.replace(/^[^/]+\//, '')
      ?? (branches.some((branch) => branch.name === 'main') ? 'main' : null)
      ?? (branches.some((branch) => branch.name === 'master') ? 'master' : null)
      ?? branches.find((branch) => branch.current)?.name
      ?? null
    const counts = parseAheadBehind(aheadBehindResult)
    return {
      branches,
      remoteBranches: parseRemoteBranches(remoteBranchesResult),
      remotes,
      commits: parseCommits(commitsResult),
      defaultBranch,
      ahead: counts.ahead,
      behind: counts.behind,
      ...githubResult
    }
  }

  async getRepositoryPullRequests(): Promise<RepositoryPullRequests> {
    this.#requireGitRepository()
    const ghExecutable = await getGhExecutable()
    return runGitHubReadCommand(
      ghExecutable,
      ['pr', 'list', '--state', 'open', '--limit', String(PULL_REQUEST_LIST_LIMIT), '--json', PULL_REQUEST_LIST_FIELDS],
      this.#requireRoot()
    ).then(
      (result) => ({ pullRequests: parsePullRequestSummaries(result), githubAvailable: true, githubMessage: null }),
      (error: unknown) => {
        // A cancelled list says nothing about GitHub; answering "unavailable"
        // for it replaced the rows the panel already had with an error.
        if (error instanceof Error && error.message === COMMAND_ABORTED_MESSAGE) throw error
        return {
          pullRequests: [] as PullRequestSummary[],
          githubAvailable: false,
          githubMessage: gitHubIntegrationErrorMessage(error)
        }
      }
    )
  }

  // Closed and merged pull requests are a deliberate second request: including
  // them in the panel's first paint tripled its latency for rows nobody had asked
  // to see.
  async getClosedPullRequests(): Promise<PullRequestSummary[]> {
    this.#requireGitRepository()
    const ghExecutable = await getGhExecutable()
    const result = await runGitHubReadCommand(
      ghExecutable,
      ['pr', 'list', '--state', 'closed', '--limit', String(PULL_REQUEST_LIST_LIMIT), '--json', PULL_REQUEST_LIST_FIELDS],
      this.#requireRoot()
    )
    return parsePullRequestSummaries(result)
  }

  async switchBranch(name: string): Promise<RepositorySnapshot> {
    this.#requireGitRepository()
    const branchesResult = await this.#git([
      'for-each-ref', '--format=%(refname:short)', 'refs/heads'
    ])
    const branches = new Set(branchesResult.stdout.toString('utf8').split('\n').filter(Boolean))
    if (!branches.has(name)) throw new Error('The selected local branch no longer exists.')
    // A switch rewrites the index, and a post-checkout hook can hold it for
    // longer than the one-second self-write window.
    await this.#writingIndex(() => this.#git(['switch', '--no-guess', name]))
    this.#mutation += 1
    return this.refresh()
  }

  async getLocalBranchReview(
    baseRef: string,
    headRef: string,
    onProgress?: (progress: LocalReviewProgress) => void
  ): Promise<LocalBranchReview> {
    this.#requireGitRepository()
    return this.#runLocalReview(
      `branch:${baseRef}\0${headRef}`,
      (signal, emit) => this.#loadLocalBranchReview(baseRef, headRef, signal, emit),
      onProgress
    )
  }

  async #loadLocalBranchReview(
    baseRef: string,
    headRef: string,
    signal: AbortSignal,
    onProgress?: (progress: LocalReviewProgress) => void
  ): Promise<LocalReviewResult> {
    const branchResult = await this.#git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], signal)
    const branches = new Set(branchResult.stdout.toString('utf8').split('\n').filter(Boolean))
    if (!branches.has(baseRef) || !branches.has(headRef)) throw new Error('Both comparison refs must be local branches.')
    if (baseRef === headRef) throw new Error('Select two different branches to compare.')
    const comparison = `${baseRef}...${headRef}`
    const [churnResult, baseResult, headResult] = await awaitAll([
      this.#git(['diff', '--numstat', '-z', '--find-renames', comparison, '--'], signal),
      this.#git(['merge-base', baseRef, headRef], signal),
      this.#git(['rev-parse', headRef], signal)
    ])
    const baseOid = baseResult.stdout.toString('utf8').trim()
    const headOid = headResult.stdout.toString('utf8').trim()
    return this.#loadFileFirstReview({
      churnEntries: parseNumstat(churnResult.stdout),
      patchArgs: ['diff', '--no-color', '--full-index', '--find-renames', comparison, '--'],
      signal,
      onProgress,
      reviewId: `${comparison}:${baseOid}:${headOid}`,
      title: `${headRef} compared with ${baseRef}`,
      baseRefName: baseRef,
      headRefName: headRef,
      baseOid,
      headOid
    })
  }

  async getLocalSnapshotReview(
    baseOid: string,
    headOid: string,
    baseRefName: string,
    headRefName: string
  ): Promise<LocalBranchReview> {
    this.#requireGitRepository()
    if (!/^[0-9a-f]{40}$/i.test(baseOid) || !/^[0-9a-f]{40}$/i.test(headOid)) {
      throw new Error('The saved comparison commits are invalid.')
    }
    const safeBaseName = baseRefName.slice(0, 256)
    const safeHeadName = headRefName.slice(0, 256)
    const comparison = `${baseOid}..${headOid}`
    const [baseExists, headExists, churnResult] = await awaitAll([
      this.#git(['cat-file', '-e', `${baseOid}^{commit}`]),
      this.#git(['cat-file', '-e', `${headOid}^{commit}`]),
      this.#git(['diff', '--numstat', '-z', '--find-renames', comparison, '--'])
    ])
    void baseExists
    void headExists
    const { review, patchParts } = await this.#loadFileFirstReview({
      churnEntries: parseNumstat(churnResult.stdout),
      patchArgs: ['diff', '--no-color', '--full-index', '--find-renames', comparison, '--'],
      signal: new AbortController().signal,
      reviewId: `${safeBaseName}...${safeHeadName}:${baseOid}:${headOid}`,
      title: `${safeHeadName} compared with ${safeBaseName}`,
      baseRefName: safeBaseName,
      headRefName: safeHeadName,
      baseOid,
      headOid
    })
    return { ...review, patch: patchParts.join('\n') }
  }

  async getCommitReview(
    oid: string,
    onProgress?: (progress: LocalReviewProgress) => void
  ): Promise<LocalBranchReview> {
    this.#requireGitRepository()
    if (!/^[0-9a-f]{7,40}$/i.test(oid)) throw new Error('Commit ID is invalid.')
    return this.#runLocalReview(
      `commit:${oid.toLowerCase()}`,
      (signal, emit) => this.#loadCommitReview(oid, signal, emit),
      onProgress
    )
  }

  async #loadCommitReview(
    oid: string,
    signal: AbortSignal,
    onProgress?: (progress: LocalReviewProgress) => void
  ): Promise<LocalReviewResult> {
    await this.#git(['cat-file', '-e', `${oid}^{commit}`], signal)
    const commitResult = await this.#git(['rev-list', '--parents', '-n', '1', oid], signal)
    const [commitOid, firstParent] = commitResult.stdout.toString('utf8').trim().split(' ')
    if (commitOid == null) throw new Error('Commit could not be resolved.')
    const churnArgs = firstParent == null
      ? ['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', '-z', '--find-renames', commitOid, '--']
      : ['diff', '--numstat', '-z', '--find-renames', firstParent, commitOid, '--']
    const patchArgs = firstParent == null
      ? ['show', '--format=', '--no-color', '--full-index', '--find-renames', commitOid, '--']
      : ['diff', '--no-color', '--full-index', '--find-renames', firstParent, commitOid, '--']
    const [churnResult, metadataResult] = await awaitAll([
      this.#git(churnArgs, signal),
      this.#git(['show', '-s', '--format=%h%x1f%s', commitOid], signal)
    ])
    const [shortOid = commitOid.slice(0, 8), subject = 'Commit'] = metadataResult.stdout.toString('utf8').trim().split('\x1f')
    return this.#loadFileFirstReview({
      churnEntries: parseNumstat(churnResult.stdout),
      patchArgs,
      signal,
      onProgress,
      reviewId: `commit:${commitOid}`,
      title: `${shortOid} ${subject}`,
      baseRefName: firstParent?.slice(0, 8) ?? 'Empty tree',
      headRefName: shortOid,
      baseOid: firstParent ?? EMPTY_TREE_OID,
      headOid: commitOid
    })
  }

  #runKeyedFlight<Progress, Result>(
    flights: Map<string, ReviewFlight<Progress, Result>>,
    key: string,
    load: (signal: AbortSignal, emit: (progress: Progress) => void) => Promise<Result>,
    listener?: (progress: Progress) => void
  ): Promise<Result> {
    const pending = flights.get(key)
    if (pending != null) return pending.join(listener)
    for (const flight of flights.values()) flight.abort.abort()
    const flight = new ReviewFlight<Progress, Result>()
    flights.set(key, flight)
    flight.start((emit, signal) =>
      load(signal, emit).finally(() => {
        if (flights.get(key) === flight) flights.delete(key)
      })
    )
    return flight.join(listener)
  }

  #runLocalReview(
    key: string,
    load: (signal: AbortSignal, emit: LocalReviewListener) => Promise<LocalReviewResult>,
    onProgress?: LocalReviewListener
  ): Promise<LocalBranchReview> {
    return this.#runKeyedFlight(
      this.#pendingLocalReviews,
      key,
      load,
      onProgress
    ).then((result) => this.#localReviewReply(result, onProgress != null))
  }

  #mergeChurnPatchFiles(
    churnFiles: PullRequestFile[],
    patchFiles: ReadonlyMap<string, PullRequestFile>
  ): PullRequestFile[] {
    if (patchFiles.size === 0) return []
    return churnFiles.flatMap((file) => {
      const fromPatch = patchFiles.get(file.path)
      return fromPatch == null ? [] : [{ ...file, ...fromPatch }]
    })
  }

  // A streamed caller already holds every page, so the joined patch is built only
  // for a caller that did not listen or for the agent's copy — and a patch over
  // that copy's budget would be remembered without it anyway.
  #localReviewReply({ review, patchParts }: LocalReviewResult, streamed: boolean): LocalBranchReview {
    if (streamed && joinedPatchLength(patchParts) > MAX_REMEMBERED_REVIEW_BYTES) {
      this.#rememberAgentReview(review)
      return review
    }
    const complete = { ...review, patch: patchParts.join('\n') }
    this.#rememberAgentReview(complete)
    return streamed ? review : complete
  }

  async #diffPathspecPatch(
    args: readonly string[],
    paths: readonly string[],
    signal: AbortSignal
  ): Promise<string> {
    if (paths.length === 0) return ''
    return (await this.#git([...args, ...paths], signal)).stdout.toString('utf8')
  }

  async #loadFileFirstReview(options: {
    churnEntries: ReturnType<typeof parseNumstat>
    patchArgs: readonly string[]
    signal: AbortSignal
    onProgress?: (progress: LocalReviewProgress) => void
    reviewId: string
    title: string
    baseRefName: string
    headRefName: string
    baseOid: string
    headOid: string
  }): Promise<LocalReviewResult> {
    const { churnEntries, patchArgs, signal, onProgress, reviewId } = options
    const oversized = selectOversizedDiffFiles(churnEntries)
    const churnFiles = diffFilesFromChurn(churnEntries)
    const omittedPaths = new Set(oversized.omittedFiles.map((file) => file.path))
    const omittedFiles = churnFiles.filter((file) => omittedPaths.has(file.path))
    const includedGroups = churnFiles.flatMap((file) =>
      omittedPaths.has(file.path) ? [] : [pathspecGroupForFile(file)]
    )
    const streamed = onProgress != null
    const expectedFileCount = churnFiles.length
    const buildReview = (
      files: PullRequestFile[],
      patch: string,
      reviewOmitted: OmittedDiffFile[]
    ): LocalBranchReview => ({
      kind: 'local',
      id: reviewId,
      title: options.title,
      baseRefName: options.baseRefName,
      headRefName: options.headRefName,
      baseOid: options.baseOid,
      headOid: options.headOid,
      files,
      patch,
      omittedFiles: reviewOmitted,
      expectedFileCount
    })
    if (includedGroups.length === 0) {
      const review = buildReview(churnFiles, '', oversized.omittedFiles)
      if (streamed) {
        onProgress({ kind: 'metadata', review })
        onProgress({ kind: 'done', selector: reviewId, fileCount: expectedFileCount })
      }
      return { review, patchParts: [] }
    }
    // Each page is parsed once and its files kept. Every page is already limited
    // and the join only adds a newline between them, so re-scanning the joined
    // patch found nothing new and cost as much again as all the pages together.
    const patchFiles = new Map<string, PullRequestFile>()
    const readPageFiles = (patch: string): PullRequestFile[] => {
      const pageFiles = new Map(filesFromPatch(patch).map((file) => [file.path, file]))
      for (const [path, file] of pageFiles) patchFiles.set(path, file)
      return this.#mergeChurnPatchFiles(churnFiles, pageFiles)
    }

    const { first, rest } = isolateFirstPathspecGroup(includedGroups)
    const firstWork = this.#diffPathspecPatch(patchArgs, first ?? [], signal)
    const restWork = mapWithConcurrency(
      chunkPathspecGroups(rest),
      MAX_PATCH_COMMAND_CONCURRENCY,
      (chunk) => this.#diffPathspecPatch(patchArgs, chunk, signal)
    )
    try {
      const firstLimited = limitPatchFileSize(await firstWork, MAX_DIFF_FILE_BYTES)
      if (signal.aborted) throw new Error(COMMAND_ABORTED_MESSAGE)
      const firstOmitted = [...oversized.omittedFiles, ...firstLimited.omittedFiles]
      const firstFiles = [...readPageFiles(firstLimited.patch), ...omittedFiles]
      if (streamed) {
        onProgress({
          kind: 'metadata',
          review: buildReview(firstFiles, firstLimited.patch, firstOmitted)
        })
      }

      const restPatches = await restWork
      if (signal.aborted) throw new Error(COMMAND_ABORTED_MESSAGE)
      const restOmitted: OmittedDiffFile[] = []
      const restParts: string[] = []
      for (const part of restPatches) {
        const limited = limitPatchFileSize(part, MAX_DIFF_FILE_BYTES)
        restOmitted.push(...limited.omittedFiles)
        if (limited.patch === '' && limited.omittedFiles.length === 0) continue
        if (limited.patch !== '') restParts.push(limited.patch)
        const pageFiles = readPageFiles(limited.patch)
        if (streamed) {
          onProgress({
            kind: 'files',
            selector: reviewId,
            patch: limited.patch,
            files: pageFiles,
            omittedFiles: limited.omittedFiles
          })
        }
      }

      const files = churnFiles.map((file) => ({ ...file, ...patchFiles.get(file.path) }))
      const review = buildReview(files, '', [...firstOmitted, ...restOmitted])
      if (streamed) onProgress({ kind: 'done', selector: reviewId, fileCount: expectedFileCount })
      return {
        review,
        patchParts: [firstLimited.patch, ...restParts].filter((part) => part !== '')
      }
    } catch (error) {
      await restWork.catch(() => {})
      throw error
    }
  }

  async fetchRemote(): Promise<GitIntegrationSnapshot> {
    this.#requireGitRepository()
    await this.#git(['fetch', '--all', '--prune'])
    // The renderer keeps its pull request list and refreshes it on its own;
    // waiting on `gh` here only delayed the ahead/behind the reader asked for.
    return this.getGitIntegration({ pullRequests: false })
  }

  async pullCurrentBranch(): Promise<RepositorySnapshot> {
    this.#requireGitRepository()
    await this.#writingIndex(() => this.#git(['pull', '--ff-only']))
    this.#mutation += 1
    return this.refresh()
  }

  async pushCurrentBranch(): Promise<GitIntegrationSnapshot> {
    this.#requireGitRepository()
    const snapshot = this.#requireSnapshot()
    const branch = snapshot.branch
    if (branch == null) throw new Error('The repository is not on a local branch.')
    const upstreamResult = await this.#gitAllowFailure(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    if (upstreamResult == null) {
      const remotesResult = await this.#git(['remote'])
      const remotes = remotesResult.stdout.toString('utf8').split('\n').filter(Boolean)
      const remote = remotes.includes('origin') ? 'origin' : remotes[0]
      if (remote == null) throw new Error('Add a Git remote before pushing this branch.')
      await this.#git(['push', '--set-upstream', remote, branch])
    } else {
      await this.#git(['push'])
    }
    return this.getGitIntegration({ pullRequests: false })
  }

  /**
   * Stage, unstage and discard take repository paths the snapshot already lists
   * as changed, and act on the status entries behind them: which paths each
   * operation names is decided per entry by `indexPathspecs`. Pathspecs travel
   * on stdin, NUL-separated and literal: a thousand-file "Stage All" stays one
   * spawn, and a path that looks like a glob or an option is still only that path.
   */
  #changedEntries(pathsValue: unknown): RepositoryStatusEntry[] {
    if (!Array.isArray(pathsValue) || pathsValue.length === 0 || pathsValue.length > this.#statusByPath.size) {
      throw new Error('Select changed files to update.')
    }
    const entries = new Map<string, RepositoryStatusEntry>()
    for (const path of pathsValue) {
      const entry = typeof path === 'string' ? this.#statusByPath.get(path) : undefined
      if (entry == null) throw new Error('A selected file is no longer changed. Refresh and try again.')
      entries.set(entry.path, entry)
    }
    return [...entries.values()]
  }

  // The watcher's self-write window is one second. Arming it before and after a
  // command still left the middle of anything slower — a commit hook, a pull, a
  // checkout — unannounced, and each index write landing there refreshed the
  // whole tree while the caller's own refresh was about to run. So the window
  // is held open for as long as any index write is in flight, then re-armed
  // once more for the event that lands just after it exits.
  async #writingIndex<Result>(command: () => Promise<Result>): Promise<Result> {
    this.#indexWritesInFlight += 1
    this.#selfWriteObserver?.(GIT_INDEX_PATH)
    if (this.#indexWriteHeartbeat == null) {
      this.#indexWriteHeartbeat = setInterval(
        () => this.#selfWriteObserver?.(GIT_INDEX_PATH),
        SELF_WRITE_HEARTBEAT_MS
      )
      this.#indexWriteHeartbeat.unref?.()
    }
    try {
      return await command()
    } finally {
      this.#indexWritesInFlight -= 1
      if (this.#indexWritesInFlight === 0) this.#stopIndexWriteHeartbeat()
      this.#selfWriteObserver?.(GIT_INDEX_PATH)
    }
  }

  #stopIndexWriteHeartbeat(): void {
    if (this.#indexWriteHeartbeat == null) return
    clearInterval(this.#indexWriteHeartbeat)
    this.#indexWriteHeartbeat = null
  }

  async #gitWithPathspecs(args: readonly string[], pathspecs: readonly string[]): Promise<void> {
    // An empty pathspec file is no pathspec at all, which `add -A` reads as the
    // whole tree.
    if (pathspecs.length === 0) return
    await this.#writingIndex(() => runCommand(
      'git',
      ['-C', this.#requireRoot(), '-c', 'core.quotePath=false', ...args, '--pathspec-from-file=-', '--pathspec-file-nul'],
      undefined,
      [],
      pathspecs.map((path) => `:(literal)${path}`).join('\0')
    ))
  }

  async stagePaths(pathsValue: unknown): Promise<RepositorySnapshot> {
    this.#requireGitRepository()
    const pathspecs = indexPathspecs(this.#changedEntries(pathsValue), 'stage')
    // `-A` so a deleted file stages its removal instead of failing the batch.
    await this.#gitWithPathspecs(['add', '-A'], pathspecs)
    this.#mutation += 1
    return this.refresh()
  }

  async unstagePaths(pathsValue: unknown): Promise<RepositorySnapshot> {
    this.#requireGitRepository()
    const pathspecs = indexPathspecs(this.#changedEntries(pathsValue), 'unstage')
    if (this.#snapshot?.head == null) {
      // Before the first commit there is no HEAD to restore the index from, so
      // unstaging means dropping the entries; the files stay on disk.
      await this.#gitWithPathspecs(['rm', '--cached', '-r', '-q', '--ignore-unmatch'], pathspecs)
    } else {
      await this.#gitWithPathspecs(['restore', '--staged'], pathspecs)
    }
    this.#mutation += 1
    return this.refresh()
  }

  /**
   * Throws away the working-tree side only, like VS Code's Discard: a tracked
   * file goes back to what is staged (or HEAD), an untracked one is deleted.
   * Staged work survives, so a partial file loses just its unstaged edits.
   */
  async discardPaths(pathsValue: unknown): Promise<RepositorySnapshot> {
    this.#requireGitRepository()
    const entries = this.#changedEntries(pathsValue)
    const root = this.#requireRoot()
    // Classified by the entry that was picked, not by looking every pathspec up
    // again: a rename's original path can also be listed on its own as
    // untracked, and the lookup deleted that file too.
    const tracked = indexPathspecs(entries.filter((entry) => entry.status !== 'untracked'), 'discard')
    // An intent-to-add file has nothing in the index to go back to, so it goes
    // the way an untracked one does, once its placeholder entry is dropped.
    const intentToAdd = entries.filter(isIntentToAdd).map((entry) => entry.path)
    // Every target is checked before anything is touched, so a path that
    // escapes the root, or a folder that cannot go, fails the whole discard
    // instead of half of it.
    const untrackedTargets = await Promise.all(entries
      .filter((entry) => entry.status === 'untracked' || isIntentToAdd(entry))
      .map((entry) => this.#untrackedDiscardTarget(root, entry.path)))
    try {
      await this.#gitWithPathspecs(['rm', '--cached', '-q', '--ignore-unmatch'], intentToAdd)
      if (tracked.length > 0) await this.#gitWithPathspecs(['restore', '--worktree'], tracked)
      // `git clean` takes no pathspec file, and these are plain files the status
      // walk listed one by one, so they are removed directly. One `unlink` at a
      // time spent 670 ms on 10k files; a few in flight halve it, and more only
      // queue behind the same thread pool the comparison reads use.
      await mapWithConcurrency(untrackedTargets, DISCARD_UNLINK_CONCURRENCY, async ({ path, target, directory }) => {
        try {
          // `rm` removes a symlink inside the folder rather than following it
          // out of the repository.
          if (directory) await rm(target, { recursive: true, force: true })
          else await unlink(target)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw discardFailure(path, error)
        }
      })
    } finally {
      this.#mutation += 1
    }
    return this.refresh()
  }

  /**
   * The status walk lists untracked files one by one; a trailing slash is the
   * one exception, a folder git would not descend into. Unlinking one failed
   * with a bare EPERM after the tracked half of the discard had already run. A
   * nested repository is refused the way `git clean` refuses it without `-ff`:
   * its history is not this repository's to throw away.
   */
  async #untrackedDiscardTarget(
    root: string,
    path: string
  ): Promise<{ path: string; target: string; directory: boolean }> {
    const target = resolve(root, path)
    if (target === root || !isWithinRoot(root, target)) throw new Error('Discard path must stay inside the repository.')
    if (!path.endsWith('/')) return { path, target, directory: false }
    const stats = await lstat(target).catch(() => null)
    if (stats?.isDirectory() !== true) return { path, target, directory: false }
    const nestedRepository = await access(resolve(target, '.git')).then(() => true, () => false)
    if (nestedRepository) {
      throw new Error(`${path} is a separate Git repository. Delete it yourself if you mean to lose its history.`)
    }
    return { path, target, directory: true }
  }

  /**
   * `all` is the "nothing staged" commit: every change, untracked files included,
   * is staged first, the way VS Code's smart commit behaves. The message travels
   * on stdin so its quotes, newlines and leading dashes reach git untouched.
   */
  async commitChanges(request: unknown): Promise<RepositorySnapshot> {
    this.#requireGitRepository()
    const { message, amend, all } = parseCommitRequest(request)
    const args = ['-C', this.#requireRoot(), 'commit', '--cleanup=strip']
    if (amend) args.push('--amend')
    if (message === '') {
      // Refused before `all` stages anything, so a missing message changes nothing.
      if (!amend) throw new Error('Write a commit message first.')
      args.push('--no-edit')
    } else {
      args.push('-F', '-')
    }
    try {
      if (all) await this.#writingIndex(() => this.#git(['add', '-A']))
      // Hooks (lint-staged, lefthook, test runs) routinely outlast the default
      // two minutes; a commit that is still working is not a hung command.
      await this.#writingIndex(() => runCommand(
        'git',
        args,
        undefined,
        [],
        message === '' ? undefined : message,
        undefined,
        'interactive',
        { executionMs: COMMIT_EXECUTION_TIMEOUT_MS }
      ))
    } finally {
      this.#mutation += 1
    }
    return this.refresh()
  }

  // Closing a big review left up to eight `gh api` children per wave running to
  // completion for a patch that was already discarded, and on a rate-limited token
  // that budget is spent invisibly.
  cancelPullRequestReview(requestId?: string): void {
    if (requestId != null) {
      const flight = this.#reviewRequests.get(requestId)
      this.#reviewRequests.delete(requestId)
      flight?.detach(requestId)
      return
    }
    for (const flight of this.#reviewFlights.values()) flight.abort.abort()
    this.#reviewRequests.clear()
  }

  /**
   * `intent: 'warmup'` asks for the review without claiming it: the fetch is not
   * kept alive on this caller's behalf and cancelling the reader who joined it
   * still stops the paging.
   */
  async getPullRequestReview(
    selector: number | string,
    onProgress?: PullRequestProgressListener,
    requestId: string = randomUUID(),
    intent: PullRequestReviewIntent = 'foreground',
    refresh = false
  ): Promise<PullRequestReview> {
    this.#requireGitRepository()
    const normalized = normalizePullRequestSelector(selector)
    const existing = this.#reviewFlights.get(normalized)
    // A refresh joins only a flight that is itself going to GitHub. Joining one
    // that is replaying the disk cache would hand back the head the caller asked
    // to leave behind, which is exactly the bug this parameter exists to close.
    if (existing != null && !(refresh && !existing.refresh)) {
      // Whoever asked first is fetching it. Joining replays the metadata and every
      // page already emitted, so a second reader is exactly as far along as the first.
      if (intent === 'foreground') {
        existing.attach(requestId)
        this.#reviewRequests.set(requestId, existing)
      }
      existing.join(onProgress)
      try {
        const review = await existing.promise
        return pullRequestReviewReply(review, onProgress != null && existing.streamed)
      } finally {
        existing.release(onProgress)
        this.#reviewRequests.delete(requestId)
      }
    }

    // Superseding a cache replay that nobody is left watching: its revalidation
    // would otherwise land after this fetch and flag the selector stale again,
    // costing a third fetch on the next open.
    if (existing != null && !existing.foregroundAttached) existing.abort.abort()

    const flight = new PullRequestReviewFlight()
    flight.refresh = refresh
    if (intent === 'foreground') {
      flight.attach(requestId)
      this.#reviewRequests.set(requestId, flight)
    }
    flight.join(onProgress)
    this.#reviewFlights.set(normalized, flight)
    const flightLane = pullRequestReviewLane(intent)
    try {
      const review = await flight
        .start((emit) => this.#loadPullRequestReview(
          normalized,
          flight.abort.signal,
          emit,
          // A warmup that gains a foreground reader mid-flight stops queueing
          // behind speculative work — the semaphore re-reads this at every hop.
          () => (flight.foregroundAttached ? 'interactive' : flightLane),
          refresh
        ))
      return pullRequestReviewReply(review, onProgress != null && flight.streamed)
    } finally {
      if (this.#reviewFlights.get(normalized) === flight) this.#reviewFlights.delete(normalized)
      this.#reviewRequests.delete(requestId)
      flight.release(onProgress)
      flight.settle()
    }
  }

  async #loadPullRequestReview(
    normalizedSelector: string,
    signal: AbortSignal,
    emit: PullRequestProgressListener,
    lane: CommandLaneSource,
    refresh = false
  ): Promise<PullRequestReview> {
    // `#reviewsRequiringRefresh` only knows about drift a *previous* cached open
    // happened to notice. A reader adopting a pushed head knows it first hand, so
    // they say so and the cache is skipped outright.
    if (refresh || this.#reviewsRequiringRefresh.delete(normalizedSelector)) {
      return this.#fetchPullRequestReview(await getGhExecutable(), normalizedSelector, signal, emit, lane)
    }
    const cached = await this.#openCachedPullRequestReview(normalizedSelector, emit)
    if (cached == null) {
      return this.#fetchPullRequestReview(await getGhExecutable(), normalizedSelector, signal, emit, lane)
    }
    // A review already on disk opens even where `gh` cannot be found; only the
    // revalidation needs it.
    const ghExecutable = await getGhExecutable().catch(() => null)
    if (ghExecutable == null) return cached
    return this.#revalidateCachedPullRequestReview(
      ghExecutable,
      normalizedSelector,
      cached,
      signal,
      emit,
      lane
    )
  }

  /**
   * Paints a reopened pull request straight from disk. The head oid the diff was
   * stored under is unverified here — the caller revalidates it behind the paint —
   * but the diff for a given oid is immutable, so what the reader sees is a real
   * state of this pull request rather than a guess.
   */
  async #openCachedPullRequestReview(
    normalizedSelector: string,
    emit: PullRequestProgressListener
  ): Promise<PullRequestReview | null> {
    const cache = this.#pullRequestCache
    // A bare number says nothing about which pull request it is until `gh` answers,
    // so only a URL can be served from the index.
    if (cache == null || !normalizedSelector.startsWith('https://')) return null
    const index = await cache.readIndex(normalizedSelector)
    if (index == null) return null
    const entry = await cache.read(index.url, index.snapshotIdentity)
    if (entry == null) return null
    const viewerLogin = this.#githubViewerLogin
    const base: PullRequestReview = {
      kind: 'github',
      selector: normalizedSelector,
      baseOid: index.baseRefOid,
      headOid: index.headRefOid,
      commitId: index.headRefOid,
      // Asking GitHub who we are would be a third spawn on the path this exists to
      // shorten, so the stored verdict stands unless this process already knows.
      viewerCanSubmitDecision: viewerLogin == null
        ? index.viewerCanSubmitDecision
        : !isSameGitHubLogin(viewerLogin, index.summary.author.login),
      pullRequest: index.summary,
      files: [],
      patch: '',
      omittedFiles: [],
      expectedFileCount: entry.files.length,
      snapshotIdentity: index.snapshotIdentity
    }
    emit({ kind: 'metadata', selector: normalizedSelector, review: base })
    // Paged like a fresh download. One event carrying a 3,000-file patch was a
    // single structured clone and a single renderer task for all of it.
    for (const page of cachedPullRequestPages(entry)) {
      emit({ kind: 'files', selector: normalizedSelector, ...page })
    }
    emit({ kind: 'done', selector: normalizedSelector, fileCount: entry.files.length })
    const review: PullRequestReview = {
      ...base,
      files: entry.files,
      patch: entry.patch,
      omittedFiles: entry.omittedFiles
    }
    this.#seedPullRequestIdentity(normalizedSelector, index.summary)
    this.#rememberAgentReview(review)
    return review
  }

  async #revalidateCachedPullRequestReview(
    ghExecutable: string,
    normalizedSelector: string,
    cached: PullRequestReview,
    signal: AbortSignal,
    emit: PullRequestProgressListener,
    lane: CommandLaneSource
  ): Promise<PullRequestReview> {
    this.#emitPullRequestChecks(ghExecutable, normalizedSelector, signal, emit, lane)
    let revision: { baseRefOid: string; headRefOid: string; baseRefName: string; headRefName: string } | null = null
    try {
      const result = await runGitHubReadCommand(
        ghExecutable,
        ['pr', 'view', normalizedSelector, '--json', 'baseRefOid,headRefOid,baseRefName,headRefName'],
        this.#requireRoot(),
        signal,
        lane
      )
      revision = parseJson(result, 'GitHub CLI')
    } catch {
      // Offline, rate limited or cancelled. The cached diff is immutable for the oid
      // it was stored under, so it stays on screen instead of collapsing into an error.
      return cached
    }
    if (signal.aborted || revision == null || revision.headRefOid === '') return cached
    if (revision.headRefOid === cached.headOid && revision.baseRefOid === cached.baseOid
      && revision.baseRefName === cached.pullRequest.baseRefName
      && revision.headRefName === cached.pullRequest.headRefName) return cached
    const available = pullRequestSnapshotIdentity({
      ...cached,
      baseOid: revision.baseRefOid,
      headOid: revision.headRefOid,
      commitId: revision.headRefOid,
      pullRequest: {
        ...cached.pullRequest,
        baseRefName: revision.baseRefName,
        headRefName: revision.headRefName
      }
    })
    // Preserve the current immutable world. The next explicit open is the user's
    // adoption point and bypasses the stale URL index once.
    this.#reviewsRequiringRefresh.add(normalizedSelector)
    emit({ kind: 'revisionAvailable', selector: normalizedSelector, snapshotIdentity: available })
    return cached
  }

  async #fetchPullRequestReview(
    ghExecutable: string,
    normalizedSelector: string,
    signal: AbortSignal,
    emit: PullRequestProgressListener,
    lane: CommandLaneSource,
    attempt = 0
  ): Promise<PullRequestReview> {
    const collectedFiles: PullRequestFile[] = []
    const collectedOmitted: OmittedDiffFile[] = []
    const patchParts: string[] = []
    const staged: PullRequestPatchPage[] = []
    let opened = false
    let emittedPage = false
    const publish = (page: PullRequestPatchPage): void => {
      const limited = limitPatchFileSize(page.patch, MAX_DIFF_FILE_BYTES)
      patchParts.push(limited.patch)
      collectedFiles.push(...page.files)
      collectedOmitted.push(...page.omittedFiles, ...limited.omittedFiles)
      emittedPage = true
      emit({
        kind: 'files',
        selector: normalizedSelector,
        patch: limited.patch,
        files: page.files,
        omittedFiles: [...page.omittedFiles, ...limited.omittedFiles]
      })
    }
    // A page cannot be shown before the event that opens the review, and the diff
    // now starts before that event, so early pages wait here rather than being lost.
    const collect = (page: PullRequestPatchPage): void => {
      if (opened) publish(page)
      else staged.push(page)
    }

    // `gh pr diff` needs no oid, so it runs alongside the metadata hop instead of
    // queueing behind it. That serial pair was most of the wait on a fresh review.
    const diffAbort = new AbortController()
    const abortDiff = (): void => diffAbort.abort()
    signal.addEventListener('abort', abortDiff, { once: true })
    const diffRun = this
      .#collectPullRequestDiff(ghExecutable, normalizedSelector, diffAbort.signal, collect, lane)
      .then(
        (outcome) => ({ outcome, error: null as unknown }),
        (error: unknown) => ({ outcome: 'failed' as const, error })
      )

    try {
      const [detailsResult, viewerLogin] = await Promise.all([
        runGitHubReadCommand(
          ghExecutable,
          ['pr', 'view', normalizedSelector, '--json', PULL_REQUEST_REVIEW_FIELDS],
          this.#requireRoot(),
          signal,
          lane
        ),
        this.#getGitHubViewerLogin(ghExecutable, lane)
      ])
      const details = parseJson<RawPullRequestSummary & {
        baseRefOid: string
        headRefOid: string
      }>(detailsResult, 'GitHub CLI')
      const { baseRefOid, headRefOid, ...rest } = details
      const pullRequest = toPullRequestSummary(rest)
      this.#seedPullRequestIdentity(normalizedSelector, pullRequest)
      // The files API stops answering at 3000 files however many GitHub reports, so a
      // review of a bigger pull request is climbing towards the ceiling, not the count.
      const expectedFileCount = Math.min(
        MAX_PULL_REQUEST_FILES,
        Number.isFinite(pullRequest.changedFiles) ? Number(pullRequest.changedFiles) : 0
      )
      let summary = pullRequest
      const checksRun = this.#loadPullRequestChecks(ghExecutable, normalizedSelector, signal, lane)
      void checksRun.then((result) => {
        if (result == null) return
        summary = { ...pullRequest, checks: result.checks, mergeable: result.mergeable }
        if (signal.aborted) return
        emit({
          kind: 'checks',
          selector: normalizedSelector,
          checks: result.checks,
          mergeable: result.mergeable
        })
      })
      const base: PullRequestReview = {
        kind: 'github',
        selector: normalizedSelector,
        baseOid: baseRefOid,
        headOid: headRefOid,
        commitId: headRefOid,
        viewerCanSubmitDecision: !isSameGitHubLogin(viewerLogin, pullRequest.author.login),
        pullRequest,
        files: [],
        patch: '',
        omittedFiles: [],
        expectedFileCount,
        snapshotIdentity: undefined
      }
      const identity = pullRequestSnapshotIdentity(base)
      base.snapshotIdentity = identity
      emit({ kind: 'metadata', selector: normalizedSelector, review: base })

      const cached = await this.#pullRequestCache?.read(pullRequest.url, identity) ?? null
      if (cached != null) {
        // No files event: the whole patch is already in hand, so emitting it here
        // and returning it from the same call would clone up to the entire review
        // over IPC twice in one tick. The renderer adopts the resolved review.
        diffAbort.abort()
        staged.length = 0
        const review: PullRequestReview = {
          ...base,
          pullRequest: summary,
          files: cached.files,
          patch: cached.patch,
          omittedFiles: cached.omittedFiles,
          expectedFileCount: cached.files.length
        }
        // The entry predates the URL index, or the index was swept. Writing it back
        // is what turns the next open of this pull request into a disk read.
        if (!signal.aborted) await this.#pullRequestCache?.write(pullRequest.url, headRefOid, review)
        this.#rememberAgentReview(review)
        return review
      }

      opened = true
      for (const page of staged.splice(0)) publish(page)

      if (expectedFileCount > PULL_REQUEST_FILES_API_THRESHOLD) {
        // A diff document this size has to arrive in full before a single file can be
        // shown; the files API streams, and the identity it needs is already seeded.
        diffAbort.abort()
        await diffRun
        if (!emittedPage && !signal.aborted) {
          await this.#collectPullRequestPatchFromFilesApi(ghExecutable, normalizedSelector, signal, publish, lane)
        }
      } else {
        const result = await diffRun
        if (result.error != null) throw result.error
        if (result.outcome === 'too-large' && !signal.aborted) {
          await this.#collectPullRequestPatchFromFilesApi(ghExecutable, normalizedSelector, signal, publish, lane)
        }
      }

      const review: PullRequestReview = {
        ...base,
        pullRequest: summary,
        files: collectedFiles,
        patch: patchParts.join(''),
        omittedFiles: collectedOmitted
      }
      const validated = await this.#readPullRequestRevision(
        ghExecutable,
        normalizedSelector,
        signal,
        lane
      )
      const stable = validated.baseRefOid === baseRefOid
        && validated.headRefOid === headRefOid
        && validated.baseRefName === pullRequest.baseRefName
        && validated.headRefName === pullRequest.headRefName
      if (!stable) {
        if (attempt === 0 && !signal.aborted) {
          return this.#fetchPullRequestReview(
            ghExecutable,
            normalizedSelector,
            signal,
            emit,
            lane,
            1
          )
        }
        throw new Error('The pull request changed while Kodi was loading it. Refresh and try again.')
      }
      if (emittedPage) {
        emit({ kind: 'done', selector: normalizedSelector, fileCount: collectedFiles.length })
      }
      if (!signal.aborted) await this.#pullRequestCache?.write(pullRequest.url, headRefOid, review)
      this.#rememberAgentReview(review)
      return review
    } finally {
      diffAbort.abort()
      signal.removeEventListener('abort', abortDiff)
    }
  }

  async #readPullRequestRevision(
    ghExecutable: string,
    selector: string,
    signal: AbortSignal,
    lane: CommandLaneSource
  ): Promise<{ baseRefOid: string; headRefOid: string; baseRefName: string; headRefName: string }> {
    const result = await runGitHubReadCommand(
      ghExecutable,
      ['pr', 'view', selector, '--json', 'baseRefOid,headRefOid,baseRefName,headRefName'],
      this.#requireRoot(),
      signal,
      lane
    )
    return parseJson(result, 'GitHub CLI')
  }

  // The identity never changes and the metadata hop already carries it. Resolving it
  // again cost a second `gh pr view` on every paged review and every conversation poll.
  #seedPullRequestIdentity(selector: string, pullRequest: PullRequestSummary): void {
    if (!Number.isSafeInteger(pullRequest.number) || pullRequest.number < 1) return
    const slug = githubRepoSlugFromRemoteUrl(pullRequest.url.replace(/\/pull\/\d+.*$/, ''))
    const [owner, name] = slug?.split('/') ?? []
    if (owner == null || name == null) return
    const identity = { owner, name, number: pullRequest.number }
    this.#pullRequestIdentities.set(selector, identity)
    this.#pullRequestIdentities.set(pullRequest.url, identity)
  }

  // Check data is optional garnish, so an unsupported field costs the chips instead
  // of the whole response. An older `gh` rejects the command outright and the retry
  // costs a second spawn, so the answer is remembered — on the service rather than
  // the module, where one degraded call used to degrade every later one in the
  // process, tests included.
  async #loadPullRequestChecks(
    ghExecutable: string,
    selector: string,
    signal: AbortSignal,
    lane: CommandLaneSource
  ): Promise<{ checks: PullRequestChecks | null; mergeable: string | null } | null> {
    if (!this.#checkFieldsSupported) return null
    try {
      const result = await runGitHubReadCommand(
        ghExecutable,
        ['pr', 'view', selector, '--json', PULL_REQUEST_CHECK_FIELDS],
        this.#requireRoot(),
        signal,
        lane
      )
      const raw = parseJson<{ statusCheckRollup?: unknown; mergeable?: unknown }>(result, 'GitHub CLI')
      return {
        checks: summarizeCheckRollup(raw.statusCheckRollup),
        mergeable: typeof raw.mergeable === 'string' ? raw.mergeable : null
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/unknown json field/i.test(message)) this.#checkFieldsSupported = false
      return null
    }
  }

  #emitPullRequestChecks(
    ghExecutable: string,
    selector: string,
    signal: AbortSignal,
    emit: PullRequestProgressListener,
    lane: CommandLaneSource
  ): void {
    void this.#loadPullRequestChecks(ghExecutable, selector, signal, lane).then((result) => {
      if (result == null || signal.aborted) return
      emit({ kind: 'checks', selector, checks: result.checks, mergeable: result.mergeable })
    })
  }

  /**
   * One diff document is the fast path; a pull request too big for GitHub to render
   * as a single diff is rebuilt from the paged files API instead of failing to open.
   */
  async #collectPullRequestDiff(
    ghExecutable: string,
    selector: string,
    signal: AbortSignal,
    emit: (page: PullRequestPatchPage) => void,
    lane: CommandLaneSource
  ): Promise<'complete' | 'aborted' | 'too-large'> {
    try {
      const diffResult = await runGitHubReadCommand(
        ghExecutable,
        ['pr', 'diff', selector, '--color', 'never'],
        this.#requireRoot(),
        signal,
        lane
      )
      if (signal.aborted) return 'aborted'
      const patch = diffResult.stdout.toString('utf8')
      for (const page of chunkPatchByFileCount(patch)) {
        emit({
          patch: page,
          files: filesFromPatch(page),
          omittedFiles: []
        })
      }
      return 'complete'
    } catch (error) {
      if (signal.aborted) return 'aborted'
      if (isPullRequestDiffTooLargeError(error)) return 'too-large'
      throw error
    }
  }

  async #collectPullRequestPatchFromFilesApi(
    ghExecutable: string,
    selector: string,
    signal: AbortSignal,
    emit: (page: PullRequestPatchPage) => void,
    lane: CommandLaneSource
  ): Promise<void> {
    const { owner, name, number } = await this.#resolvePullRequestIdentity(ghExecutable, selector, lane)
    const readPage = async (page: number): Promise<RawPullRequestFile[]> => {
      const result = await runGitHubReadCommand(
        ghExecutable,
        [
          'api',
          `repos/${owner}/${name}/pulls/${number}/files?per_page=${PULL_REQUEST_FILES_PAGE_SIZE}&page=${page}`
        ],
        this.#requireRoot(),
        signal,
        lane
      )
      const pageFiles = parseJson<RawPullRequestFile[]>(result, 'GitHub')
      return Array.isArray(pageFiles) ? pageFiles : []
    }

    const concurrency = 4
    const maxPages = MAX_PULL_REQUEST_FILES / PULL_REQUEST_FILES_PAGE_SIZE
    const inFlight = new Map<number, Promise<{ page: number; files: RawPullRequestFile[] }>>()
    const completed = new Map<number, RawPullRequestFile[]>()
    let nextToSchedule = 1
    let nextToPublish = 1
    let terminalPage = maxPages + 1
    const schedule = (): void => {
      while (!signal.aborted && inFlight.size < concurrency && nextToSchedule <= maxPages
        && nextToSchedule < terminalPage) {
        const page = nextToSchedule++
        inFlight.set(page, readPage(page).then((files) => ({ page, files })))
      }
    }
    schedule()
    while (inFlight.size > 0 && !signal.aborted) {
      const result = await Promise.race(inFlight.values())
      inFlight.delete(result.page)
      completed.set(result.page, result.files)
      if (result.files.length === 0) terminalPage = Math.min(terminalPage, result.page)
      while (completed.has(nextToPublish)) {
        const files = completed.get(nextToPublish) ?? []
        completed.delete(nextToPublish)
        if (nextToPublish >= terminalPage || files.length === 0) return
        emit(buildPullRequestPatchFromFiles(files))
        nextToPublish += 1
      }
      schedule()
    }
  }

  async checkoutPullRequest(number: number): Promise<RepositorySnapshot> {
    this.#requireGitRepository()
    requirePullRequestNumber(number)
    const ghExecutable = await getGhExecutable()
    await this.#writingIndex(() => runCommand(ghExecutable, ['pr', 'checkout', String(number)], this.#requireRoot()))
    this.#mutation += 1
    return this.refresh()
  }

  async submitPullRequestReview(
    selector: number | string,
    commitIdValue: unknown,
    reviewEvent: string,
    body: string,
    commentsValue: unknown
  ): Promise<void> {
    this.#requireGitRepository()
    const normalizedSelector = normalizePullRequestSelector(selector)
    const payload = createPullRequestReviewPayload(commitIdValue, reviewEvent, body, commentsValue)
    const ghExecutable = await getGhExecutable()
    const [targetResult, viewerLogin] = await Promise.all([
      runGitHubReadCommand(
        ghExecutable,
        ['pr', 'view', normalizedSelector, '--json', 'id,number,url,headRefOid,author'],
        this.#requireRoot()
      ),
      this.#getGitHubViewerLogin(ghExecutable)
    ])
    const targetDetails = parseJson<{
      id: string
      number: number
      url: string
      headRefOid: string
      author: { login: string }
    }>(targetResult, 'GitHub CLI')
    if (targetDetails.headRefOid !== commitIdValue) {
      throw new Error('This pull request has new commits since you opened it. Load the new commits from the toolbar, then submit again — your review and comments are kept.')
    }
    if (typeof targetDetails.id !== 'string' || targetDetails.id === '' || targetDetails.id.length > 256) {
      throw new Error('GitHub returned an invalid pull request ID.')
    }
    validatePullRequestTarget(targetDetails.url, targetDetails.number)
    // A pasted URL would otherwise submit a review to a repository that is not the open one.
    const remotes = await this.getRemotes()
    if (!pullRequestTargetsRemotes(remotes, targetDetails.url)) {
      throw new Error('This pull request belongs to a different repository than the open one.')
    }
    if (reviewEvent !== 'comment' && isSameGitHubLogin(viewerLogin, targetDetails.author.login)) {
      throw new Error(SELF_REVIEW_DECISION_ERROR)
    }
    try {
      await runGitHubMutation(() => runCommand(
        ghExecutable,
        ['api', 'graphql', '--input', '-'],
        this.#requireRoot(),
        [],
        JSON.stringify({
          query: ADD_PULL_REQUEST_REVIEW_MUTATION,
          variables: {
            input: {
              pullRequestId: targetDetails.id,
              ...payload
            }
          }
        }),
        undefined,
        'interactive',
        { executionMs: 60_000 }
      ))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/can not (?:approve|request changes on) your own pull request/i.test(message)) {
        throw new Error(SELF_REVIEW_DECISION_ERROR)
      }
      throw error
    }
  }

  async #getGitHubViewerLogin(ghExecutable: string, lane: CommandLaneSource = 'interactive'): Promise<string> {
    if (this.#githubViewerLogin != null && Date.now() - this.#githubViewerResolvedAt < CONVERSATION_CACHE_TTL_MS) {
      return this.#githubViewerLogin
    }
    const result = await runGitHubReadCommand(
      ghExecutable,
      ['api', 'user', '--jq', '.login'],
      this.#requireRoot(),
      undefined,
      lane
    )
    const login = result.stdout.toString('utf8').trim()
    const containsControlCharacter = [...login].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
    if (login === '' || login.length > 64 || containsControlCharacter) {
      throw new Error('GitHub returned an invalid viewer login.')
    }
    this.#githubViewerLogin = login
    this.#githubViewerResolvedAt = Date.now()
    return login
  }

  async #getGitHubAccountId(ghExecutable: string): Promise<string> {
    if (this.#githubAccountId != null && Date.now() - this.#githubAccountResolvedAt < CONVERSATION_CACHE_TTL_MS) {
      return this.#githubAccountId
    }
    const result = await runGitHubReadCommand(
      ghExecutable,
      ['api', 'user', '--jq', '.id'],
      this.#requireRoot()
    )
    const accountId = result.stdout.toString('utf8').trim()
    if (!/^\d{1,32}$/.test(accountId)) throw new Error('GitHub returned an invalid account ID.')
    if (this.#githubAccountId != null && this.#githubAccountId !== accountId) this.#githubAuthEpoch += 1
    this.#githubAccountId = accountId
    this.#githubAccountResolvedAt = Date.now()
    return accountId
  }

  async #readHeadFile(
    path: string,
    head: string | null
  ): Promise<ReadVersion | null> {
    if (head == null) return null
    const object = `${head}:${path}`
    const cachedEntry = this.#headFileCache.get(object)
    if (cachedEntry != null) {
      this.#headFileCache.delete(object)
      this.#headFileCache.set(object, cachedEntry)
      return cachedEntry.promise
    }

    const entry = { promise: Promise.resolve<ReadVersion | null>(null), bytes: 0 }
    // Concurrent loads must charge their announced size before the content is read,
    // otherwise the byte cap only applies after every in-flight load has resolved.
    const chargeBytes = (bytes: number): void => {
      if (this.#headFileCache.get(object) !== entry) return
      this.#headFileCacheBytes += bytes - entry.bytes
      entry.bytes = bytes
      this.#evictHeadFileCache()
    }
    entry.promise = this.#loadHeadFile(path, object, chargeBytes).then((version) => {
      const fileBytes = version?.file == null ? 0 : Buffer.byteLength(version.file.contents, 'utf8')
      chargeBytes(fileBytes + (version?.image?.byteLength ?? 0))
      return version
    }).catch((error: unknown) => {
      if (this.#headFileCache.get(object) === entry) this.#deleteHeadCacheEntry(object)
      throw error
    })
    this.#headFileCache.set(object, entry)
    this.#evictHeadFileCache()
    return entry.promise
  }

  async #loadHeadFile(
    path: string,
    object: string,
    chargeBytes: (bytes: number) => void
  ): Promise<ReadVersion | null> {
    this.#requireGitRepository()
    let read: GitObjectRead
    try {
      read = await this.#readObject(object)
    } catch {
      // A HEAD side that cannot be read reads as "no previous version", which is
      // what the two-spawn version did when the size probe failed.
      return null
    }
    // A gitlink resolves to the submodule's commit object. Rendering its body as
    // the old side turned every submodule into a deleted file full of plumbing.
    if (read.missing || read.type !== 'blob') return null
    if (read.oversized) return { file: null, binary: false, oversized: true }
    chargeBytes(read.size)

    const contents = read.contents ?? Buffer.alloc(0)
    const looksBinary = isBinary(contents)
    const image = createImagePreviewSide(path, contents, looksBinary)
    const binary = looksBinary || image != null
    return { file: binary ? null : toDiffFile(path, contents), binary, oversized: false, image }
  }

  async #readWorkingFile(
    path: string,
    root: string,
    bypassCache = false
  ): Promise<WorkingFileRead | null> {
    const candidate = resolve(root, path)
    if (!isWithinRoot(root, candidate)) throw new Error('The selected path escapes the repository.')

    let metadata
    try {
      metadata = await lstat(candidate)
    } catch {
      this.#deleteWorkingCacheEntry(path)
      return null
    }

    // Identity as well as timestamps: a same-millisecond rewrite of the same size
    // would otherwise be served from the cache.
    const revision = `${metadata.mtimeMs}:${metadata.ctimeMs}:${metadata.size}:${metadata.ino}`
    if (!bypassCache) {
      const cached = this.#workingFileCache.get(path)
      if (cached != null && cached.read.revision === revision) {
        this.#workingFileCache.delete(path)
        this.#workingFileCache.set(path, cached)
        return cached.read
      }
    }

    const read = await this.#loadWorkingFile(path, candidate, root, metadata, revision)
    if (read != null) this.#storeWorkingFile(path, read)
    return read
  }

  async #loadWorkingFile(
    path: string,
    candidate: string,
    root: string,
    metadata: Awaited<ReturnType<typeof lstat>>,
    revision: string
  ): Promise<WorkingFileRead | null> {
    if (metadata.isSymbolicLink()) {
      const linkTarget = Buffer.from(await readlink(candidate), 'utf8')
      return {
        contents: linkTarget,
        file: toDiffFile(path, linkTarget),
        binary: false,
        oversized: false,
        revision
      }
    }
    if (!metadata.isFile()) return null
    if (metadata.size > MAX_DIFF_FILE_BYTES) {
      return { contents: null, file: null, binary: false, oversized: true, revision }
    }

    const resolvedPath = await realpath(candidate)
    if (!isWithinRoot(root, resolvedPath)) throw new Error('The selected file resolves outside the repository.')
    const contents = await readFile(resolvedPath)
    const looksBinary = isBinary(contents)
    const image = createImagePreviewSide(path, contents, looksBinary)
    const binary = looksBinary || image != null
    return {
      contents,
      file: binary ? null : toDiffFile(path, contents),
      binary,
      oversized: false,
      revision,
      image
    }
  }

  #storeWorkingFile(path: string, read: WorkingFileRead): void {
    const bytes = read.contents?.byteLength ?? 0
    this.#deleteWorkingCacheEntry(path)
    this.#workingFileCache.set(path, { read, bytes })
    this.#workingFileCacheBytes += bytes
    while (
      this.#workingFileCache.size > MAX_WORKING_CACHE_ENTRIES
      || this.#workingFileCacheBytes > MAX_WORKING_CACHE_BYTES
    ) {
      const oldest = this.#workingFileCache.keys().next().value
      if (oldest == null || oldest === path) return
      this.#deleteWorkingCacheEntry(oldest)
    }
  }

  #deleteWorkingCacheEntry(path: string): void {
    const entry = this.#workingFileCache.get(path)
    if (entry == null) return
    this.#workingFileCacheBytes -= entry.bytes
    this.#workingFileCache.delete(path)
  }

  #readObject(object: string): Promise<GitObjectRead> {
    const root = this.#requireRoot()
    if (this.#objectReader == null) this.#objectReader = new GitObjectReader(root)
    return this.#objectReader.read(object)
  }

  getRemotes(): Promise<GitRemote[]> {
    this.#requireGitRepository()
    if (this.#remotes === undefined) {
      const request = this.#git(['remote', '-v']).then(parseRemotes)
      this.#remotes = request
      void request.catch(() => {
        if (this.#remotes === request) this.#remotes = undefined
      })
    }
    return this.#remotes
  }

  async #git(args: readonly string[], signal?: AbortSignal, lane: CommandLaneSource = 'interactive'): Promise<CommandResult> {
    if (this.#kind !== 'git') throw new Error('The open folder is not a Git repository.')
    return runCommand('git', ['-C', this.#requireRoot(), ...args], undefined, [], undefined, signal, lane)
  }

  #requireGitRepository(): void {
    if (this.#kind !== 'git') throw new Error('The open folder is not a Git repository.')
  }

  async #gitAllowFailure(args: readonly string[]): Promise<CommandResult | null> {
    try {
      return await this.#git(args)
    } catch {
      return null
    }
  }

  #setSnapshot(snapshot: RepositorySnapshot): void {
    if (this.#snapshot?.root !== snapshot.root || this.#snapshot?.head !== snapshot.head) {
      this.#clearHeadFileCache()
    }
    // Rebuilding the set costs ~5 ms per refresh at 100k paths, and the watcher's
    // steady-state tick hands back the same array `#visiblePaths` already reused.
    const samePaths = this.#snapshot?.paths === snapshot.paths
    if (!samePaths) this.#pathSet = new Set(snapshot.paths)
    // Stamped on the snapshot itself because every caller hands this exact
    // object on — to the watcher, to IPC replies, to the renderer. One counter
    // for the whole process, so a reopened session never reuses a number a
    // window still holds under a different list.
    const heldRevision = samePaths ? this.#snapshot?.pathsRevision : undefined
    snapshot.pathsRevision = heldRevision ?? nextPathsRevision()
    this.#snapshot = snapshot
    this.#snapshotRevision += 1
    this.#statusByPath = new Map(snapshot.statuses.map((status) => [status.path, status]))
  }

  #cancelActiveSearch(): void {
    const search = this.#activeSearch
    if (search == null) return
    search.cancelled = true
    this.#contentSearchMetrics.cancelled += 1
    for (const child of search.children) child.kill()
    this.#activeSearch = null
  }

  #deleteHeadCacheEntry(object: string): void {
    const entry = this.#headFileCache.get(object)
    if (entry == null) return
    this.#headFileCacheBytes -= entry.bytes
    this.#headFileCache.delete(object)
  }

  #evictHeadFileCache(): void {
    while (
      this.#headFileCache.size > MAX_HEAD_CACHE_ENTRIES
      || this.#headFileCacheBytes > MAX_HEAD_CACHE_BYTES
    ) {
      const oldestObject = this.#headFileCache.keys().next().value
      if (oldestObject == null) return
      this.#deleteHeadCacheEntry(oldestObject)
    }
  }

  #clearHeadFileCache(): void {
    this.#headFileCache.clear()
    this.#headFileCacheBytes = 0
  }

  #requireRoot(): string {
    if (this.#root == null) throw new Error('Open a folder first.')
    return this.#root
  }

  #requireSnapshot(): RepositorySnapshot {
    if (this.#snapshot == null) throw new Error('Repository data is not ready.')
    return this.#snapshot
  }
}
