import type { FileComparison } from '../../../shared/contracts'

export const COMPARISON_CACHE_LIMIT = 24
// Each entry holds both sides of the file, so an unbounded 24-entry cache of 2 MB
// files would be ~100 MB of renderer memory for a feature whose whole point is to
// make the app feel lighter. Big files are simply not admitted; they are also the
// ones a reader revisits least.
export const COMPARISON_CACHE_MAX_CHARS = 4_000_000
export const COMPARISON_ENTRY_MAX_CHARS = 1_000_000

export function comparisonWeight(comparison: FileComparison): number {
  return (comparison.oldFile?.contents.length ?? 0)
    + (comparison.newFile?.contents.length ?? 0)
    + (comparison.image?.old?.dataUrl.length ?? 0)
    + (comparison.image?.new?.dataUrl.length ?? 0)
}

export interface ComparisonCacheOptions {
  limit?: number
  maxChars?: number
  entryMaxChars?: number
}

export interface ComparisonCache {
  get(path: string): FileComparison | null
  has(path: string): boolean
  set(comparison: FileComparison): void
  invalidate(paths: readonly string[]): void
  clear(): void
  readonly size: number
  readonly chars: number
}

export function createComparisonCache({
  limit = COMPARISON_CACHE_LIMIT,
  maxChars = COMPARISON_CACHE_MAX_CHARS,
  entryMaxChars = COMPARISON_ENTRY_MAX_CHARS
}: ComparisonCacheOptions = {}): ComparisonCache {
  // Map iterates in insertion order, so re-inserting on read is the whole LRU.
  const entries = new Map<string, { comparison: FileComparison; weight: number }>()
  let chars = 0

  const evictOldest = (): boolean => {
    const oldest = entries.entries().next().value
    if (oldest == null) return false
    entries.delete(oldest[0])
    chars -= oldest[1].weight
    return true
  }

  const drop = (path: string): void => {
    const entry = entries.get(path)
    if (entry == null) return
    entries.delete(path)
    chars -= entry.weight
  }

  return {
    get(path) {
      const entry = entries.get(path)
      if (entry == null) return null
      entries.delete(path)
      entries.set(path, entry)
      return entry.comparison
    },
    has(path) {
      return entries.has(path)
    },
    set(comparison) {
      drop(comparison.path)
      const weight = comparisonWeight(comparison)
      if (weight > entryMaxChars) return
      entries.set(comparison.path, { comparison, weight })
      chars += weight
      while ((entries.size > limit || chars > maxChars) && entries.size > 1) {
        if (!evictOldest()) break
      }
    },
    invalidate(paths) {
      for (const path of paths) drop(path)
    },
    clear() {
      entries.clear()
      chars = 0
    },
    get size() {
      return entries.size
    },
    get chars() {
      return chars
    }
  }
}
