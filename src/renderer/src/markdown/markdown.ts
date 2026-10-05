export type MarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'emphasis'; text: string }

export type MarkdownBlock =
  | { kind: 'paragraph'; content: MarkdownInline[] }
  | { kind: 'heading'; level: number; content: MarkdownInline[] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'list'; ordered: boolean; items: MarkdownInline[][] }
  | { kind: 'quote'; content: MarkdownInline[] }
  | { kind: 'table'; align: TableAlign[]; header: MarkdownInline[][]; rows: MarkdownInline[][][] }

export type TableAlign = 'left' | 'center' | 'right' | null

// An underscore inside a word is part of it, as CommonMark has it:
// `data_platform_file_id` is a name, not "data *platform* file_id".
const INLINE_PATTERN = /(`[^`]+`|\*\*[^*]+\*\*|(?<!\w)__[^_]+__(?!\w)|\*[^*]+\*|(?<!\w)_[^_]+_(?!\w))/
const CODE_SPAN = /(`[^`]+`)/
// Shared with the incremental scanner below so the two can never disagree about
// where a fenced block starts and ends.
const FENCE_OPEN = /^```(\w*)\s*$/
const FENCE_CLOSE = /^```\s*$/
// A GFM delimiter row: `---`, `:--`, `--:` or `:-:` cells, outer pipes optional.
const TABLE_DELIMITER = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/

// Cells of a GFM table row. `\|` is a literal pipe and a pipe inside a code
// span does not split, as on GitHub; one leading and one trailing pipe are
// optional.
export function splitTableRow(line: string): string[] {
  const text = line.trim()
  const cells: string[] = []
  let cell = ''
  let code = false
  let trailing = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    trailing = false
    if (char === '\\' && text[index + 1] === '|') {
      cell += '|'
      index += 1
      continue
    }
    if (char === '`') code = !code
    if (char === '|' && !code) {
      cells.push(cell)
      cell = ''
      trailing = true
      continue
    }
    cell += char
  }
  if (!trailing) cells.push(cell)
  if (text.startsWith('|')) cells.shift()
  return cells.map((part) => part.trim())
}

function tableAlign(cell: string): TableAlign {
  const left = cell.startsWith(':')
  const right = cell.endsWith(':')
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null
}

// A header row and a delimiter row with as many cells start a table; its body
// runs to the first blank line or line without a pipe. Rows are padded or cut
// to the header's width, as GitHub draws them.
function parseTable(lines: string[], start: number): { block: MarkdownBlock; end: number } | null {
  const headerLine = lines[start] ?? ''
  const delimiterLine = (lines[start + 1] ?? '').trim()
  // A bare `---` under a line with a pipe is a rule, not a one-column table.
  if (!headerLine.includes('|') || !delimiterLine.includes('|') || !TABLE_DELIMITER.test(delimiterLine)) return null
  const header = splitTableRow(headerLine)
  const delimiter = splitTableRow(delimiterLine)
  if (header.length !== delimiter.length) return null
  const width = header.length
  const rows: MarkdownInline[][][] = []
  let end = start + 2
  while (end < lines.length && (lines[end] ?? '').trim() !== '' && (lines[end] ?? '').includes('|')) {
    const cells = splitTableRow(lines[end] ?? '')
    rows.push(Array.from({ length: width }, (_unused, column) => parseInline(cells[column] ?? '')))
    end += 1
  }
  return {
    block: { kind: 'table', align: delimiter.map(tableAlign), header: header.map(parseInline), rows },
    end
  }
}

export function parseInline(text: string): MarkdownInline[] {
  if (text === '') return []
  const parts = text.split(INLINE_PATTERN).filter((part) => part !== '')
  const inlines: MarkdownInline[] = []
  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      inlines.push({ kind: 'code', text: part.slice(1, -1) })
    } else if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) {
      inlines.push({ kind: 'strong', text: part.slice(2, -2) })
    } else if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) {
      inlines.push({ kind: 'emphasis', text: part.slice(1, -1) })
    } else {
      inlines.push({ kind: 'text', text: part })
    }
  }
  return inlines
}

/**
 * Bold and italic runs hold their text as written; a code span inside one
 * (`**Yes, `[1]` is safe.**`) is split out here so it renders as code rather
 * than as literal backticks.
 */
export function splitCodeSpans(text: string): { code: boolean; text: string }[] {
  return text.split(CODE_SPAN).filter((part) => part !== '').map((part) =>
    part.length > 2 && part.startsWith('`') && part.endsWith('`')
      ? { code: true, text: part.slice(1, -1) }
      : { code: false, text: part })
}

// Streaming answers arrive mid-token, so an unterminated fence still has to render
// as a code block rather than swallowing the rest of the answer.
export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = []
  const lines = source.split('\n')
  let paragraph: string[] = []
  let listItems: string[] = []
  let listOrdered = false

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', content: parseInline(paragraph.join(' ')) })
    paragraph = []
  }
  const flushList = (): void => {
    if (listItems.length === 0) return
    blocks.push({ kind: 'list', ordered: listOrdered, items: listItems.map(parseInline) })
    listItems = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const fence = FENCE_OPEN.exec(line)
    if (fence != null) {
      flushParagraph()
      flushList()
      const language = fence[1] === '' ? null : fence[1] ?? null
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !FENCE_CLOSE.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '')
        index += 1
      }
      blocks.push({ kind: 'code', language, text: codeLines.join('\n') })
      continue
    }

    const table = parseTable(lines, index)
    if (table != null) {
      flushParagraph()
      flushList()
      blocks.push(table.block)
      index = table.end - 1
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading != null) {
      flushParagraph()
      flushList()
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length,
        content: parseInline(heading[2] ?? '')
      })
      continue
    }

    const quote = /^>\s?(.*)$/.exec(line)
    if (quote != null) {
      flushParagraph()
      flushList()
      blocks.push({ kind: 'quote', content: parseInline(quote[1] ?? '') })
      continue
    }

    const unordered = /^[-*+]\s+(.*)$/.exec(line)
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line)
    if (unordered != null || ordered != null) {
      flushParagraph()
      const itemText = (unordered?.[1] ?? ordered?.[1] ?? '')
      const nextOrdered = ordered != null
      if (listItems.length > 0 && nextOrdered !== listOrdered) flushList()
      listOrdered = nextOrdered
      listItems.push(itemText)
      continue
    }

    if (line.trim() === '') {
      flushParagraph()
      flushList()
      continue
    }

    flushList()
    paragraph.push(line.trim())
  }

  flushParagraph()
  flushList()
  return blocks
}

export interface StreamingMarkdown {
  /** The source these blocks describe, so the next chunk can prove it is an append. */
  source: string
  /** How much of `source` is already converted into `settled`. */
  settledLength: number
  settled: MarkdownBlock[]
  /** Where each settled block's segment ends, so a trim can drop whole blocks. */
  settledEnds: readonly number[]
  /** What the UI renders: everything settled, plus the still-growing tail. */
  blocks: MarkdownBlock[]
}

export const EMPTY_STREAMING_MARKDOWN: StreamingMarkdown = {
  source: '',
  settledLength: 0,
  settled: [],
  settledEnds: [],
  blocks: []
}

// A blank line outside a fence is where parseMarkdown flushes, so everything
// before the last one can never change as more text arrives. Returns the offset
// that prefix ends at.
function settledBoundary(source: string, from: number): number {
  let boundary = from
  let inFence = false
  let lineStart = from
  while (lineStart < source.length) {
    const lineEnd = source.indexOf('\n', lineStart)
    // A line with no terminator is still arriving, so it cannot settle anything.
    if (lineEnd === -1) break
    const line = source.slice(lineStart, lineEnd)
    if (!inFence && FENCE_OPEN.test(line)) inFence = true
    else if (inFence && FENCE_CLOSE.test(line)) inFence = false
    else if (!inFence && line.trim() === '') boundary = lineEnd + 1
    lineStart = lineEnd + 1
  }
  return boundary
}

// Re-parsing the whole answer on every streamed chunk is quadratic: a 20 KB
// answer arriving in 600 chunks parses ~6.1M characters. Only the unsettled tail
// has to be re-parsed, which makes the total linear in the answer length.
export function advanceStreamingMarkdown(previous: StreamingMarkdown, source: string): StreamingMarkdown {
  // Truncating a very long answer from the front breaks the append invariant, so
  // that case starts over rather than reusing a prefix that no longer exists.
  const appended = source.startsWith(previous.source)
  const settled = appended ? previous.settled : []
  const settledEnds = appended ? previous.settledEnds : []
  const settledLength = appended ? previous.settledLength : 0

  const boundary = settledBoundary(source, settledLength)
  const added = boundary > settledLength ? parseMarkdown(source.slice(settledLength, boundary)) : []
  const nextSettled = added.length === 0 ? settled : [...settled, ...added]
  const nextEnds = added.length === 0 ? settledEnds : [...settledEnds, ...added.map(() => boundary)]
  const tail = source.slice(boundary)

  return {
    source,
    settledLength: boundary,
    settled: nextSettled,
    settledEnds: nextEnds,
    blocks: tail === '' ? nextSettled : [...nextSettled, ...parseMarkdown(tail)]
  }
}

// Capping the answer by slicing its front used to break the append invariant, so
// every chunk after the cap re-parsed the whole retained answer — measured at
// 0.03 ms per chunk before the cap and 2.07 ms after. Cutting on a settled
// boundary, and dropping those blocks together with their text, keeps the parse
// incremental for the rest of the stream.
export function appendStreamingMarkdown(
  previous: StreamingMarkdown,
  addition: string,
  limit: number
): StreamingMarkdown {
  const next = advanceStreamingMarkdown(previous, `${previous.source}${addition}`)
  if (next.source.length <= limit) return next

  const target = next.source.length - limit
  const cut = next.settledEnds.find((end) => end >= target)
  // A single unsettled block longer than the cap has no boundary to cut on; that
  // answer restarts rather than growing without bound.
  if (cut == null) return advanceStreamingMarkdown(EMPTY_STREAMING_MARKDOWN, next.source.slice(-limit))

  let dropped = 0
  while (dropped < next.settledEnds.length && (next.settledEnds[dropped] ?? 0) <= cut) dropped += 1
  const source = next.source.slice(cut)
  const settledLength = next.settledLength - cut
  const settled = next.settled.slice(dropped)
  const tail = source.slice(settledLength)
  return {
    source,
    settledLength,
    settled,
    settledEnds: next.settledEnds.slice(dropped).map((end) => end - cut),
    blocks: tail === '' ? settled : [...settled, ...parseMarkdown(tail)]
  }
}

// Streaming re-parses the whole answer on every chunk, so blocks and inline runs
// need identities derived from their content instead of their position.
export function keyForInline(inline: MarkdownInline, seen: Map<string, number>): string {
  const base = `${inline.kind}:${inline.text.slice(0, 24)}`
  const count = (seen.get(base) ?? 0) + 1
  seen.set(base, count)
  return `${base}#${count}`
}

export function keyForBlock(block: MarkdownBlock, seen: Map<string, number>): string {
  const sample = block.kind === 'code'
    ? block.text.slice(0, 24)
    : block.kind === 'list'
      // Deliberately excludes items.length: a list streams in item by item, so a
      // length in the key would change on every chunk and remount the whole list.
      ? `${block.ordered ? 'ol' : 'ul'}:${block.items[0]?.[0]?.text.slice(0, 24) ?? ''}`
      // Header only, for the same reason: rows stream in one at a time.
      : block.kind === 'table'
        ? block.header.map((cell) => cell[0]?.text ?? '').join('|').slice(0, 24)
        : block.content[0]?.text.slice(0, 24) ?? ''
  const base = `${block.kind}:${sample}`
  const count = (seen.get(base) ?? 0) + 1
  seen.set(base, count)
  return `${base}#${count}`
}
