import { spawn as spawnChild } from 'node:child_process'

/**
 * ⌘F over a review searches whole files, not only the hunks the renderer holds:
 * a patch carries the changed lines, and the folded runs between them exist
 * only on disk (or in git at the review's revision). This finds every line of
 * the review's files that holds the query, on the new side, and leaves the
 * columns to the caller's own matcher.
 */

export interface ReviewTextSearchRequest {
  root: string
  /** The review's head; null searches the working tree. */
  revision: string | null
  paths: readonly string[]
  query: string
  caseSensitive: boolean
}

export interface ReviewTextLine {
  path: string
  /** 1-based, in the file's new version. */
  line: number
  text: string
}

export interface ReviewTextSearchReply {
  lines: ReviewTextLine[]
  truncated: boolean
}

const MAX_LINES = 5_000
const MAX_LINE_LENGTH = 4_000
const OUTPUT_LIMIT = 8 * 1024 * 1024
const TIMEOUT_MS = 4_000
// Paths go on the command line; batches keep each one well under ARG_MAX.
const PATHS_PER_RUN = 400

export function isSearchableQuery(query: string): boolean {
  return query !== '' && query.length <= 500 && !query.includes('\n') && !query.includes('\0')
}

interface RunOptions {
  spawn?: typeof spawnChild
  ripgrep: string
}

/**
 * One spawn's output as lines. ripgrep prints `path\0line:text`, git grep
 * `revision:path\0line\0text`; both end each record with a newline.
 */
function runSearch(
  command: string,
  args: readonly string[],
  cwd: string,
  parse: (record: string) => ReviewTextLine | null,
  budget: { lines: number },
  spawn: typeof spawnChild
): Promise<{ lines: ReviewTextLine[]; truncated: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    const lines: ReviewTextLine[] = []
    let pending = ''
    let bytes = 0
    let truncated = false
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve({ lines, truncated })
    }
    const timer = setTimeout(() => {
      truncated = true
      finish()
    }, TIMEOUT_MS)
    const take = (record: string): void => {
      if (record === '' || settled) return
      const parsed = parse(record)
      if (parsed == null) return
      if (budget.lines <= 0) {
        truncated = true
        finish()
        return
      }
      budget.lines -= 1
      lines.push(parsed)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      bytes += chunk.length
      pending += chunk
      const records = pending.split('\n')
      pending = records.pop() ?? ''
      for (const record of records) take(record)
      if (bytes >= OUTPUT_LIMIT) {
        truncated = true
        finish()
      }
    })
    child.on('error', finish)
    child.on('close', () => {
      take(pending)
      finish()
    })
  })
}

function parseRipgrep(record: string): ReviewTextLine | null {
  const split = record.indexOf('\0')
  if (split === -1) return null
  const rest = record.slice(split + 1)
  const colon = rest.indexOf(':')
  const line = Number(rest.slice(0, colon))
  if (colon === -1 || !Number.isInteger(line)) return null
  const text = rest.slice(colon + 1)
  return { path: record.slice(0, split).replace(/^\.\//, ''), line, text: text.endsWith('\r') ? text.slice(0, -1) : text }
}

function parseGitGrep(revision: string): (record: string) => ReviewTextLine | null {
  const prefix = `${revision}:`
  return (record) => {
    const [name, number, ...text] = record.split('\0')
    const line = Number(number)
    if (name == null || !name.startsWith(prefix) || !Number.isInteger(line)) return null
    const joined = text.join('\0')
    return { path: name.slice(prefix.length), line, text: joined.endsWith('\r') ? joined.slice(0, -1) : joined }
  }
}

export async function searchReviewText(request: ReviewTextSearchRequest, options: RunOptions): Promise<ReviewTextSearchReply> {
  const { root, revision, query, caseSensitive } = request
  if (!isSearchableQuery(query)) return { lines: [], truncated: false }
  const paths = request.paths.filter((path) => path !== '' && !path.includes('\0') && !path.startsWith('-'))
  const spawn = options.spawn ?? spawnChild
  const budget = { lines: MAX_LINES }
  const found: ReviewTextLine[] = []
  let truncated = false
  for (let start = 0; start < paths.length && budget.lines > 0; start += PATHS_PER_RUN) {
    const batch = paths.slice(start, start + PATHS_PER_RUN)
    const result = revision == null
      ? await runSearch(options.ripgrep, [
        '--no-config', '--fixed-strings', '--line-number', '--no-heading', '--with-filename', '--null',
        '--no-ignore', '--hidden', '--max-columns', String(MAX_LINE_LENGTH), '--threads', '2',
        ...(caseSensitive ? ['--case-sensitive'] : ['--ignore-case']),
        '-e', query, '--', ...batch
      ], root, parseRipgrep, budget, spawn)
      : await runSearch('git', [
        '--no-pager', 'grep', '--no-color', '-I', '-n', '--null', '--fixed-strings',
        ...(caseSensitive ? [] : ['--ignore-case']),
        '-e', query, revision, '--', ...batch
      ], root, parseGitGrep(revision), budget, spawn)
    // ripgrep stands a long line in with a notice instead of its text.
    found.push(...result.lines.filter((line) => line.text.length <= MAX_LINE_LENGTH && !line.text.startsWith('[Omitted long line')))
    truncated ||= result.truncated
  }
  return { lines: found, truncated: truncated || budget.lines <= 0 }
}
