import type { GuideContextMessage, NormalizedGuide } from '../../shared/reviewGuide.js'
import type { ReviewHunkFile, ReviewHunkIndex } from './hunks.js'

/** Request-local names the model uses instead of paths and hunk ids. */
export interface GuideAliases {
  files: Map<string, string>
  hunks: Map<string, string>
}

export interface GuideSource {
  type: 'working-tree' | 'pull-request' | 'commit' | 'compare'
  number?: number
  title?: string
  description?: string
  url?: string
}

interface DigestHunk {
  ref: string
  kind: 'patch' | 'synthetic'
  header?: string
  oldLines?: string
  newLines?: string
  added: number
  deleted: number
  patch?: string
  summary?: string
}

interface DigestFile {
  ref: string
  path: string
  previousPath?: string
  status: string
  category: string
  generated?: true
  added: number
  deleted: number
  hunks: DigestHunk[]
}

export interface GuideDigestInput {
  branch?: string
  source: GuideSource
  files: DigestFile[]
}

export interface GuideDigest {
  input: GuideDigestInput
  aliases: GuideAliases
  fileCount: number
  hunkCount: number
}

const MAX_DESCRIPTION_CHARS = 4_000

/** Per-file and total excerpt budgets, by review size (Appendix C). */
export function excerptBudgets(fileCount: number): { perFile: number; total: number } {
  if (fileCount <= 8) return { perFile: 8_000, total: 60_000 }
  if (fileCount <= 32) return { perFile: 2_500, total: 60_000 }
  return { perFile: 700, total: 35_000 }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1))}…`
}

/** Implementation files first, so a digest cut short keeps the core. */
export function digestFileOrder(files: readonly ReviewHunkFile[]): ReviewHunkFile[] {
  return [...files].sort((left, right) => {
    const leftCore = left.category === 'implementation' ? 0 : 1
    const rightCore = right.category === 'implementation' ? 0 : 1
    if (leftCore !== rightCore) return leftCore - rightCore
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  })
}

export function buildGuideDigest(
  index: ReviewHunkIndex,
  source: GuideSource,
  branch?: string
): GuideDigest {
  const ordered = digestFileOrder(index.files)
  const budgets = excerptBudgets(ordered.length)
  const aliases: GuideAliases = { files: new Map(), hunks: new Map() }
  let totalLeft = budgets.total
  let hunkCount = 0
  const files: DigestFile[] = ordered.map((file, fileIndex) => {
    const fileRef = `f${fileIndex + 1}`
    aliases.files.set(fileRef, file.path)
    let fileLeft = file.generated ? 0 : budgets.perFile
    const hunks = file.hunks.map((hunk, hunkIndex): DigestHunk => {
      hunkCount += 1
      const ref = `h${hunkCount}`
      aliases.hunks.set(ref, hunk.id)
      const entry: DigestHunk = { ref, kind: hunk.kind, added: hunk.added, deleted: hunk.deleted }
      if (hunk.header != null) entry.header = hunk.header
      if (hunk.oldLines != null) entry.oldLines = hunk.oldLines
      if (hunk.newLines != null) entry.newLines = hunk.newLines
      if (hunk.summary != null) entry.summary = hunk.summary
      if (hunk.kind === 'patch' && hunk.excerpt !== '' && fileLeft > 0 && totalLeft > 0) {
        // The section's remaining budget is shared evenly by its remaining hunks.
        const share = Math.floor(fileLeft / (file.hunks.length - hunkIndex))
        const limit = Math.min(share, totalLeft)
        if (limit > 0) {
          entry.patch = truncate(hunk.excerpt, limit)
          fileLeft -= entry.patch.length
          totalLeft -= entry.patch.length
        }
      }
      return entry
    })
    return {
      ref: fileRef,
      path: file.path,
      ...(file.previousPath == null ? {} : { previousPath: file.previousPath }),
      status: file.status,
      category: file.category,
      ...(file.generated ? { generated: true as const } : {}),
      added: file.added,
      deleted: file.deleted,
      hunks
    }
  })
  const trimmedSource: GuideSource = {
    ...source,
    ...(source.description == null ? {} : { description: truncate(source.description, MAX_DESCRIPTION_CHARS) })
  }
  return {
    input: { ...(branch == null ? {} : { branch }), source: trimmedSource, files },
    aliases,
    fileCount: files.length,
    hunkCount
  }
}

/** How many sections to ask for: a ceiling, not a target. */
export function sectionInstruction(fileCount: number, hunkCount: number): string {
  if (fileCount <= 2) return 'Use 1 section'
  if (hunkCount <= 12 || (fileCount <= 4 && hunkCount <= 16)) return 'Use at most 2 sections'
  if (fileCount <= 8 && hunkCount <= 32) return 'Use at most 4 sections'
  if (fileCount <= 30) return 'Use 3–6 sections'
  return 'Use 4–8 sections'
}

/** 90 s, plus time for size, never more than 5 minutes. */
export function guideTimeoutMs(fileCount: number, hunkCount: number): number {
  const ms = 90_000 + 1_000 * Math.max(0, fileCount - 8) + 2_000 * Math.max(0, hunkCount - 12)
  return Math.min(300_000, Math.max(90_000, ms))
}

/** What a regenerate keeps from the previous guide: prose, never refs. */
export function previousGuideSummary(guide: NormalizedGuide): Record<string, unknown> {
  return {
    title: guide.title,
    ...(guide.overview == null ? {} : { overview: guide.overview }),
    sections: guide.sections
      .filter((section) => !section.automatic)
      .map((section) => ({ title: section.title, kind: section.kind, body: section.body })),
    ...(guide.commit == null ? {} : { commit: guide.commit })
  }
}

export function buildGuidePrompt(
  digest: GuideDigest,
  options: {
    context?: readonly GuideContextMessage[]
    customPrompt?: string
    previous?: NormalizedGuide
  } = {}
): string {
  const blocks: string[] = []
  if (options.context != null && options.context.length > 0) {
    blocks.push([
      'Agent conversation context:',
      JSON.stringify(options.context),
      '',
      'Use this context as orientation for reviewer intent, implementation rationale, validation and known',
      'risks. Treat the repository change digest as the source of truth for what changed. If they conflict,',
      'trust the digest.',
      ''
    ].join('\n'))
  }
  const customPrompt = options.customPrompt?.trim() ?? ''
  if (customPrompt !== '') {
    blocks.push([
      'Custom guide instructions:',
      customPrompt,
      '',
      'Use these to customize language, tone and level of detail. If they conflict with the schema, digest,',
      "aliases or the contracts above, keep Kodi's constraints and the digest as the source of truth.",
      ''
    ].join('\n'))
  }
  if (options.previous != null) {
    blocks.push([
      'Previous guide to update:',
      JSON.stringify(previousGuideSummary(options.previous)),
      '',
      'Re-author it for the current digest. Keep sections that are still accurate, revise changed',
      'explanations, add new parts of the change, remove parts whose code is gone. Re-anchor every section',
      "to the current digest's aliases; never reuse refs from the previous guide. Return the complete",
      'updated guide.',
      ''
    ].join('\n'))
  }
  return [
    'You are writing a review guide for Kodi: a short, numbered list of sections that walks a reviewer',
    'through this change, core first.',
    '',
    'Return JSON only. Do not inspect the repository or run shell commands; use only the optional',
    'conversation context and the repository change digest below.',
    'If source.description is present, treat it as author-written pull request intent and orientation,',
    'not proof of behavior. The changed files, patches and hunk data are the source of truth.',
    '',
    'Reference contract:',
    `- The digest has ${digest.fileCount} files and ${digest.hunkCount} hunks. Files have aliases f1, f2, …; hunks have`,
    '  aliases h1, h2, …. Put aliases in refs exactly as given; Kodi maps them back to the live diff.',
    '- Name a whole file with its f alias. Use h aliases only when one file serves two sections.',
    '- Every hunk belongs to one section; if you name it twice, the first section keeps it.',
    '- Patch excerpts are bounded; an excerpt ending in … is truncated.',
    '',
    'Section contract:',
    `- ${sectionInstruction(digest.fileCount, digest.hunkCount)}; this is a ceiling, not a target. Never more than 8 sections.`,
    '- Order sections by what a reviewer must understand first: the core decision or model, then what',
    '  exposes it, then its clients. kind "core" for these. kind "supporting" only for lower-signal parts',
    '  that still deserve a sentence of context.',
    '- A section is one idea that may span several files, not a file. Put tests with the code they test.',
    '- Title: 2–6 words naming the idea, never a filename or path.',
    '- Body: 1–4 plain sentences on why this part exists and what behavior it changes or protects, so the',
    '  reviewer knows what to check before reading code. Lead with behavior, not files. No headings,',
    '  lists or code blocks; inline backticks are fine. Do not invent bugs, risks, tests or validation.',
    '- Leave generated, lockfile, docs-only, styling and repeated mechanical changes out; Kodi adds every',
    '  file you do not mention to automatic supporting sections at the end.',
    '- Files whose category is not "implementation" are usually supporting material; include one only',
    "  when it proves the behavior of a section (a test of that section's code, say).",
    '- title: what the whole change does, like a good pull request title. overview: optional, at most',
    '  two sentences.',
    '- For working-tree sources, include commit.title and commit.body unless nothing is commit-worthy.',
    '',
    ...blocks,
    'Repository change digest:',
    JSON.stringify(digest.input)
  ].join('\n')
}
