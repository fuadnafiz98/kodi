import { createHash } from 'node:crypto'
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import type { NormalizedGuide } from '../../shared/reviewGuide.js'
import { writeFileAtomic } from '../atomicWrite.js'

export const GUIDE_CACHE_DIRECTORY = 'review-guides'
export const MAX_STORED_GUIDES = 200
const MAX_STORED_GUIDE_BYTES = 8 * 1024 * 1024

/**
 * JSON with keys sorted at every level, so the key does not depend on the order
 * an object happened to be built in.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value != null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export interface GuideCacheKeyInput {
  provider: string
  model: string
  prompt: string
  schemaVersion: number
  hunkIds: readonly string[]
  fingerprints: readonly string[]
  categories: Readonly<Record<string, string>>
}

/** The diff's identity plus what was asked of whom: anything else is a new guide. */
export function guideCacheKey(input: GuideCacheKeyInput): string {
  return createHash('sha256').update(canonicalJson({
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    schemaVersion: input.schemaVersion,
    hunkIds: input.hunkIds,
    fingerprints: input.fingerprints,
    categories: input.categories
  })).digest('hex')
}

function guidePath(userDataPath: string, key: string): string {
  return join(userDataPath, GUIDE_CACHE_DIRECTORY, `${createHash('sha256').update(key).digest('hex')}.json`)
}

/** Rule 1 of normalisation, plus files on every section: enough to render. */
export function isStoredGuideShape(value: unknown): value is NormalizedGuide {
  if (typeof value !== 'object' || value == null) return false
  const guide = value as Record<string, unknown>
  return guide.version === 1 && guide.kind === 'review-guide' && typeof guide.title === 'string' &&
    Array.isArray(guide.sections) && guide.sections.length > 0 &&
    guide.sections.every((section: unknown) => typeof section === 'object' && section != null &&
      Array.isArray((section as Record<string, unknown>).files)) &&
    typeof guide.facts === 'object' && guide.facts != null
}

export async function readStoredGuide(userDataPath: string, key: string): Promise<NormalizedGuide | null> {
  const path = guidePath(userDataPath, key)
  try {
    const handle = await open(path, 'r')
    try {
      const info = await handle.stat()
      if (info.size > MAX_STORED_GUIDE_BYTES) return null
      const parsed: unknown = JSON.parse(await handle.readFile('utf8'))
      return isStoredGuideShape(parsed) ? parsed : null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

export async function writeStoredGuide(
  userDataPath: string,
  key: string,
  guide: NormalizedGuide,
  maxEntries = MAX_STORED_GUIDES
): Promise<void> {
  const directory = join(userDataPath, GUIDE_CACHE_DIRECTORY)
  await mkdir(directory, { recursive: true })
  await writeFileAtomic(guidePath(userDataPath, key), JSON.stringify(guide))
  const names = (await readdir(directory)).filter((name) => name.endsWith('.json'))
  if (names.length <= maxEntries) return
  const aged = await Promise.all(names.map(async (name) => {
    const info = await stat(join(directory, name)).catch(() => null)
    return { name, mtime: info?.mtimeMs ?? 0 }
  }))
  aged.sort((left, right) => left.mtime - right.mtime)
  await Promise.all(aged.slice(0, names.length - maxEntries)
    .map(({ name }) => unlink(join(directory, name)).catch(() => undefined)))
}
