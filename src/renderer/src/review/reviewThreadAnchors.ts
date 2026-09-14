import type { CodeViewItem, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs'

import type { ReviewThread } from './ReviewComments'
import { selectedRangeLastLine } from './reviewAnnotations'
import { pathFromReviewItemId as pathFromItemId } from './reviewItems'

// Immediate neighbors remain stable when unrelated lines are inserted nearby.
// Wider windows made an otherwise safe match fail near the start of a file.
const CONTEXT_LINE_COUNT = 1

export interface ReviewCommentAnchor {
  version: 1
  selectedText: string
  beforeContextHash: string
  afterContextHash: string
  side: 'additions' | 'deletions'
  blobOid: string | null
  symbol?: string
}

interface AddressableLines {
  lines: ReadonlyMap<number, string>
  blobOid: string | null
  symbolAt(line: number): string | undefined
}

function hashText(value: string): string {
  let first = 2_166_136_261
  let second = 2_654_435_761
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    first = Math.imul(first ^ code, 16_777_619)
    second = Math.imul(second ^ (code + index), 2_246_822_519)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`
}

function selectedSide(range: SelectedLineRange): 'additions' | 'deletions' {
  return range.endSide ?? range.side ?? 'additions'
}

function selectedBounds(range: SelectedLineRange, side: 'additions' | 'deletions'): {
  first: number
  last: number
} {
  const startSide = range.side ?? side
  const endSide = range.endSide ?? startSide
  if (startSide !== endSide) return { first: range.end, last: range.end }
  return { first: Math.min(range.start, range.end), last: Math.max(range.start, range.end) }
}

function diffLines(fileDiff: FileDiffMetadata, side: 'additions' | 'deletions'): AddressableLines {
  const lines = new Map<number, string>()
  const source = side === 'additions' ? fileDiff.additionLines : fileDiff.deletionLines
  for (const hunk of fileDiff.hunks) {
    const start = side === 'additions' ? hunk.additionStart : hunk.deletionStart
    const count = side === 'additions' ? hunk.additionCount : hunk.deletionCount
    const sourceIndex = side === 'additions' ? hunk.additionLineIndex : hunk.deletionLineIndex
    for (let offset = 0; offset < count; offset += 1) {
      const line = source[sourceIndex + offset]
      if (line != null) lines.set(start + offset, line.replace(/\r?\n$/, ''))
    }
  }
  return {
    lines,
    blobOid: (side === 'additions' ? fileDiff.newObjectId : fileDiff.prevObjectId) ?? null,
    symbolAt(line) {
      return fileDiff.hunks.find((hunk) => {
        const start = side === 'additions' ? hunk.additionStart : hunk.deletionStart
        const count = side === 'additions' ? hunk.additionCount : hunk.deletionCount
        return line >= start && line < start + count
      })?.hunkContext
    }
  }
}

function addressableLines(
  item: CodeViewItem<unknown>,
  side: 'additions' | 'deletions'
): AddressableLines {
  if (item.type === 'diff') return diffLines(item.fileDiff, side)
  const lines = new Map(item.file.contents.split(/\r\n|\r|\n/).map((line, index) => [index + 1, line]))
  return { lines, blobOid: item.file.cacheKey ?? null, symbolAt: () => undefined }
}

function contextHash(lines: ReadonlyMap<number, string>, first: number, last: number): {
  before: string
  after: string
} {
  const before: string[] = []
  const after: string[] = []
  for (let line = Math.max(1, first - CONTEXT_LINE_COUNT); line < first; line += 1) {
    const text = lines.get(line)
    if (text != null) before.push(text)
  }
  for (let line = last + 1; line <= last + CONTEXT_LINE_COUNT; line += 1) {
    const text = lines.get(line)
    if (text != null) after.push(text)
  }
  return { before: hashText(before.join('\n')), after: hashText(after.join('\n')) }
}

function createAnchorFromLines(
  addressable: AddressableLines,
  range: SelectedLineRange
): ReviewCommentAnchor | null {
  const side = selectedSide(range)
  const { first, last } = selectedBounds(range, side)
  const selected: string[] = []
  for (let line = first; line <= last; line += 1) {
    const text = addressable.lines.get(line)
    if (text == null) return null
    selected.push(text)
  }
  const context = contextHash(addressable.lines, first, last)
  const symbol = addressable.symbolAt(first)
  return {
    version: 1,
    selectedText: selected.join('\n'),
    beforeContextHash: context.before,
    afterContextHash: context.after,
    side,
    blobOid: addressable.blobOid,
    ...(symbol == null || symbol === '' ? {} : { symbol })
  }
}

export function createReviewCommentAnchor(
  item: CodeViewItem<unknown>,
  range: SelectedLineRange
): ReviewCommentAnchor | null {
  return createAnchorFromLines(addressableLines(item, selectedSide(range)), range)
}

function anchorMatchesRange(
  anchor: ReviewCommentAnchor,
  addressable: AddressableLines,
  first: number,
  last: number
): boolean {
  const selected: string[] = []
  for (let line = first; line <= last; line += 1) {
    const text = addressable.lines.get(line)
    if (text == null) return false
    selected.push(text)
  }
  return selected.join('\n') === anchor.selectedText
}

function findAnchorCandidates(anchor: ReviewCommentAnchor, addressable: AddressableLines): Array<{
  first: number
  last: number
}> {
  const selected = anchor.selectedText.split('\n')
  const candidates: Array<{ first: number; last: number }> = []
  for (const [line, text] of addressable.lines) {
    if (text !== selected[0]) continue
    let matches = true
    for (let offset = 1; offset < selected.length; offset += 1) {
      if (addressable.lines.get(line + offset) !== selected[offset]) {
        matches = false
        break
      }
    }
    if (matches) candidates.push({ first: line, last: line + selected.length - 1 })
  }
  return candidates
}

function sameRange(left: SelectedLineRange, right: SelectedLineRange): boolean {
  return left.start === right.start && left.end === right.end
    && left.side === right.side && left.endSide === right.endSide
}

function reanchorAnchoredThread(
  thread: ReviewThread,
  anchor: ReviewCommentAnchor,
  addressable: AddressableLines
): ReviewThread {
  const oldBounds = selectedBounds(thread.range, anchor.side)
  let candidate: { first: number; last: number } | null = null
  if (anchor.blobOid != null && anchor.blobOid === addressable.blobOid
    && anchorMatchesRange(anchor, addressable, oldBounds.first, oldBounds.last)) {
    candidate = oldBounds
  } else {
    const candidates = findAnchorCandidates(anchor, addressable)
    if (candidates.length === 1) candidate = candidates[0]!
    else if (candidates.length > 1) {
      const contextual = candidates.filter(({ first, last }) => {
        const context = contextHash(addressable.lines, first, last)
        return context.before === anchor.beforeContextHash && context.after === anchor.afterContextHash
      })
      if (contextual.length === 1) candidate = contextual[0]!
    }
  }

  if (candidate == null) return thread.orphaned ? thread : { ...thread, orphaned: true }
  const range: SelectedLineRange = {
    start: candidate.first,
    end: candidate.last,
    side: anchor.side,
    endSide: anchor.side
  }
  const nextAnchor = createAnchorFromLines(addressable, range)
  if (nextAnchor == null) return thread.orphaned ? thread : { ...thread, orphaned: true }
  if (!thread.orphaned && sameRange(thread.range, range)
    && anchor.blobOid === nextAnchor.blobOid
    && anchor.beforeContextHash === nextAnchor.beforeContextHash
    && anchor.afterContextHash === nextAnchor.afterContextHash) return thread
  return { ...thread, lineNumber: selectedRangeLastLine(range), side: anchor.side, range, anchor: nextAnchor, orphaned: false }
}

export function reanchorReviewThread(thread: ReviewThread, item: CodeViewItem<unknown> | null): ReviewThread {
  if (item == null) return thread.orphaned ? thread : { ...thread, orphaned: true }
  if (thread.anchor == null) {
    // Legacy drafts have coordinates but no selected text. Treating whatever now
    // occupies those lines as the original comment target would be a guess.
    return thread.orphaned ? thread : { ...thread, orphaned: true }
  }
  const lines = addressableLines(item, thread.anchor.side)
  return reanchorAnchoredThread(thread, thread.anchor, lines)
}

export function reanchorReviewThreads(
  items: readonly CodeViewItem<unknown>[],
  threadsByPath: Readonly<Record<string, ReviewThread[]>>,
  complete: boolean
): Record<string, ReviewThread[]> {
  const itemsByPath = new Map(items.map((item) => [pathFromItemId(item.id), item]))
  let changed = false
  const next: Record<string, ReviewThread[]> = {}
  for (const [path, threads] of Object.entries(threadsByPath)) {
    const item = itemsByPath.get(path) ?? null
    if (item == null && !complete) {
      next[path] = threads
      continue
    }
    const linesBySide = new Map<ReviewCommentAnchor['side'], AddressableLines>()
    const reanchored = threads.map((thread) => {
      if (item == null || thread.anchor == null) return reanchorReviewThread(thread, item)
      let lines = linesBySide.get(thread.anchor.side)
      if (lines == null) {
        lines = addressableLines(item, thread.anchor.side)
        linesBySide.set(thread.anchor.side, lines)
      }
      return reanchorAnchoredThread(
        thread,
        thread.anchor,
        lines
      )
    })
    if (reanchored.some((thread, index) => thread !== threads[index])) changed = true
    next[path] = reanchored
  }
  return changed ? next : threadsByPath as Record<string, ReviewThread[]>
}

export function attachReviewThreadToRange(
  thread: ReviewThread,
  item: CodeViewItem<unknown>,
  range: SelectedLineRange
): ReviewThread | null {
  const anchor = createReviewCommentAnchor(item, range)
  if (anchor == null) return null
  return {
    ...thread,
    lineNumber: selectedRangeLastLine(range),
    side: anchor.side,
    range,
    anchor,
    orphaned: false
  }
}
