import type { CodeViewItem, FileDiffMetadata } from '@pierre/diffs'

export type ReviewMatchSide = 'additions' | 'deletions'

/** One occurrence of the query, at a line the review can scroll to. */
export interface ReviewMatch {
  itemId: string
  side: ReviewMatchSide
  /** The line's number in its own file version (old for deletions). */
  lineNumber: number
  column: number
  length: number
}

export interface ReviewSearchResult {
  matches: ReviewMatch[]
  /** More occurrences exist than `REVIEW_SEARCH_LIMIT`; the rest are not listed. */
  truncated: boolean
}

export interface ReviewSearchOptions {
  /** The review shows every unchanged line (folding off), so they are searched too. */
  includeUnchanged?: boolean
}

export const REVIEW_SEARCH_LIMIT = 5_000

// A file or image the review draws as a preview carries a one-character
// placeholder for contents; there is no text of it on screen to find.
const PLACEHOLDER = '​'

/** Smart case: case-insensitive unless the query has an uppercase letter. */
export function isCaseSensitive(query: string): boolean {
  return query !== query.toLowerCase()
}

/** Every start column of `query` in `text` (non-overlapping), smart-cased. */
export function findInLine(text: string, query: string, caseSensitive = isCaseSensitive(query)): number[] {
  if (query === '') return []
  const haystack = caseSensitive ? text : text.toLowerCase()
  const needle = caseSensitive ? query : query.toLowerCase()
  const columns: number[] = []
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return columns
    columns.push(at)
    from = at + needle.length
  }
}

function stripEnding(line: string): string {
  if (line.endsWith('\r\n')) return line.slice(0, -2)
  return line.endsWith('\n') ? line.slice(0, -1) : line
}

interface Collector {
  query: string
  caseSensitive: boolean
  matches: ReviewMatch[]
  truncated: boolean
}

/** False once the cap is reached: the caller stops walking. */
function collect(collector: Collector, itemId: string, side: ReviewMatchSide, lineNumber: number, line: string | undefined): boolean {
  if (line == null) return true
  for (const column of findInLine(stripEnding(line), collector.query, collector.caseSensitive)) {
    if (collector.matches.length >= REVIEW_SEARCH_LIMIT) {
      collector.truncated = true
      return false
    }
    collector.matches.push({ itemId, side, lineNumber, column, length: collector.query.length })
  }
  return true
}

/**
 * The diff's lines in the order the review draws them: each hunk's context
 * once (on the new side, where a unified diff numbers it), its deletions
 * before its additions, and — when the review shows them — the unchanged runs
 * between hunks. Line numbers come from the hunk headers, so a patch that only
 * carries the changed regions numbers them the same as a whole file.
 */
function collectDiff(collector: Collector, itemId: string, diff: FileDiffMetadata, includeUnchanged: boolean): boolean {
  const unchanged = includeUnchanged && !diff.isPartial
  let nextAdditionIndex = 0
  for (const hunk of diff.hunks) {
    const additionNumber = (index: number): number => hunk.additionStart + index - hunk.additionLineIndex
    const deletionNumber = (index: number): number => hunk.deletionStart + index - hunk.deletionLineIndex
    if (unchanged) {
      for (let index = nextAdditionIndex; index < hunk.additionLineIndex; index += 1) {
        if (!collect(collector, itemId, 'additions', index + 1, diff.additionLines[index])) return false
      }
    }
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let offset = 0; offset < content.lines; offset += 1) {
          const index = content.additionLineIndex + offset
          if (!collect(collector, itemId, 'additions', additionNumber(index), diff.additionLines[index])) return false
        }
        continue
      }
      for (let offset = 0; offset < content.deletions; offset += 1) {
        const index = content.deletionLineIndex + offset
        if (!collect(collector, itemId, 'deletions', deletionNumber(index), diff.deletionLines[index])) return false
      }
      for (let offset = 0; offset < content.additions; offset += 1) {
        const index = content.additionLineIndex + offset
        if (!collect(collector, itemId, 'additions', additionNumber(index), diff.additionLines[index])) return false
      }
    }
    nextAdditionIndex = hunk.additionLineIndex + hunk.additionCount
  }
  if (unchanged) {
    for (let index = nextAdditionIndex; index < diff.additionLines.length; index += 1) {
      if (!collect(collector, itemId, 'additions', index + 1, diff.additionLines[index])) return false
    }
  }
  return true
}

/**
 * Every occurrence of `query` in the review, in reading order: files in review
 * order, lines in drawn order, left to right. Searches the diff model, so files
 * the viewer has not drawn — further down, or collapsed — are found too.
 */
export function searchReviewItems(
  items: readonly CodeViewItem<unknown>[],
  query: string,
  options: ReviewSearchOptions = {}
): ReviewSearchResult {
  const collector: Collector = { query, caseSensitive: isCaseSensitive(query), matches: [], truncated: false }
  if (query === '') return { matches: [], truncated: false }
  for (const item of items) {
    if (item.type === 'diff') {
      if (!collectDiff(collector, item.id, item.fileDiff, options.includeUnchanged === true)) break
      continue
    }
    const contents = item.file.contents
    if (contents === PLACEHOLDER) continue
    const lines = contents.split('\n')
    let complete = true
    for (const [index, line] of lines.entries()) {
      if (!collect(collector, item.id, 'additions', index + 1, line)) {
        complete = false
        break
      }
    }
    if (!complete) break
  }
  return { matches: collector.matches, truncated: collector.truncated }
}

/** The match after (or before) `current`, wrapping; -1 when there is none. */
export function nextMatchIndex(count: number, current: number, forward: boolean): number {
  if (count === 0) return -1
  if (current < 0) return forward ? 0 : count - 1
  return forward ? (current + 1) % count : (current - 1 + count) % count
}

/**
 * Where the active match should land after a new search: the first match at or
 * after the one that was active, so typing more of the word keeps the reader
 * where they were instead of jumping back to the top.
 */
export function carryActiveIndex(previous: ReviewMatch | null, matches: readonly ReviewMatch[], order: readonly string[]): number {
  if (matches.length === 0) return -1
  if (previous == null) return 0
  const itemRank = new Map(order.map((id, index) => [id, index]))
  const rank = (match: ReviewMatch): [number, number, number] => [
    itemRank.get(match.itemId) ?? 0,
    match.lineNumber,
    match.column
  ]
  const target = rank(previous)
  const found = matches.findIndex((match) => {
    const [item, line, column] = rank(match)
    if (item !== target[0]) return item > target[0]
    if (line !== target[1]) return line > target[1]
    return column >= target[2]
  })
  return found === -1 ? 0 : found
}
