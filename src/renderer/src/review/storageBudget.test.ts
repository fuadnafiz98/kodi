import { describe, expect, it } from 'bun:test'

import {
  DEFAULT_STORAGE_BUDGET,
  STORAGE_INDEX_KEY,
  enforceStorageBudget,
  forgetStorageKey,
  loadStorageIndex,
  persistManagedValue,
  purgeRetiredStorage,
  rebuildStorageIndex,
  touchStorageKey,
  type BudgetStorage
} from './storageBudget'

function createStorage(initial: Record<string, string> = {}): BudgetStorage & { data: Record<string, string> } {
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

describe('storageBudget', () => {
  it('evicts least-recently-touched keys until under budget', () => {
    const storage = createStorage()
    touchStorageKey(storage, 'kodi:viewed-files:/a', 40, 1)
    storage.setItem('kodi:viewed-files:/a', 'a'.repeat(40))
    touchStorageKey(storage, 'kodi:review-threads:/b', 40, 2)
    storage.setItem('kodi:review-threads:/b', 'b'.repeat(40))
    touchStorageKey(storage, 'kodi:drafts:v1:/c', 40, 3)
    storage.setItem('kodi:drafts:v1:/c', 'c'.repeat(40))

    expect(enforceStorageBudget(storage, 80)).toEqual(['kodi:viewed-files:/a'])
    expect(storage.getItem('kodi:viewed-files:/a')).toBeNull()
    expect(storage.getItem('kodi:review-threads:/b')).not.toBeNull()
  })

  it('never evicts the key being written', () => {
    const storage = createStorage()
    const preserved = 'kodi:viewed-files:/kept'
    touchStorageKey(storage, preserved, 90, 1)
    storage.setItem(preserved, 'k'.repeat(90))
    touchStorageKey(storage, 'kodi:review-threads:/old', 20, 2)
    storage.setItem('kodi:review-threads:/old', 'o'.repeat(20))

    expect(enforceStorageBudget(storage, 80, preserved)).toEqual(['kodi:review-threads:/old'])
    expect(storage.getItem(preserved)).not.toBeNull()
  })

  it('rebuilds a corrupt manifest from a prefix scan', () => {
    const storage = createStorage({
      [STORAGE_INDEX_KEY]: 'not-json',
      'kodi:viewed-files:/repo': 'abc',
      'unrelated': 'skip'
    })
    const index = loadStorageIndex(storage, 10)
    expect(index['kodi:viewed-files:/repo']).toEqual({ bytes: 3, touchedAt: 10 })
    expect(index.unrelated).toBeUndefined()
    expect(rebuildStorageIndex(storage, 10)['kodi:viewed-files:/repo']?.bytes).toBe(3)
  })

  it('forgets a key and persistManagedValue records a successful write', () => {
    const storage = createStorage()
    expect(persistManagedValue(storage, 'kodi:drafts:v1:/repo', 'hello', DEFAULT_STORAGE_BUDGET)).toBe(true)
    expect(storage.getItem('kodi:drafts:v1:/repo')).toBe('hello')
    forgetStorageKey(storage, 'kodi:drafts:v1:/repo')
    expect(loadStorageIndex(storage)['kodi:drafts:v1:/repo']).toBeUndefined()
  })

  // Review checkpoints are gone. Their keys are not, on any machine that ever
  // set one, and they charge against the same budget the live keys share.
  it('sweeps keys left behind by a removed feature, and their index entries', () => {
    const storage = createStorage({
      'kodi:review-checkpoint:/repo:https://github.com/acme/repo/pull/7': 'stale',
      'kodi:viewed-files:/repo': 'keep'
    })
    touchStorageKey(storage, 'kodi:review-checkpoint:/repo:https://github.com/acme/repo/pull/7', 5, 1)

    expect(purgeRetiredStorage(storage))
      .toEqual(['kodi:review-checkpoint:/repo:https://github.com/acme/repo/pull/7'])
    expect(storage.getItem('kodi:review-checkpoint:/repo:https://github.com/acme/repo/pull/7')).toBeNull()
    expect(loadStorageIndex(storage)['kodi:review-checkpoint:/repo:https://github.com/acme/repo/pull/7'])
      .toBeUndefined()
    expect(storage.getItem('kodi:viewed-files:/repo')).toBe('keep')
    expect(purgeRetiredStorage(storage)).toEqual([])
  })

  it('sweeps retired keys on the next managed write', () => {
    const storage = createStorage({ 'kodi:review-checkpoint:/repo:pr': 'stale' })
    persistManagedValue(storage, 'kodi:review-threads:/repo:pr', 'threads')
    expect(storage.getItem('kodi:review-checkpoint:/repo:pr')).toBeNull()
    expect(storage.getItem('kodi:review-threads:/repo:pr')).toBe('threads')
  })
})
