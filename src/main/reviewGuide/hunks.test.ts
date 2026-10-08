import { describe, expect, test } from 'bun:test'

import { categorizePath } from '../../shared/reviewCategories.js'
import { guideScopeForSubject, hunkFingerprint, indexReviewHunks, parsePatchHunks, parsePatchSections } from './hunks.js'
import { binaryFile, joinPatch, modifiedFile, renamedFile } from './testFixtures.js'

const TWO_FILES = joinPatch(
  modifiedFile('a.ts', [
    { oldStart: 1, newStart: 1, lines: [' one', '-two', '+TWO', ' three'] },
    { oldStart: 40, newStart: 40, lines: [' forty', '+forty-one', '+forty-two'] }
  ]),
  modifiedFile('b.ts', [{ oldStart: 10, newStart: 10, lines: [' ten', '-eleven'] }])
)

describe('parsePatchHunks', () => {
  test('reads every hunk with its ranges and counts', () => {
    const hunks = parsePatchHunks(TWO_FILES)
    expect(hunks.map((hunk) => [hunk.path, hunk.ordinal, hunk.oldStart, hunk.newStart, hunk.added, hunk.deleted]))
      .toEqual([['a.ts', 1, 1, 1, 1, 1], ['a.ts', 2, 40, 40, 2, 0], ['b.ts', 1, 10, 10, 0, 1]])
    expect(hunks[0]!.oldCount).toBe(3)
    expect(hunks[0]!.newCount).toBe(3)
  })

  test('quoted paths with spaces are decoded', () => {
    const patch = joinPatch([
      'diff --git "a/a b.ts" "b/a b.ts"',
      'index 1111111..2222222 100644',
      '--- "a/a b.ts"',
      '+++ "b/a b.ts"',
      '@@ -1 +1 @@',
      '-x',
      '+y'
    ].join('\n'))
    expect(parsePatchSections(patch)[0]?.path).toBe('a b.ts')
  })
})

describe('indexReviewHunks', () => {
  const index = (patch: string, scope = 'wt') => indexReviewHunks(parsePatchSections(patch), scope, (path) => categorizePath(path))

  test('gives each hunk an id in the review scope', () => {
    const result = index(TWO_FILES, 'wt')
    expect([...result.byId.keys()]).toEqual(['a.ts:wt:h1', 'a.ts:wt:h2', 'b.ts:wt:h1'])
    const second = result.byId.get('a.ts:wt:h2')!
    expect(second).toMatchObject({ kind: 'patch', side: 'additions', startLine: 40, endLine: 42, added: 2, deleted: 0 })
    expect(result.byId.get('b.ts:wt:h1')).toMatchObject({ side: 'deletions', startLine: 10, endLine: 11 })
  })

  test('a binary file is one synthetic hunk', () => {
    const result = index(joinPatch(binaryFile('logo.png')))
    expect(result.files[0]!.hunks).toHaveLength(1)
    expect(result.files[0]!.hunks[0]).toMatchObject({ id: 'logo.png:wt:h1', kind: 'synthetic', summary: 'Binary change.', startLine: null })
  })

  test('a lockfile with many hunks is one synthetic hunk with summed counts', () => {
    const lockfile = modifiedFile('bun.lock', [1, 20, 40, 60, 80].map((start) => ({
      oldStart: start, newStart: start, lines: [' a', '-b', '+c', '+d']
    })))
    const result = index(joinPatch(lockfile))
    const file = result.files[0]!
    expect(file.generated).toBe(true)
    expect(file.hunks).toHaveLength(1)
    expect(file.hunks[0]).toMatchObject({ kind: 'synthetic', added: 10, deleted: 5, summary: 'Lockfile collapsed into one review unit.' })
  })

  test('a rename without content is one synthetic hunk', () => {
    const result = index(joinPatch(renamedFile('old.ts', 'new.ts')))
    expect(result.files[0]).toMatchObject({ path: 'new.ts', previousPath: 'old.ts', status: 'renamed' })
    expect(result.files[0]!.hunks[0]).toMatchObject({ kind: 'synthetic', summary: 'Rename without content changes.' })
    expect(result.byPath.get('old.ts')?.path).toBe('new.ts')
  })

  test('the fingerprint ignores where the hunk sits', () => {
    const lines = [' a', '-b', '+c']
    const early = index(joinPatch(modifiedFile('x.ts', [{ oldStart: 1, newStart: 1, lines }])))
    const late = index(joinPatch(modifiedFile('x.ts', [{ oldStart: 90, newStart: 95, lines }])))
    expect(early.files[0]!.hunks[0]!.fingerprint).toBe(late.files[0]!.hunks[0]!.fingerprint)
    expect(early.files[0]!.hunks[0]!.fingerprint).toMatch(/^f[0-9a-f]{16}$/)
    expect(hunkFingerprint('@@ -1 +1 @@\r\n-a\r\n+b')).toBe(hunkFingerprint('@@ -5 +5 @@\n-a\n+b'))
  })

  test('scopes follow the review kind', () => {
    const base = { tabId: 't', repositoryRoot: '/r', repositoryName: 'r', baseOid: 'a'.repeat(40), headOid: 'b'.repeat(40) }
    expect(guideScopeForSubject({ ...base, source: 'workingTree' })).toBe('wt')
    expect(guideScopeForSubject({ ...base, source: 'patch', pullRequestUrl: 'https://github.com/o/r/pull/75' })).toBe('pull-request:75')
    expect(guideScopeForSubject({ ...base, source: 'patch' })).toBe('b'.repeat(40))
  })
})
