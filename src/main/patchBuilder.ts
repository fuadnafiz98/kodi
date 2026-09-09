import { createHash } from 'node:crypto'

import type { OmittedDiffFile, PullRequestFile } from '../shared/contracts.js'
import { parseDiffGitHeaderPaths } from '../shared/patchHeaders.js'

import { comparePaths, splitNullDelimited } from './gitCommands.js'

const MAX_DIFF_FILE_CHURN_LINES = 20_000
// Probed on this machine (ARG_MAX 1 MiB): `git diff -- <paths>` survives 553 KB of
// arguments and dies with E2BIG at 929 KB, so the whole-repository review of a
// branch switch that rewrote ~20k paths fell out of the fast path entirely.
const MAX_PATHSPEC_ARGV_BYTES = 128 * 1024
// `gh pr diff` asks GitHub for one diff document, and GitHub refuses past 300
// files. The files API pages instead, up to its own ceiling of 3000.
export const PULL_REQUEST_FILES_PAGE_SIZE = 100
export const MAX_PULL_REQUEST_FILES = 3_000
// Each page is one `gh` process and one GitHub round trip, ~5s for a large pull
// request. Fetched one after another a 3000-file review took nearly two minutes.
const PULL_REQUEST_FILES_PAGE_CONCURRENCY = 8
const GIT_DIFF_SECTION_PREFIX = 'diff --git '

function patchPathNeedsQuotes(path: string): boolean {
  if (/["\\]/.test(path)) return true
  for (const character of path) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

export function chunkPathspecs(
  paths: readonly string[],
  maxBytes: number = MAX_PATHSPEC_ARGV_BYTES
): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let bytes = 0
  for (const path of paths) {
    const cost = Buffer.byteLength(path, 'utf8') + 1
    if (current.length > 0 && bytes + cost > maxBytes) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(path)
    bytes += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`
}

/** Keep a rename's old and new paths on the same git invocation. */
export function pathspecGroupForFile(file: { path: string; previousPath?: string }): string[] {
  if (file.previousPath != null && file.previousPath !== file.path) {
    return [literalPathspec(file.previousPath), literalPathspec(file.path)]
  }
  return [literalPathspec(file.path)]
}

export function isolateFirstPathspecGroup(groups: readonly string[][]): {
  first: string[] | null
  rest: string[][]
} {
  const first = groups[0]
  if (first == null) return { first: null, rest: [] }
  return { first, rest: groups.slice(1) }
}

/** Chunk argv without splitting a rename pair across invocations. */
export function chunkPathspecGroups(
  groups: readonly string[][],
  maxBytes: number = MAX_PATHSPEC_ARGV_BYTES
): string[][] {
  const chunks: string[][] = []
  let current: string[] = []
  let bytes = 0
  for (const group of groups) {
    const cost = group.reduce((total, path) => total + Buffer.byteLength(path, 'utf8') + 1, 0)
    if (current.length > 0 && bytes + cost > maxBytes) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(...group)
    bytes += cost
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** First visible path is its own git invocation so the renderer can paint it. */
export function isolateFirstPathspec(paths: readonly string[]): {
  first: string | null
  rest: string[]
} {
  const first = paths[0]
  if (first == null) return { first: null, rest: [] }
  return { first, rest: paths.slice(1) }
}

export interface DiffChurnEntry {
  path: string
  previousPath?: string
  additions: number
  deletions: number
  binary: boolean
}

export function parseNumstat(buffer: Buffer): DiffChurnEntry[] {
  const fields = splitNullDelimited(buffer)
  const entries: DiffChurnEntry[] = []

  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
    const field = fields[fieldIndex]
    if (field == null) continue
    const firstTab = field.indexOf('\t')
    const secondTab = field.indexOf('\t', firstTab + 1)
    if (firstTab < 1 || secondTab < 0) continue

    const additionsText = field.slice(0, firstTab)
    const deletionsText = field.slice(firstTab + 1, secondTab)
    const binary = additionsText === '-' || deletionsText === '-'
    const churn = {
      additions: binary ? 0 : Number(additionsText) || 0,
      deletions: binary ? 0 : Number(deletionsText) || 0,
      binary
    }
    const inlinePath = field.slice(secondTab + 1)
    if (inlinePath !== '') {
      entries.push({ path: inlinePath, ...churn })
      continue
    }

    const previousPath = fields[fieldIndex + 1]
    const path = fields[fieldIndex + 2]
    fieldIndex += 2
    if (previousPath == null || path == null) continue
    entries.push({ path, previousPath, ...churn })
  }

  return entries
}

export function diffFilesFromChurn(entries: readonly DiffChurnEntry[]): PullRequestFile[] {
  return entries
    .map((entry) => ({
      path: entry.path,
      ...(entry.previousPath == null ? {} : { previousPath: entry.previousPath }),
      additions: entry.additions,
      deletions: entry.deletions
    }))
    .sort((left, right) => comparePaths(left.path, right.path))
}

export function selectOversizedDiffFiles(entries: readonly DiffChurnEntry[]): {
  omittedFiles: OmittedDiffFile[]
  excludePathspecs: string[]
} {
  const omittedFiles: OmittedDiffFile[] = []
  const excludePathspecs: string[] = []

  for (const entry of entries) {
    if (entry.binary || entry.additions + entry.deletions <= MAX_DIFF_FILE_CHURN_LINES) continue
    omittedFiles.push({
      path: entry.path,
      reason: 'too-large',
      additions: entry.additions,
      deletions: entry.deletions
    })
    excludePathspecs.push(`:(exclude,literal)${entry.path}`)
    if (entry.previousPath != null) excludePathspecs.push(`:(exclude,literal)${entry.previousPath}`)
  }

  return { omittedFiles, excludePathspecs }
}

function formatPatchPath(side: 'a' | 'b', path: string): string {
  const sidedPath = `${side}/${path}`
  if (!patchPathNeedsQuotes(path)) return sidedPath
  const escapedPath = sidedPath
    .replace(/[\\"]/g, '\\$&')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escapedPath}"`
}

export function createNewFilePatch(path: string, contents: string, binary = false): string {
  const header = `diff --git ${formatPatchPath('a', path)} ${formatPatchPath('b', path)}\nnew file mode 100644\n`
  if (binary) return `${header}Binary files /dev/null and ${formatPatchPath('b', path)} differ\n`
  // Git emits no hunk, and no file headers, for an empty new file.
  if (contents === '') return header

  const endsWithNewline = contents.endsWith('\n')
  const lines = (endsWithNewline ? contents.slice(0, -1) : contents).split('\n')
  const hunkHeader = lines.length === 1 ? '@@ -0,0 +1 @@' : `@@ -0,0 +1,${lines.length} @@`
  const body = lines.map((line) => `+${line}`).join('\n')
  const incompleteLastLine = endsWithNewline ? '' : '\\ No newline at end of file\n'
  return `${header}--- /dev/null\n+++ ${formatPatchPath('b', path)}\n${hunkHeader}\n${body}\n${incompleteLastLine}`
}

/**
 * One wave of file pages to request together. GitHub gives no reliable total —
 * its own file count can exceed what the API serves, and a page carrying large
 * patches comes back short without meaning the end — so pages are read in waves
 * until a whole wave comes back empty, capped at the 3000 files the API answers.
 */
export function pullRequestFilePageWave(startPage: number): number[] {
  const maxPages = MAX_PULL_REQUEST_FILES / PULL_REQUEST_FILES_PAGE_SIZE
  const first = Math.max(1, Math.floor(startPage))
  const last = Math.min(maxPages, first + PULL_REQUEST_FILES_PAGE_CONCURRENCY - 1)
  if (first > maxPages) return []
  return Array.from({ length: last - first + 1 }, (_unused, index) => first + index)
}

export interface RawPullRequestFile {
  filename: string
  previous_filename?: string
  sha?: string
  status?: string
  additions?: number
  deletions?: number
  patch?: string
}

/**
 * GitHub answers `gh pr diff` with HTTP 406 once a pull request touches more than
 * 300 files, and `gh` surfaces that verbatim. Recognising it lets the review fall
 * back to the paged files API instead of failing to open at all.
 */
export function isPullRequestDiffTooLargeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /HTTP 406|too_large|exceeded the maximum number of files/i.test(message)
}

/**
 * Rebuilds a git-style patch from the files API, which returns each file's hunks
 * without the `diff --git` headers the diff parser keys on. Files GitHub declines
 * to diff (binary, or too large for its own limit) arrive without a patch and are
 * reported as omitted rather than dropped silently.
 */
export function buildPullRequestPatchFromFiles(rawFiles: readonly RawPullRequestFile[]): {
  patch: string
  files: PullRequestFile[]
  omittedFiles: OmittedDiffFile[]
} {
  const sections: string[] = []
  const files: PullRequestFile[] = []
  const omittedFiles: OmittedDiffFile[] = []
  for (const rawFile of rawFiles) {
    const path = typeof rawFile.filename === 'string' ? rawFile.filename : ''
    // Everything GitHub lists is tracked, and the patch below never honoured the
    // exclusion, so filtering here only made `files` disagree with `patch`.
    if (path === '') continue
    const additions = Number.isFinite(rawFile.additions) ? Number(rawFile.additions) : 0
    const deletions = Number.isFinite(rawFile.deletions) ? Number(rawFile.deletions) : 0
    const previousPath = typeof rawFile.previous_filename === 'string' && rawFile.previous_filename !== ''
      ? rawFile.previous_filename
      : path
    const blobOid = typeof rawFile.sha === 'string' && /^[0-9a-f]{40,64}$/i.test(rawFile.sha)
      ? rawFile.sha.toLowerCase()
      : undefined
    const blobIdentity = rawFile.status === 'removed'
      ? (blobOid == null ? {} : { baseBlobOid: blobOid })
      : (blobOid == null ? {} : { headBlobOid: blobOid })
    if (typeof rawFile.patch !== 'string' || rawFile.patch === '') {
      files.push({
        path,
        ...(previousPath === path ? {} : { previousPath }),
        additions,
        deletions,
        ...blobIdentity
      })
      omittedFiles.push({ path, reason: 'too-large', additions, deletions })
      continue
    }

    const header = [`${GIT_DIFF_SECTION_PREFIX}${formatPatchPath('a', previousPath)} ${formatPatchPath('b', path)}`]
    if (rawFile.status === 'added') header.push('new file mode 100644')
    if (rawFile.status === 'removed') header.push('deleted file mode 100644')
    if (rawFile.status === 'renamed' && previousPath !== path) {
      header.push(`rename from ${previousPath}`, `rename to ${path}`)
    }
    if (blobOid != null) {
      const zeroOid = '0'.repeat(blobOid.length)
      const baseOid = rawFile.status === 'removed' ? blobOid : zeroOid
      const headOid = rawFile.status === 'removed' ? zeroOid : blobOid
      header.push(`index ${baseOid}..${headOid} 100644`)
    }
    header.push(
      rawFile.status === 'added' ? '--- /dev/null' : `--- ${formatPatchPath('a', previousPath)}`,
      rawFile.status === 'removed' ? '+++ /dev/null' : `+++ ${formatPatchPath('b', path)}`
    )
    const body = rawFile.patch.endsWith('\n') ? rawFile.patch : `${rawFile.patch}\n`
    const section = `${header.join('\n')}\n${body}`
    sections.push(section)
    files.push({
      path,
      ...(previousPath === path ? {} : { previousPath }),
      additions,
      deletions,
      ...blobIdentity,
      patchHash: createHash('sha256').update(section).digest('hex')
    })
  }
  return { patch: sections.join(''), files, omittedFiles }
}

function findPatchSectionStarts(patch: string): number[] {
  const starts: number[] = []
  if (patch.startsWith(GIT_DIFF_SECTION_PREFIX)) starts.push(0)
  let boundaryIndex = patch.indexOf(`\n${GIT_DIFF_SECTION_PREFIX}`)
  while (boundaryIndex !== -1) {
    starts.push(boundaryIndex + 1)
    boundaryIndex = patch.indexOf(`\n${GIT_DIFF_SECTION_PREFIX}`, boundaryIndex + 1)
  }
  return starts
}

export function chunkPatchByFileCount(patch: string, maxFiles = 25): string[] {
  if (patch === '') return []
  const sectionStarts = findPatchSectionStarts(patch)
  const chunkSize = Math.max(1, Math.floor(maxFiles))
  if (sectionStarts.length === 0 || sectionStarts.length <= chunkSize) return [patch]
  const chunks: string[] = []
  for (let sectionIndex = 0; sectionIndex < sectionStarts.length; sectionIndex += chunkSize) {
    const start = sectionIndex === 0 ? 0 : sectionStarts[sectionIndex]!
    const end = sectionStarts[sectionIndex + chunkSize] ?? patch.length
    chunks.push(patch.slice(start, end))
  }
  return chunks
}

function patchSectionPaths(patch: string, start: number, end: number): {
  path: string
  previousPath?: string
} {
  const newlineIndex = patch.indexOf('\n', start)
  const headerEnd = newlineIndex === -1 || newlineIndex > end ? end : newlineIndex
  const header = patch.slice(start, headerEnd)
  const paths = parseDiffGitHeaderPaths(header)
  if (paths == null) return { path: header.slice(GIT_DIFF_SECTION_PREFIX.length) }
  return {
    path: paths.path,
    ...(paths.previousPath === paths.path ? {} : { previousPath: paths.previousPath })
  }
}

function patchSectionBlobOids(section: string): {
  baseBlobOid?: string
  headBlobOid?: string
} {
  const match = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: \d+)?$/im.exec(section)
  if (match == null) return {}
  const normalize = (oid: string | undefined): string | undefined =>
    oid == null || /^0+$/.test(oid) ? undefined : oid.toLowerCase()
  const baseBlobOid = normalize(match[1])
  const headBlobOid = normalize(match[2])
  return {
    ...(baseBlobOid == null ? {} : { baseBlobOid }),
    ...(headBlobOid == null ? {} : { headBlobOid })
  }
}

function countPatchSectionChurn(
  patch: string,
  start: number,
  end: number
): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  let lineStart = start

  while (lineStart < end) {
    const newlineIndex = patch.indexOf('\n', lineStart)
    const lineEnd = newlineIndex === -1 || newlineIndex > end ? end : newlineIndex
    const marker = patch[lineStart]
    if (marker === '+' && !patch.startsWith('+++ ', lineStart)) additions += 1
    else if (marker === '-' && !patch.startsWith('--- ', lineStart)) deletions += 1
    lineStart = lineEnd + 1
  }

  return { additions, deletions }
}

/**
 * `gh pr view --json files` stops at 100 entries however many files the pull
 * request touches, so a 128-file review lost 28 files from the tree, from the
 * next/prev-file shortcuts and from the progress count while still rendering them
 * at the bottom of the scroll view. The patch is the complete document, so the
 * file list is rebuilt from it whenever GitHub's own list came back short.
 */
export function filesFromPatch(patch: string): PullRequestFile[] {
  const sectionStarts = findPatchSectionStarts(patch)
  const files: PullRequestFile[] = []
  for (let index = 0; index < sectionStarts.length; index += 1) {
    const start = sectionStarts[index]!
    const end = sectionStarts[index + 1] ?? patch.length
    const section = patch.slice(start, end)
    const paths = patchSectionPaths(patch, start, end)
    files.push({
      ...paths,
      ...countPatchSectionChurn(patch, start, end),
      ...patchSectionBlobOids(section),
      patchHash: createHash('sha256').update(section).digest('hex')
    })
  }
  return files
}

export function limitPatchFileSize(
  patch: string,
  maxBytes: number
): { patch: string; omittedFiles: OmittedDiffFile[] } {
  const sectionStarts = findPatchSectionStarts(patch)
  const sectionEnd = (index: number): number => sectionStarts[index + 1] ?? patch.length
  const oversizedSections = new Set<number>()
  for (let index = 0; index < sectionStarts.length; index += 1) {
    if (sectionEnd(index) - sectionStarts[index]! > maxBytes) oversizedSections.add(index)
  }
  if (oversizedSections.size === 0) return { patch, omittedFiles: [] }

  const omittedFiles: OmittedDiffFile[] = []
  const keptParts: string[] = []
  const firstStart = sectionStarts[0]!
  if (firstStart > 0) keptParts.push(patch.slice(0, firstStart))

  for (let index = 0; index < sectionStarts.length; index += 1) {
    const start = sectionStarts[index]!
    const end = sectionEnd(index)
    if (!oversizedSections.has(index)) {
      keptParts.push(patch.slice(start, end))
      continue
    }
    omittedFiles.push({
      path: patchSectionPaths(patch, start, end).path,
      reason: 'too-large',
      ...countPatchSectionChurn(patch, start, end)
    })
  }

  return { patch: keptParts.join(''), omittedFiles }
}
