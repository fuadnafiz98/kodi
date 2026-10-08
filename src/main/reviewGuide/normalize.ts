import type {
  GuideFacts,
  GuideFile,
  GuideFileCategory,
  GuideHunk,
  GuideSection,
  NormalizedGuide
} from '../../shared/reviewGuide.js'
import type { GuideAliases } from './digest.js'
import type { ReviewHunk, ReviewHunkFile, ReviewHunkIndex } from './hunks.js'
import {
  MAX_BODY_CHARS,
  MAX_COMMIT_TITLE_CHARS,
  MAX_GUIDE_TITLE_CHARS,
  MAX_OVERVIEW_CHARS,
  MAX_REFS_PER_SECTION,
  MAX_SECTIONS,
  MAX_TITLE_CHARS
} from './schema.js'

/** The model's or the file's guide could not be read at all. */
export class GuideShapeError extends Error {
  constructor() {
    super('The guide was not understood.')
    this.name = 'GuideShapeError'
  }
}

/** The guide parsed, but none of its core sections names part of this diff. */
export class GuideNoMatchError extends Error {
  constructor(message = 'The guide did not match the change.') {
    super(message)
    this.name = 'GuideNoMatchError'
  }
}

const MAX_COMMIT_BODY_CHARS = 4_000
const MAX_SECTION_ID_CHARS = 64

const AUTOMATIC_ORDER: readonly GuideFileCategory[] = [
  'test',
  'documentation',
  'agent-guidance',
  'localization',
  'assets',
  'generated',
  'implementation'
]

export const AUTOMATIC_SECTIONS: Readonly<Record<GuideFileCategory, { title: string; body: string }>> = {
  test: { title: 'Tests', body: 'Test changes the sections above do not cover.' },
  documentation: { title: 'Documentation', body: 'Documentation changes the sections above do not cover.' },
  'agent-guidance': { title: 'Agent guidance', body: 'Instructions for coding agents that changed alongside the code.' },
  localization: { title: 'Localization', body: 'Translation and locale changes the sections above do not cover.' },
  assets: { title: 'Assets', body: 'Images, fonts and other binary assets.' },
  generated: { title: 'Generated files', body: 'Lockfiles, snapshots and generated code, collapsed by default.' },
  implementation: { title: 'Other changes', body: 'Implementation changes the sections above do not cover.' }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function cap(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit - 1).trimEnd()}…`
}

/**
 * Plain sentences only: headings, list markers and fenced blocks are flattened
 * or dropped, inline backticks stay. The column has no room for structure, and
 * a heading in a model's paragraph is a sign it ignored the contract.
 */
export function flattenProse(text: string): string {
  const kept: string[] = []
  let fenced = false
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    kept.push(line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, ''))
  }
  return kept.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * A hunk id is `<path>:<scope>:h<n>`, and both a path and a scope
 * (`pull-request:12`) may contain colons, so the path is the longest known one.
 * An optional `@f<16 hex>` suffix pins the hunk's content.
 */
function parseHunkRef(
  ref: string,
  index: ReviewHunkIndex
): { file: ReviewHunkFile; scope: string; ordinal: number; fingerprint: string | null } | null {
  const pinned = /^(.*):h(\d+)(?:@(f[0-9a-f]{16}))?$/.exec(ref)
  if (pinned == null) return null
  const prefix = pinned[1]!
  const ordinal = Number(pinned[2])
  let best: ReviewHunkFile | null = null
  let bestLength = -1
  for (const [path, file] of index.byPath) {
    if (path.length > bestLength && prefix.startsWith(`${path}:`) && prefix.length > path.length + 1) {
      best = file
      bestLength = path.length
    }
  }
  if (best == null) return null
  return { file: best, scope: prefix.slice(bestLength + 1), ordinal, fingerprint: pinned[3] ?? null }
}

/** The live hunks a ref names; empty when it names nothing in this diff. */
export function resolveGuideRef(
  ref: string,
  index: ReviewHunkIndex,
  aliases: GuideAliases | null
): ReviewHunk[] {
  const trimmed = ref.trim()
  if (aliases != null) {
    const aliasedFile = aliases.files.get(trimmed)
    if (aliasedFile != null) return index.byPath.get(aliasedFile)?.hunks ?? []
    const aliasedHunk = aliases.hunks.get(trimmed)
    if (aliasedHunk != null) {
      const hunk = index.byId.get(aliasedHunk)
      return hunk == null ? [] : [hunk]
    }
  }
  const direct = index.byId.get(trimmed)
  if (direct != null) return [direct]
  const file = index.byPath.get(trimmed.replace(/^\.\//, ''))
  if (file != null) return file.hunks
  const parsed = parseHunkRef(trimmed, index)
  if (parsed == null) return []
  // A synthetic file has one hunk whatever the ref's ordinal said when it was
  // written against a diff where the file was still text.
  const live = parsed.file.hunks.find((hunk) => hunk.ordinal === parsed.ordinal) ??
    (parsed.file.hunks.length === 1 && parsed.file.hunks[0]!.kind === 'synthetic' ? parsed.file.hunks[0] : undefined)
  if (live == null) return []
  if (parsed.scope === index.scope) {
    return parsed.fingerprint == null || parsed.fingerprint === live.fingerprint ? [live] : []
  }
  // Another scope (written against `staged`, or before a rebase): the hunk at
  // the same place stands in for it unless its pinned content differs.
  if (parsed.fingerprint != null && parsed.fingerprint !== live.fingerprint) return []
  return [live]
}

interface RawSection {
  id: string
  title: string
  body: string
  kind: 'core' | 'supporting'
  refs: string[]
}

function readSections(value: unknown): RawSection[] {
  if (!Array.isArray(value) || value.length === 0) throw new GuideShapeError()
  const sections: RawSection[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate == null || Array.isArray(candidate)) continue
    const record = candidate as Record<string, unknown>
    const refs = Array.isArray(record.refs)
      ? record.refs.filter((ref): ref is string => typeof ref === 'string' && ref.length <= 4_096)
      : []
    sections.push({
      id: readString(record.id)?.trim().slice(0, MAX_SECTION_ID_CHARS) ?? '',
      title: readString(record.title) ?? '',
      body: readString(record.body) ?? '',
      kind: record.kind === 'supporting' ? 'supporting' : 'core',
      refs: refs.slice(0, MAX_REFS_PER_SECTION)
    })
  }
  return sections
}

function guideFile(file: ReviewHunkFile, home: boolean, focus: readonly ReviewHunk[]): GuideFile {
  return {
    path: file.path,
    ...(file.previousPath == null ? {} : { previousPath: file.previousPath }),
    category: file.category,
    generated: file.generated,
    added: file.added,
    deleted: file.deleted,
    home,
    focus: [...focus]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(toGuideHunk)
  }
}

function toGuideHunk(hunk: ReviewHunk): GuideHunk {
  return {
    id: hunk.id,
    fingerprint: hunk.fingerprint,
    kind: hunk.kind,
    side: hunk.side,
    startLine: hunk.startLine,
    endLine: hunk.endLine,
    added: hunk.added,
    deleted: hunk.deleted,
    ...(hunk.summary == null ? {} : { summary: hunk.summary })
  }
}

function sectionCounts(files: readonly GuideFile[]): Pick<GuideSection, 'added' | 'deleted' | 'implementationAdded' | 'implementationDeleted'> {
  let added = 0
  let deleted = 0
  let implementationAdded = 0
  let implementationDeleted = 0
  for (const file of files) {
    for (const hunk of file.focus) {
      added += hunk.added
      deleted += hunk.deleted
      if (file.category === 'implementation') {
        implementationAdded += hunk.added
        implementationDeleted += hunk.deleted
      }
    }
  }
  return { added, deleted, implementationAdded, implementationDeleted }
}

/**
 * Turns whatever came back (a model's JSON or a guide file) into a guide that
 * matches the live diff exactly. Rules, in order: shape; refs resolved (unknown
 * ones dropped); each hunk owned once; home sections; core, then supporting,
 * then automatic sections for the rest; caps; recomputed counts. Throws
 * GuideShapeError for garbage and GuideNoMatchError when no core section is left.
 */
export function normalizeGuide(
  raw: unknown,
  index: ReviewHunkIndex,
  aliases: GuideAliases | null,
  facts: GuideFacts
): NormalizedGuide {
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) throw new GuideShapeError()
  const record = raw as Record<string, unknown>
  const title = readString(record.title)
  if (record.version !== 1 || record.kind !== 'review-guide' || title == null) throw new GuideShapeError()
  const rawSections = readSections(record.sections)

  // Past the cap, sections fall through to the automatic ones.
  const capped = rawSections.slice(0, MAX_SECTIONS)
  const ordered = [
    ...capped.filter((section) => section.kind === 'core'),
    ...capped.filter((section) => section.kind === 'supporting')
  ]

  const owner = new Map<string, number>()
  const homeOf = new Map<string, number>()
  const usedIds = new Set<string>()
  const modelSections: Array<{ raw: RawSection; files: Array<{ file: ReviewHunkFile; focus: ReviewHunk[] }> }> = []
  for (const section of ordered) {
    const sectionIndex = modelSections.length
    const files: Array<{ file: ReviewHunkFile; focus: ReviewHunk[] }> = []
    const byPath = new Map<string, { file: ReviewHunkFile; focus: ReviewHunk[] }>()
    for (const ref of section.refs) {
      for (const hunk of resolveGuideRef(ref, index, aliases)) {
        if (owner.has(hunk.id)) continue
        owner.set(hunk.id, sectionIndex)
        const file = index.byPath.get(hunk.path)
        if (file == null) continue
        let entry = byPath.get(file.path)
        if (entry == null) {
          entry = { file, focus: [] }
          byPath.set(file.path, entry)
          files.push(entry)
        }
        entry.focus.push(hunk)
      }
    }
    if (files.length === 0) {
      // Nothing owned: hand back what was taken (nothing) and drop the section.
      continue
    }
    for (const { file } of files) if (!homeOf.has(file.path)) homeOf.set(file.path, sectionIndex)
    modelSections.push({ raw: section, files })
  }

  if (!modelSections.some((section) => section.raw.kind === 'core')) throw new GuideNoMatchError()

  const sections: GuideSection[] = modelSections.map((section, sectionIndex) => {
    let id = section.raw.id === '' ? `section-${sectionIndex + 1}` : section.raw.id
    if (usedIds.has(id)) {
      let suffix = 2
      while (usedIds.has(`${id}-${suffix}`)) suffix += 1
      id = `${id}-${suffix}`
    }
    usedIds.add(id)
    const files = section.files.map(({ file, focus }) => guideFile(file, homeOf.get(file.path) === sectionIndex, focus))
    return {
      id,
      number: sectionIndex + 1,
      title: cap(flattenProse(section.raw.title), MAX_TITLE_CHARS) || `Part ${sectionIndex + 1}`,
      body: cap(flattenProse(section.raw.body), MAX_BODY_CHARS),
      kind: section.raw.kind,
      automatic: false,
      files,
      ...sectionCounts(files)
    }
  })

  // Every hunk no section owns lands in a supporting section by category.
  const leftovers = new Map<GuideFileCategory, Array<{ file: ReviewHunkFile; focus: ReviewHunk[] }>>()
  for (const file of [...index.files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    const focus = file.hunks.filter((hunk) => !owner.has(hunk.id))
    if (focus.length === 0) continue
    const list = leftovers.get(file.category) ?? []
    list.push({ file, focus })
    leftovers.set(file.category, list)
  }
  for (const category of AUTOMATIC_ORDER) {
    const list = leftovers.get(category)
    if (list == null) continue
    const files = list.map(({ file, focus }) => guideFile(file, !homeOf.has(file.path), focus))
    for (const { file } of list) if (!homeOf.has(file.path)) homeOf.set(file.path, sections.length)
    sections.push({
      id: `supporting-${category}`,
      number: null,
      title: AUTOMATIC_SECTIONS[category].title,
      body: AUTOMATIC_SECTIONS[category].body,
      kind: 'supporting',
      automatic: true,
      category,
      files,
      ...sectionCounts(files)
    })
  }

  const totals = { added: 0, deleted: 0, implementationAdded: 0, implementationDeleted: 0, files: index.files.length }
  for (const file of index.files) {
    totals.added += file.added
    totals.deleted += file.deleted
    if (file.category === 'implementation') {
      totals.implementationAdded += file.added
      totals.implementationDeleted += file.deleted
    }
  }

  const overview = readString(record.overview)
  const commitRecord = typeof record.commit === 'object' && record.commit != null && !Array.isArray(record.commit)
    ? record.commit as Record<string, unknown>
    : null
  const commitTitle = readString(commitRecord?.title)?.trim() ?? ''
  const commit = facts.subject.source === 'workingTree' && commitTitle !== ''
    ? {
        title: cap(commitTitle.split('\n')[0]!, MAX_COMMIT_TITLE_CHARS),
        body: cap(readString(commitRecord?.body)?.trim() ?? '', MAX_COMMIT_BODY_CHARS)
      }
    : null
  const flatOverview = overview == null ? '' : cap(flattenProse(overview), MAX_OVERVIEW_CHARS)

  return {
    version: 1,
    kind: 'review-guide',
    title: cap(flattenProse(title), MAX_GUIDE_TITLE_CHARS) || 'Review guide',
    ...(flatOverview === '' ? {} : { overview: flatOverview }),
    sections,
    sectionCount: modelSections.length,
    totals,
    ...(commit == null ? {} : { commit }),
    facts
  }
}
