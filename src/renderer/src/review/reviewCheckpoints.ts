import type { PullRequestFile, PullRequestReview } from '../../../shared/contracts'
import { parseDiffGitHeaderPaths } from '../../../shared/patchHeaders'
import {
  browserBudgetStorage,
  persistManagedValue
} from './storageBudget'

const STORAGE_PREFIX = 'kodi:review-checkpoint:'
const CHECKPOINT_VERSION = 1
const MAX_MANIFEST_FILES = 10_000
const MAX_SERIALIZED_UTF16_UNITS = 2 * 1024 * 1024
const DIFF_SECTION_PREFIX = 'diff --git '

export interface ReviewCheckpointFile {
  path: string
  signatureKind: 'blob' | 'patch' | 'fallback'
  signature: string
}

export interface ReviewCheckpoint {
  version: 1
  pullRequestUrl: string
  baseOid: string
  headOid: string
  createdAt: string
  manifest: ReviewCheckpointFile[]
}

export interface CheckpointComparison {
  changedFiles: PullRequestFile[]
  removedPaths: string[]
  uncertainPaths: string[]
}

export interface SinceReview {
  review: PullRequestReview
  patchPages?: readonly string[]
  removedPaths: string[]
  uncertainPaths: string[]
}

function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{7,64}$/i.test(value)
}

function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

export function reviewCheckpointStorageKey(root: string, pullRequestUrl: string): string {
  return `${STORAGE_PREFIX}${root}:${pullRequestUrl}`
}

export function reviewFileCheckpointSignature(file: PullRequestFile): ReviewCheckpointFile {
  if (isOid(file.headBlobOid) && file.headBlobOid.length >= 40) {
    return { path: file.path, signatureKind: 'blob', signature: `head:${file.headBlobOid.toLowerCase()}` }
  }
  if (file.headBlobOid == null && isOid(file.baseBlobOid) && file.baseBlobOid.length >= 40) {
    return { path: file.path, signatureKind: 'blob', signature: `deleted:${file.baseBlobOid.toLowerCase()}` }
  }
  if (isHash(file.patchHash)) {
    return { path: file.path, signatureKind: 'patch', signature: file.patchHash.toLowerCase() }
  }
  return {
    path: file.path,
    signatureKind: 'fallback',
    signature: `${file.additions}:${file.deletions}`
  }
}

export function createReviewCheckpoint(review: PullRequestReview, createdAt = new Date().toISOString()): ReviewCheckpoint {
  return {
    version: CHECKPOINT_VERSION,
    pullRequestUrl: review.pullRequest.url,
    baseOid: review.baseOid,
    headOid: review.headOid,
    createdAt,
    manifest: review.files.map(reviewFileCheckpointSignature)
  }
}

function isCheckpointFile(value: unknown): value is ReviewCheckpointFile {
  if (typeof value !== 'object' || value == null) return false
  const file = value as Partial<ReviewCheckpointFile>
  return typeof file.path === 'string' && file.path !== ''
    && (file.signatureKind === 'blob' || file.signatureKind === 'patch' || file.signatureKind === 'fallback')
    && typeof file.signature === 'string' && file.signature !== ''
}

export function parseStoredReviewCheckpoint(serialized: string | null): ReviewCheckpoint | null {
  if (serialized == null) return null
  try {
    const parsed = JSON.parse(serialized) as Partial<ReviewCheckpoint>
    if (parsed.version !== CHECKPOINT_VERSION
      || typeof parsed.pullRequestUrl !== 'string' || parsed.pullRequestUrl === ''
      || !isOid(parsed.baseOid) || !isOid(parsed.headOid)
      || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))
      || !Array.isArray(parsed.manifest) || parsed.manifest.length > MAX_MANIFEST_FILES
      || !parsed.manifest.every(isCheckpointFile)) return null
    return parsed as ReviewCheckpoint
  } catch {
    return null
  }
}

export function loadReviewCheckpoint(root: string, pullRequestUrl: string): ReviewCheckpoint | null {
  try {
    const checkpoint = parseStoredReviewCheckpoint(localStorage.getItem(
      reviewCheckpointStorageKey(root, pullRequestUrl)
    ))
    return checkpoint?.pullRequestUrl === pullRequestUrl ? checkpoint : null
  } catch {
    return null
  }
}

export function saveReviewCheckpoint(root: string, checkpoint: ReviewCheckpoint): boolean {
  try {
    const serialized = JSON.stringify(checkpoint)
    if (serialized.length > MAX_SERIALIZED_UTF16_UNITS || parseStoredReviewCheckpoint(serialized) == null) {
      return false
    }
    const storage = browserBudgetStorage()
    if (storage == null) return false
    return persistManagedValue(
      storage,
      reviewCheckpointStorageKey(root, checkpoint.pullRequestUrl),
      serialized
    )
  } catch {
    return false
  }
}

export function compareReviewCheckpoint(
  checkpoint: ReviewCheckpoint,
  files: readonly PullRequestFile[]
): CheckpointComparison {
  const previous = new Map(checkpoint.manifest.map((file) => [file.path, file]))
  const changedFiles: PullRequestFile[] = []
  const uncertainPaths: string[] = []

  for (const file of files) {
    const before = previous.get(file.path)
    previous.delete(file.path)
    const current = reviewFileCheckpointSignature(file)
    const uncertain = before?.signatureKind === 'fallback' || current.signatureKind === 'fallback'
    if (before == null || uncertain || before.signatureKind !== current.signatureKind
      || before.signature !== current.signature) {
      changedFiles.push(file)
      if (uncertain) uncertainPaths.push(file.path)
    }
  }

  return {
    changedFiles,
    removedPaths: [...previous.keys()].sort(),
    uncertainPaths: uncertainPaths.sort()
  }
}

function patchSectionStarts(patch: string): number[] {
  const starts: number[] = []
  if (patch.startsWith(DIFF_SECTION_PREFIX)) starts.push(0)
  let boundary = patch.indexOf(`\n${DIFF_SECTION_PREFIX}`)
  while (boundary !== -1) {
    starts.push(boundary + 1)
    boundary = patch.indexOf(`\n${DIFF_SECTION_PREFIX}`, boundary + 1)
  }
  return starts
}

export function filterReviewPatch(patch: string, paths: ReadonlySet<string>): string {
  if (patch === '' || paths.size === 0) return ''
  const starts = patchSectionStarts(patch)
  const kept: string[] = []
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!
    const end = starts[index + 1] ?? patch.length
    const headerEnd = patch.indexOf('\n', start)
    const header = patch.slice(start, headerEnd === -1 || headerEnd > end ? end : headerEnd)
    const path = parseDiffGitHeaderPaths(header)?.path ?? null
    if (path != null && paths.has(path)) kept.push(patch.slice(start, end))
  }
  return kept.join('')
}

export function filterReviewPatchPages(
  pages: readonly string[],
  paths: ReadonlySet<string>
): string[] {
  if (pages.length === 0 || paths.size === 0) return []
  return pages.flatMap((page) => {
    const filtered = filterReviewPatch(page, paths)
    return filtered === '' ? [] : [filtered]
  })
}

export function createSinceReview(review: PullRequestReview, checkpoint: ReviewCheckpoint): SinceReview {
  const comparison = compareReviewCheckpoint(checkpoint, review.files)
  const changedPaths = new Set(comparison.changedFiles.map((file) => file.path))
  return {
    review: {
      ...review,
      files: comparison.changedFiles,
      patch: filterReviewPatch(review.patch, changedPaths),
      omittedFiles: review.omittedFiles.filter((file) => changedPaths.has(file.path)),
      expectedFileCount: comparison.changedFiles.length
    },
    removedPaths: comparison.removedPaths,
    uncertainPaths: comparison.uncertainPaths
  }
}

export function createSinceReviewFromPages(
  review: PullRequestReview,
  patchPages: readonly string[],
  checkpoint: ReviewCheckpoint
): SinceReview {
  const comparison = compareReviewCheckpoint(checkpoint, review.files)
  const changedPaths = new Set(comparison.changedFiles.map((file) => file.path))
  return {
    review: {
      ...review,
      files: comparison.changedFiles,
      patch: '',
      omittedFiles: review.omittedFiles.filter((file) => changedPaths.has(file.path)),
      expectedFileCount: comparison.changedFiles.length
    },
    patchPages: filterReviewPatchPages(patchPages, changedPaths),
    removedPaths: comparison.removedPaths,
    uncertainPaths: comparison.uncertainPaths
  }
}
