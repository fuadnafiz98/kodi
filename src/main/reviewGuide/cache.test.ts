import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { NormalizedGuide } from '../../shared/reviewGuide.js'
import { GUIDE_CACHE_DIRECTORY, guideCacheKey, readStoredGuide, writeStoredGuide } from './cache.js'

const KEY_INPUT = {
  provider: 'claude',
  model: 'sonnet',
  prompt: 'p',
  schemaVersion: 1,
  hunkIds: ['a:wt:h1'],
  fingerprints: ['f0123456789abcdef'],
  categories: { a: 'implementation', b: 'test' }
}

const GUIDE = {
  version: 1,
  kind: 'review-guide',
  title: 'T',
  sections: [{ id: 's', files: [] }],
  facts: { generatedAt: '', provider: 'claude', model: 'sonnet', scope: 'wt' }
} as unknown as NormalizedGuide

describe('guideCacheKey', () => {
  test('does not depend on property order', () => {
    const reordered = { categories: { b: 'test', a: 'implementation' }, fingerprints: KEY_INPUT.fingerprints, hunkIds: KEY_INPUT.hunkIds, schemaVersion: 1, prompt: 'p', model: 'sonnet', provider: 'claude' }
    expect(guideCacheKey(reordered)).toBe(guideCacheKey(KEY_INPUT))
  })

  test('changes with a fingerprint or a category', () => {
    expect(guideCacheKey({ ...KEY_INPUT, fingerprints: ['f1111111111111111'] })).not.toBe(guideCacheKey(KEY_INPUT))
    expect(guideCacheKey({ ...KEY_INPUT, categories: { a: 'test', b: 'test' } })).not.toBe(guideCacheKey(KEY_INPUT))
  })
})

describe('stored guides', () => {
  test('round-trip, ignore oversize or malformed files, and evict the oldest past the cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-guide-cache-'))
    try {
      await writeStoredGuide(directory, 'k1', GUIDE)
      expect(await readStoredGuide(directory, 'k1')).toEqual(GUIDE)
      expect(await readStoredGuide(directory, 'missing')).toBeNull()

      const guides = join(directory, GUIDE_CACHE_DIRECTORY)
      const [stored] = await readdir(guides)
      await writeFile(join(guides, stored!), JSON.stringify({ ...GUIDE, sections: [{ id: 's' }] }))
      expect(await readStoredGuide(directory, 'k1')).toBeNull()
      await writeFile(join(guides, stored!), 'x'.repeat(8 * 1024 * 1024 + 1))
      expect(await readStoredGuide(directory, 'k1')).toBeNull()

      await writeStoredGuide(directory, 'old', GUIDE, 3)
      const [oldName] = (await readdir(guides)).filter((name) => name !== stored)
      await utimes(join(guides, oldName!), new Date(1_000), new Date(1_000))
      await utimes(join(guides, stored!), new Date(2_000), new Date(2_000))
      await writeStoredGuide(directory, 'k2', GUIDE, 3)
      await writeStoredGuide(directory, 'k3', GUIDE, 3)
      const remaining = await readdir(guides)
      expect(remaining).toHaveLength(3)
      expect(remaining).not.toContain(oldName)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
