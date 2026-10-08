import type { GuideFileCategory } from '../shared/reviewGuide.js'
import { categorizePath, REVIEW_CATEGORY_ATTRIBUTES, type ReviewFileAttributes } from '../shared/reviewCategories.js'
import { runCommand, splitNullDelimited } from './gitCommands.js'

const GENERATED_ATTRIBUTES = ['linguist-generated', 'gitlab-generated'] as const
const ATTRIBUTES = [...GENERATED_ATTRIBUTES, ...REVIEW_CATEGORY_ATTRIBUTES.map(([attribute]) => attribute)]
const CATEGORY_BY_ATTRIBUTE = new Map(REVIEW_CATEGORY_ATTRIBUTES)
// Like the pathspec batches: one stdin write well under a pipe's worth per call.
const STDIN_CHUNK_BYTES = 128 * 1024

export interface ReviewFileMarks {
  generated: Set<string>
  categories: Map<string, GuideFileCategory>
  attributes: Map<string, ReviewFileAttributes>
}

let sourceSupport: Promise<boolean> | null = null

/** `git check-attr --source` arrived in 2.40; older gits read the working tree's attributes. */
function checkAttrTakesSource(): Promise<boolean> {
  sourceSupport ??= runCommand('git', ['--version']).then((result) => {
    const match = /(\d+)\.(\d+)/.exec(result.stdout.toString('utf8'))
    return match != null && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 40))
  }, () => false)
  return sourceSupport
}

function chunks(paths: readonly string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let bytes = 0
  for (const path of paths) {
    const size = Buffer.byteLength(path) + 1
    if (current.length > 0 && bytes + size > STDIN_CHUNK_BYTES) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push(path)
    bytes += size
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/** What `.gitattributes` says about each path: `-z` output is `path\0attribute\0value\0`. */
export function parseCheckAttr(output: Buffer): Map<string, ReviewFileAttributes> {
  const fields = splitNullDelimited(output)
  const attributes = new Map<string, ReviewFileAttributes>()
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const path = fields[index]
    const attribute = fields[index + 1]
    const value = fields[index + 2]
    if (path == null || path === '' || attribute == null || value == null || value === 'unspecified') continue
    const entry = attributes.get(path) ?? {}
    if ((GENERATED_ATTRIBUTES as readonly string[]).includes(attribute)) {
      // `-linguist-generated` or `linguist-generated=false` says "not generated",
      // which overrides the path heuristics; set wins over unset across the two.
      const generated = value !== 'unset' && value !== 'false'
      if (entry.generated !== true) entry.generated = generated
    } else {
      const category = CATEGORY_BY_ATTRIBUTE.get(attribute)
      if (category != null && value !== 'unset' && value !== 'false' && entry.category == null) entry.category = category
    }
    attributes.set(path, entry)
  }
  return attributes
}

/**
 * Generated files and review categories for a review's paths, in one
 * `git check-attr` per 128 KB of paths. `revision` reads the attributes as
 * they were at that commit (a pull request's head) where git can.
 * Heuristics alone when git cannot answer.
 */
export async function markReviewFiles(
  root: string,
  paths: readonly string[],
  revision?: string | null,
  signal?: AbortSignal
): Promise<ReviewFileMarks> {
  const attributes = new Map<string, ReviewFileAttributes>()
  if (paths.length > 0) {
    const source = revision != null && /^[0-9a-f]{40}$/i.test(revision) && await checkAttrTakesSource()
      ? [`--source=${revision}`]
      : []
    for (const batch of chunks(paths)) {
      try {
        const result = await runCommand(
          'git', ['check-attr', '-z', '--stdin', ...source, ...ATTRIBUTES], root, [], `${batch.join('\0')}\0`, signal, 'background'
        )
        for (const [path, entry] of parseCheckAttr(result.stdout)) attributes.set(path, entry)
      } catch (error) {
        if (signal?.aborted === true) throw error
        // A folder outside git, or a revision git does not have: the heuristics stand.
        break
      }
    }
  }
  const generated = new Set<string>()
  const categories = new Map<string, GuideFileCategory>()
  for (const path of paths) {
    const category = categorizePath(path, attributes.get(path))
    categories.set(path, category)
    if (category === 'generated') generated.add(path)
  }
  return { generated, categories, attributes }
}
