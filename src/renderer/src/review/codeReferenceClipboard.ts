import { showToast } from '../app/toast'
import { copyTextToClipboard } from '../diff/copyFilePath'
import type { ReviewThread } from './ReviewComments'

/**
 * Code on the clipboard in the form an agent can act on: where it is, and what it
 * says. A review comment is the same thing with the reader's question attached.
 *
 * Markdown rather than the labelled block the built-in chat sends
 * (`describeAgentAttachments`): that one travels with a trusted subject —
 * repository root, revision, delimiters the model is told to distrust — and none
 * of that survives a paste into someone else's prompt. What does survive is a
 * fenced block with an address on it, which every chat box and terminal agent
 * already reads.
 */
export interface CodeReference {
  path: string
  first: number
  last: number
  /** Deletions-side line numbers name the pre-change file, so they say so. */
  side: 'additions' | 'deletions'
}

interface ComparisonContents {
  additions?: string | null
  deletions?: string | null
}

/** The extension is the language hint. A mapping table here would only drift. */
function fenceLanguage(path: string): string {
  const name = path.split('/').at(-1) ?? path
  const extension = name.slice(name.lastIndexOf('.') + 1)
  return name.includes('.') && /^[a-z0-9]+$/i.test(extension) ? extension.toLowerCase() : ''
}

/** Three backticks cannot fence a review of a markdown file that has its own. */
function fence(code: string): string {
  const runs = Array.from(code.matchAll(/`+/g), (match) => match[0].length)
  return '`'.repeat(Math.max(3, ...runs.map((run) => run + 1)))
}

/**
 * `src/app/App.tsx:12-18`, and `(old)` when the lines are the pre-change file's —
 * without it the same numbers name different code.
 */
export function codeReferenceAddress(reference: CodeReference): string {
  const first = Math.min(reference.first, reference.last)
  const last = Math.max(reference.first, reference.last)
  const lines = first === last ? `${first}` : `${first}-${last}`
  return `${reference.path}:${lines}${reference.side === 'deletions' ? ' (old)' : ''}`
}

/** The address, then the code under it. The shape both copy paths share. */
export function formatCodeReference(reference: CodeReference, code: string | null): string {
  const address = codeReferenceAddress(reference)
  if (code == null || code === '') return address
  const rail = fence(code)
  return `${address}\n\n${rail}${fenceLanguage(reference.path)}\n${code}\n${rail}`
}

/** The lines a reference names, read out of the file they are displayed against. */
export function codeFromComparison(
  reference: CodeReference,
  contents: ComparisonContents
): string | null {
  const source = reference.side === 'deletions' ? contents.deletions : contents.additions
  if (source == null) return null
  const lines = source.split(/\r\n|\r|\n/)
  const first = Math.min(reference.first, reference.last)
  const last = Math.max(reference.first, reference.last)
  if (first < 1 || last > lines.length) return null
  return lines.slice(first - 1, last).join('\n')
}

/** The short form a toast can carry: the file's name, not its whole path. */
function shortAddress(reference: CodeReference): string {
  return codeReferenceAddress({
    ...reference,
    path: reference.path.split('/').at(-1) ?? reference.path
  })
}

export async function copyCodeReference(
  reference: CodeReference,
  code: string | null
): Promise<void> {
  const copied = await copyTextToClipboard(`${formatCodeReference(reference, code)}\n`)
  if (!copied) {
    showToast('Could not copy')
    return
  }
  showToast(code == null
    ? `Copied ${shortAddress(reference)}`
    : `Copied code · ${shortAddress(reference)}`)
}

function threadReference(path: string, thread: ReviewThread): CodeReference {
  return {
    path,
    first: thread.range.start,
    last: thread.range.end,
    side: thread.anchor?.side ?? thread.range.endSide ?? thread.range.side ?? 'additions'
  }
}

/**
 * The exact code the comment was written against. The multi-file review stores it
 * on the thread's anchor; the single-file surface keeps no anchor, so its copy is
 * read back out of the comparison the thread is displayed against.
 */
export function reviewCommentCode(
  thread: ReviewThread,
  contents: ComparisonContents = {}
): string | null {
  const anchored = thread.anchor?.selectedText
  if (anchored != null && anchored !== '') return anchored
  return codeFromComparison(threadReference('', thread), contents)
}

export function formatReviewComment(
  path: string,
  thread: ReviewThread,
  code: string | null
): string {
  const bodies = [thread.body, ...thread.replies.map((reply) => reply.body)]
    .map((body) => body.trim())
    .filter((body) => body !== '')
  const reference = formatCodeReference(threadReference(path, thread), code)
  return `${bodies.length === 0 ? reference : `${reference}\n\n${bodies.join('\n\n')}`}\n`
}

export async function copyReviewComment(
  path: string,
  thread: ReviewThread,
  contents?: ComparisonContents
): Promise<void> {
  const code = reviewCommentCode(thread, contents)
  const copied = await copyTextToClipboard(formatReviewComment(path, thread, code))
  if (!copied) {
    showToast('Could not copy comment')
    return
  }
  const short = shortAddress(threadReference(path, thread))
  showToast(code == null ? `Copied comment · ${short}` : `Copied comment and code · ${short}`)
}
