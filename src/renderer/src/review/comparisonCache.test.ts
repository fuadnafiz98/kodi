import { describe, expect, test } from 'bun:test'

import type { FileComparison } from '../../../shared/contracts'
import { comparisonWeight, createComparisonCache } from './comparisonCache'

function comparison(path: string, contents = path): FileComparison {
  return {
    path,
    mode: 'diff',
    status: 'modified',
    oldFile: { name: path, contents, cacheKey: `old:${contents}` },
    newFile: { name: path, contents: `${contents}!`, cacheKey: `new:${contents}` },
    binary: false,
    oversized: false
  }
}

describe('comparisonCache', () => {
  test('returns null for a path it has never seen', () => {
    expect(createComparisonCache().get('a.ts')).toBeNull()
  })

  test('returns the stored comparison by path', () => {
    const cache = createComparisonCache()
    const stored = comparison('a.ts')
    cache.set(stored)
    expect(cache.get('a.ts')).toBe(stored)
  })

  test('replaces an entry rather than double-counting its weight', () => {
    const cache = createComparisonCache()
    cache.set(comparison('a.ts', 'one'))
    const replacement = comparison('a.ts', 'two')
    cache.set(replacement)
    expect(cache.size).toBe(1)
    expect(cache.get('a.ts')).toBe(replacement)
    expect(cache.chars).toBe(comparisonWeight(replacement))
  })

  test('evicts the least recently used entry past the limit', () => {
    const cache = createComparisonCache({ limit: 2 })
    cache.set(comparison('a.ts'))
    cache.set(comparison('b.ts'))
    cache.get('a.ts')
    cache.set(comparison('c.ts'))
    expect(cache.has('b.ts')).toBe(false)
    expect(cache.has('a.ts')).toBe(true)
    expect(cache.has('c.ts')).toBe(true)
  })

  test('refuses an entry larger than the per-entry budget', () => {
    const cache = createComparisonCache({ entryMaxChars: 8 })
    cache.set(comparison('big.ts', 'x'.repeat(64)))
    expect(cache.size).toBe(0)
    expect(cache.chars).toBe(0)
  })

  test('evicts until the total budget holds', () => {
    const cache = createComparisonCache({ limit: 10, maxChars: 40, entryMaxChars: 40 })
    cache.set(comparison('a.ts', 'x'.repeat(15)))
    cache.set(comparison('b.ts', 'y'.repeat(15)))
    expect(cache.size).toBe(1)
    expect(cache.has('b.ts')).toBe(true)
    expect(cache.chars).toBeLessThanOrEqual(40)
  })

  test('invalidates exactly the changed paths', () => {
    const cache = createComparisonCache()
    cache.set(comparison('a.ts'))
    cache.set(comparison('b.ts'))
    cache.invalidate(['a.ts', 'missing.ts'])
    expect(cache.has('a.ts')).toBe(false)
    expect(cache.has('b.ts')).toBe(true)
    expect(cache.chars).toBe(comparisonWeight(comparison('b.ts')))
  })

  test('clear empties the cache and its accounting', () => {
    const cache = createComparisonCache()
    cache.set(comparison('a.ts'))
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.chars).toBe(0)
  })
})
