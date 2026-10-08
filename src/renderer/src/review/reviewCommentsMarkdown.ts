import type { CodeViewItem, FileDiffMetadata, SelectedLineRange } from '@pierre/diffs'

import type { ReviewThread } from './ReviewComments'

export interface ReviewCommentEntry {
  path: string
  thread: ReviewThread
}

interface DiffRow {
  prefix: '+' | '-' | ' '
  oldLine: number | null
  newLine: number | null
  text: string
}

const CONTEXT_ROWS = 3

function strip(line: string | undefined): string {
  return (line ?? '').replace(/\r?\n$/, '')
}

/** A diff's rows, hunk by hunk, as a unified diff reads them. */
function diffRows(fileDiff: FileDiffMetadata): DiffRow[][] {
  return fileDiff.hunks.map((hunk) => {
    const rows: DiffRow[] = []
    let oldLine = hunk.deletionStart
    let newLine = hunk.additionStart
    for (const content of hunk.hunkContent) {
      if (content.type === 'context') {
        for (let offset = 0; offset < content.lines; offset += 1) {
          rows.push({ prefix: ' ', oldLine, newLine, text: strip(fileDiff.additionLines[content.additionLineIndex + offset]) })
          oldLine += 1
          newLine += 1
        }
        continue
      }
      for (let offset = 0; offset < content.deletions; offset += 1) {
        rows.push({ prefix: '-', oldLine, newLine: null, text: strip(fileDiff.deletionLines[content.deletionLineIndex + offset]) })
        oldLine += 1
      }
      for (let offset = 0; offset < content.additions; offset += 1) {
        rows.push({ prefix: '+', oldLine: null, newLine, text: strip(fileDiff.additionLines[content.additionLineIndex + offset]) })
        newLine += 1
      }
    }
    return rows
  })
}

function bounds(range: SelectedLineRange): { side: 'additions' | 'deletions'; first: number; last: number } {
  const side = range.endSide ?? range.side ?? 'additions'
  const startSide = range.side ?? side
  if (startSide !== side) return { side, first: range.end, last: range.end }
  return { side, first: Math.min(range.start, range.end), last: Math.max(range.start, range.end) }
}

/** The thread's rows and three on each side, from the hunk that holds them. */
function contextRows(item: CodeViewItem<unknown> | undefined, range: SelectedLineRange): DiffRow[] {
  if (item == null) return []
  const { side, first, last } = bounds(range)
  if (item.type !== 'diff') {
    const lines = item.file.contents.split(/\r\n|\r|\n/)
    const from = Math.max(1, first - CONTEXT_ROWS)
    const to = Math.min(lines.length, last + CONTEXT_ROWS)
    return lines.slice(from - 1, to).map((text, index) => ({ prefix: ' ', oldLine: null, newLine: from + index, text }))
  }
  for (const rows of diffRows(item.fileDiff)) {
    const matching = rows.flatMap((row, index) => {
      const line = side === 'additions' ? row.newLine : row.oldLine
      const onSide = side === 'additions' ? row.prefix !== '-' : row.prefix !== '+'
      return onSide && line != null && line >= first && line <= last ? [index] : []
    })
    if (matching.length === 0) continue
    // A changed row reads with the rest of its change: the lines it replaced, or replaced it.
    let start = matching[0]!
    let end = matching.at(-1)!
    if (rows[start]!.prefix !== ' ') while (start > 0 && rows[start - 1]!.prefix !== ' ') start -= 1
    if (rows[end]!.prefix !== ' ') while (end < rows.length - 1 && rows[end + 1]!.prefix !== ' ') end += 1
    return rows.slice(Math.max(0, start - CONTEXT_ROWS), end + CONTEXT_ROWS + 1)
  }
  return []
}

/** A fence longer than any run of backticks in the code. */
function fenceFor(code: string): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

function lineLabel(range: SelectedLineRange): string {
  const { side, first, last } = bounds(range)
  const which = side === 'additions' ? 'New' : 'Old'
  return first === last ? `${which} line ${first}` : `${which} lines ${first}–${last}`
}

function quote(text: string): string {
  return text.trim().split('\n').map((line) => `> ${line}`).join('\n')
}

/**
 * The reviewer's notes as a numbered Markdown list, each quoting its lines and
 * three rows around them, for pasting into an agent or a pull request.
 */
export function formatReviewCommentsMarkdown(
  entries: readonly ReviewCommentEntry[],
  itemFor: (path: string) => CodeViewItem<unknown> | undefined,
  { heading = '# Address these review comments' }: { heading?: string } = {}
): string {
  const sorted = [...entries].sort((left, right) =>
    left.path.localeCompare(right.path) || bounds(left.thread.range).first - bounds(right.thread.range).first)
  const blocks = sorted.map(({ path, thread }, index) => {
    const parts = [`${index + 1}. **${path}** (${lineLabel(thread.range)})${thread.orphaned === true ? ' [orphaned — verify location]' : ''}`]
    const rows = contextRows(itemFor(path), thread.range)
    if (rows.length > 0) {
      const width = String(Math.max(...rows.map((row) => row.newLine ?? row.oldLine ?? 0))).length
      const code = rows.map((row) => `${row.prefix}${String(row.newLine ?? row.oldLine ?? '').padStart(width)} ${row.text}`).join('\n')
      const fence = fenceFor(code)
      parts.push(`${fence}diff\n${code}\n${fence}`)
    }
    parts.push(quote(thread.body))
    for (const reply of thread.replies) parts.push(quote(reply.body))
    return parts.join('\n\n')
  })
  return `${heading}\n\n${blocks.join('\n\n')}\n`
}
