import { createHash } from 'node:crypto'

import type { AgentRequestSubject } from '../../shared/contracts.js'
import { isLockfilePath, isSnapshotPath } from '../../shared/generatedPaths.js'
import { parseDiffGitHeaderPaths } from '../../shared/patchHeaders.js'
import type { GuideFileCategory, GuideHunk } from '../../shared/reviewGuide.js'
import { findPatchSectionStarts } from '../patchBuilder.js'

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export interface PatchHunk {
  path: string
  previousPath?: string
  /** 1-based position in its file's section. */
  ordinal: number
  header: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  added: number
  deleted: number
  /** The header line through the last line before the next header. */
  body: string
}

export type PatchFileStatus = 'added' | 'deleted' | 'modified' | 'renamed'

export interface PatchSection {
  path: string
  previousPath?: string
  status: PatchFileStatus
  binary: boolean
  /** The section text, header included, for a synthetic hunk's fingerprint. */
  text: string
  hunks: PatchHunk[]
}

function readSectionPath(lines: readonly string[]): { path: string; previousPath?: string } | null {
  const header = parseDiffGitHeaderPaths(lines[0] ?? '')
  if (header != null) {
    return header.previousPath === header.path ? { path: header.path } : header
  }
  // An unquoted path with spaces makes the `diff --git` line ambiguous; the
  // `---`/`+++` and rename lines name each side on its own.
  let previousPath: string | undefined
  let path: string | undefined
  for (const line of lines) {
    if (line.startsWith('@@')) break
    if (line.startsWith('rename from ')) previousPath = line.slice('rename from '.length)
    else if (line.startsWith('rename to ')) path = line.slice('rename to '.length)
    else if (line.startsWith('--- a/')) previousPath ??= line.slice(6)
    else if (line.startsWith('+++ b/')) path ??= line.slice(6)
  }
  path ??= previousPath
  if (path == null) return null
  return previousPath == null || previousPath === path ? { path } : { path, previousPath }
}

/** Every file section of a git patch, with its hunks. */
export function parsePatchSections(patch: string): PatchSection[] {
  const starts = findPatchSectionStarts(patch)
  const sections: PatchSection[] = []
  for (let index = 0; index < starts.length; index += 1) {
    const text = patch.slice(starts[index], starts[index + 1] ?? patch.length)
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    if (lines.at(-1) === '') lines.pop()
    const paths = readSectionPath(lines)
    if (paths == null) continue
    let status: PatchFileStatus = paths.previousPath == null ? 'modified' : 'renamed'
    let binary = false
    const hunks: PatchHunk[] = []
    let current: (PatchHunk & { lines: string[] }) | null = null
    const close = (): void => {
      if (current == null) return
      const { lines: hunkLines, ...hunk } = current
      hunks.push({ ...hunk, body: hunkLines.join('\n') })
      current = null
    }
    for (const line of lines) {
      const match = HUNK_HEADER.exec(line)
      if (match != null) {
        close()
        current = {
          ...paths,
          ordinal: hunks.length + 1,
          header: line,
          oldStart: Number(match[1]),
          oldCount: match[2] == null ? 1 : Number(match[2]),
          newStart: Number(match[3]),
          newCount: match[4] == null ? 1 : Number(match[4]),
          added: 0,
          deleted: 0,
          body: '',
          lines: [line]
        }
        continue
      }
      if (current == null) {
        if (line.startsWith('new file mode')) status = 'added'
        else if (line.startsWith('deleted file mode')) status = 'deleted'
        else if (line.startsWith('Binary files ') || line === 'GIT binary patch') binary = true
        continue
      }
      current.lines.push(line)
      if (line.startsWith('+')) current.added += 1
      else if (line.startsWith('-')) current.deleted += 1
    }
    close()
    sections.push({ ...paths, status, binary, text, hunks })
  }
  return sections
}

export function parsePatchHunks(patch: string): PatchHunk[] {
  return parsePatchSections(patch).flatMap((section) => section.hunks)
}

/** A hunk the guide can address, with its id in this review's scope. */
export interface ReviewHunk extends GuideHunk {
  path: string
  ordinal: number
  /** `@@ … @@` line; absent for synthetic hunks. */
  header?: string
  oldLines?: string
  newLines?: string
  /** The hunk's lines after its header, for the digest's excerpt. */
  excerpt: string
}

export interface ReviewHunkFile {
  path: string
  previousPath?: string
  status: PatchFileStatus
  category: GuideFileCategory
  generated: boolean
  added: number
  deleted: number
  hunks: ReviewHunk[]
}

export interface ReviewHunkIndex {
  scope: string
  files: ReviewHunkFile[]
  /** Every hunk by id. */
  byId: Map<string, ReviewHunk>
  /** Files by path, and by previous path for a rename. */
  byPath: Map<string, ReviewHunkFile>
}

/**
 * The scope part of a hunk id: `wt` for the working tree, `pull-request:<n>`
 * for a pull request, the head commit for anything else.
 */
export function guideScopeForSubject(subject: AgentRequestSubject): string {
  if (subject.source === 'workingTree') return 'wt'
  const number = subject.pullRequestUrl == null ? null : /\/pull\/(\d+)/.exec(subject.pullRequestUrl)?.[1]
  if (number != null) return `pull-request:${number}`
  return subject.headOid ?? 'wt'
}

export function hunkId(path: string, scope: string, ordinal: number): string {
  return `${path}:${scope}:h${ordinal}`
}

/** 'f' + 16 hex of the body without its `@@` line, so moving a hunk keeps it. */
export function hunkFingerprint(body: string): string {
  const normalized = body.replace(/\r\n/g, '\n').replace(/^@@[^\n]*(?:\n|$)/, '')
  return `f${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`
}

function syntheticSummary(section: PatchSection, generated: boolean): string {
  if (isLockfilePath(section.path)) return 'Lockfile collapsed into one review unit.'
  if (isSnapshotPath(section.path)) return 'Snapshot collapsed into one review unit.'
  if (generated) return 'Generated file collapsed into one review unit.'
  if (section.binary) return 'Binary change.'
  if (section.status === 'renamed') return 'Rename without content changes.'
  return 'Mode change without content changes.'
}

function range(start: number, count: number): string {
  return count <= 1 ? String(start) : `${start}-${start + count - 1}`
}

/**
 * Gives each hunk a stable id and fingerprint. A binary file, a rename or mode
 * change with no hunk, and a generated file are one synthetic hunk each: the
 * guide places them, but never needs to point inside them.
 */
export function indexReviewHunks(
  sections: readonly PatchSection[],
  scope: string,
  categoryOf: (path: string) => GuideFileCategory
): ReviewHunkIndex {
  const files: ReviewHunkFile[] = []
  const byId = new Map<string, ReviewHunk>()
  const byPath = new Map<string, ReviewHunkFile>()
  for (const section of sections) {
    if (byPath.has(section.path)) continue
    const category = categoryOf(section.path)
    const generated = category === 'generated'
    const added = section.hunks.reduce((sum, hunk) => sum + hunk.added, 0)
    const deleted = section.hunks.reduce((sum, hunk) => sum + hunk.deleted, 0)
    const synthetic = section.binary || section.hunks.length === 0 || generated
    const hunks: ReviewHunk[] = synthetic
      ? [{
          id: hunkId(section.path, scope, 1),
          path: section.path,
          ordinal: 1,
          fingerprint: hunkFingerprint(section.hunks.length === 0
            ? section.text.split('\n').filter((line) => !line.startsWith('diff --git') && !line.startsWith('index ')).join('\n')
            : section.hunks.map((hunk) => hunk.body).join('\n')),
          kind: 'synthetic',
          side: added > 0 || deleted === 0 ? 'additions' : 'deletions',
          startLine: null,
          endLine: null,
          added,
          deleted,
          summary: syntheticSummary(section, generated),
          excerpt: ''
        }]
      : section.hunks.map((hunk) => {
          const side = hunk.added > 0 ? 'additions' : 'deletions'
          const startLine = side === 'additions' ? hunk.newStart : hunk.oldStart
          const count = side === 'additions' ? hunk.newCount : hunk.oldCount
          return {
            id: hunkId(section.path, scope, hunk.ordinal),
            path: section.path,
            ordinal: hunk.ordinal,
            fingerprint: hunkFingerprint(hunk.body),
            kind: 'patch',
            side,
            startLine,
            endLine: startLine + Math.max(1, count) - 1,
            added: hunk.added,
            deleted: hunk.deleted,
            header: hunk.header,
            oldLines: range(hunk.oldStart, hunk.oldCount),
            newLines: range(hunk.newStart, hunk.newCount),
            excerpt: hunk.body.slice(hunk.header.length + 1)
          }
        })
    const file: ReviewHunkFile = {
      path: section.path,
      ...(section.previousPath == null ? {} : { previousPath: section.previousPath }),
      status: section.status,
      category,
      generated,
      added,
      deleted,
      hunks
    }
    files.push(file)
    byPath.set(file.path, file)
    if (file.previousPath != null && !byPath.has(file.previousPath)) byPath.set(file.previousPath, file)
    for (const hunk of hunks) byId.set(hunk.id, hunk)
  }
  return { scope, files, byId, byPath }
}
