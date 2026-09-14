import { describe, expect, test } from 'bun:test'

import {
  draftPaths,
  draftStorageKey,
  parseDrafts,
  putDraft,
  readDrafts,
  removeDraft,
  serializeDrafts,
  writeDrafts,
  type DraftMap,
  type DraftStorage
} from './draftStore'

function createStorage(initial: Record<string, string> = {}): DraftStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => { data[key] = value },
    removeItem: (key) => { delete data[key] },
    get length() { return Object.keys(data).length },
    key: (index) => Object.keys(data)[index] ?? null
  }
}

const draft = {
  path: 'src/a.ts',
  sourceCacheKey: 'rev:src/a.ts:1',
  contents: 'hello',
  savedAt: 10
}

describe('draftStore', () => {
  test('scopes the storage key to the repository root', () => {
    expect(draftStorageKey('/repo')).toBe('kodi:drafts:v1:/repo')
    expect(draftStorageKey('/other')).not.toBe(draftStorageKey('/repo'))
  })

  test('putDraft keeps identity when nothing changed', () => {
    const drafts = putDraft({}, draft)
    expect(putDraft(drafts, { ...draft })).toBe(drafts)
    expect(putDraft(drafts, { ...draft, contents: 'hello!' })).not.toBe(drafts)
  })

  test('removeDraft keeps identity when the path is absent', () => {
    const drafts = putDraft({}, draft)
    expect(removeDraft(drafts, 'src/missing.ts')).toBe(drafts)
    expect(draftPaths(removeDraft(drafts, draft.path))).toEqual([])
  })

  test('draftPaths is sorted', () => {
    const drafts = putDraft(putDraft({}, { ...draft, path: 'z.ts' }), { ...draft, path: 'a.ts' })
    expect(draftPaths(drafts)).toEqual(['a.ts', 'z.ts'])
  })

  test('round-trips through serialization', () => {
    const drafts = putDraft({}, draft)
    expect(parseDrafts(serializeDrafts(drafts))).toEqual(drafts as Record<string, typeof draft>)
  })

  test('parseDrafts tolerates malformed payloads', () => {
    expect(parseDrafts(null)).toEqual({})
    expect(parseDrafts('')).toEqual({})
    expect(parseDrafts('not json')).toEqual({})
    expect(parseDrafts('{"a":1}')).toEqual({})
    expect(parseDrafts('[{"path":"a.ts"}]')).toEqual({})
    expect(parseDrafts('[null,3,"x"]')).toEqual({})
  })

  test('drops drafts too large to persist', () => {
    const huge = { ...draft, path: 'big.ts', contents: 'x'.repeat(600_000) }
    const drafts = putDraft(putDraft({}, draft), huge)
    const restored = parseDrafts(serializeDrafts(drafts))
    expect(Object.keys(restored)).toEqual([draft.path])
  })

  test('keeps only the newest drafts', () => {
    let drafts: DraftMap = {}
    for (let index = 0; index < 30; index += 1) {
      drafts = putDraft(drafts, { ...draft, path: `file-${index}.ts`, savedAt: index })
    }
    const restored = parseDrafts(serializeDrafts(drafts))
    expect(Object.keys(restored)).toHaveLength(24)
    expect(restored['file-29.ts']).toBeDefined()
    expect(restored['file-0.ts']).toBeUndefined()
  })

  test('writeDrafts removes the key when nothing is dirty', () => {
    const storage = createStorage()
    writeDrafts('/repo', putDraft({}, draft), storage)
    expect(storage.data[draftStorageKey('/repo')]).toBeDefined()
    writeDrafts('/repo', {}, storage)
    expect(storage.data[draftStorageKey('/repo')]).toBeUndefined()
  })

  test('readDrafts survives a throwing storage', () => {
    const storage: DraftStorage = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
      removeItem: () => { throw new Error('blocked') },
      length: 0,
      key: () => null
    }
    expect(readDrafts('/repo', storage)).toEqual({})
    expect(() => writeDrafts('/repo', putDraft({}, draft), storage)).not.toThrow()
    expect(readDrafts('/repo', null)).toEqual({})
  })

  test('reads back what it wrote', () => {
    const storage = createStorage()
    writeDrafts('/repo', putDraft({}, draft), storage)
    expect(readDrafts('/repo', storage)[draft.path]?.contents).toBe('hello')
  })

  test('caps the persisted draft payload at 2 MB', () => {
    let drafts: DraftMap = {}
    for (let index = 0; index < 10; index += 1) {
      drafts = putDraft(drafts, {
        ...draft,
        path: `file-${index}.ts`,
        contents: 'x'.repeat(400_000),
        savedAt: index
      })
    }
    const serialized = serializeDrafts(drafts)
    expect(serialized.length).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(Object.keys(parseDrafts(serialized)).length).toBeLessThan(10)
    expect(parseDrafts(serialized)['file-9.ts']).toBeDefined()
  })
})
