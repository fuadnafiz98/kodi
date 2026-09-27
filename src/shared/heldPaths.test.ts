import { describe, expect, it } from 'bun:test'
import { serialize } from 'node:v8'

import type { RepositorySnapshot } from './contracts.js'
import { HeldPathCache, heldPathList, omitHeldPaths } from './heldPaths.js'

function snapshotWith(paths: string[], pathsRevision: number, root = '/repo'): RepositorySnapshot {
  return {
    root,
    name: 'repo',
    kind: 'git',
    branch: 'main',
    head: 'a'.repeat(40),
    paths,
    statuses: [{ path: paths[0]!, status: 'modified', staged: 'all' }],
    stage: 'live',
    pathsRevision
  }
}

const largePaths = Array.from(
  { length: 100_000 },
  (_, index) => `packages/pkg-${index % 400}/src/components/file-${index}.tsx`
).sort()

// Stands in for main and the preload on either side of one IPC round trip.
function roundTrip(cache: HeldPathCache, snapshot: RepositorySnapshot): {
  replyBytes: number
  completed: RepositorySnapshot
} {
  const claim = cache.claim()
  const reply = omitHeldPaths(snapshot, heldPathList(claim))
  return { replyBytes: serialize(reply).byteLength, completed: cache.complete(reply, claim) }
}

describe('held path lists', () => {
  it('sends the list on the first reply and leaves it out of a repeat reply', () => {
    const cache = new HeldPathCache()
    const snapshot = snapshotWith(largePaths, 4)

    const first = roundTrip(cache, snapshot)
    expect(first.replyBytes).toBeGreaterThan(5_000_000)
    expect(first.completed.paths).toBe(largePaths)

    const repeat = roundTrip(cache, { ...snapshot, statuses: [] })
    expect(repeat.replyBytes).toBeLessThan(50 * 1024)
    expect(repeat.completed.paths).toBe(largePaths)
    expect(repeat.completed.statuses).toEqual([])
    expect(repeat.completed.pathsRevision).toBe(4)
  })

  it('sends the list again once its revision moves', () => {
    const cache = new HeldPathCache()
    roundTrip(cache, snapshotWith(['a.ts'], 1))

    const moved = roundTrip(cache, snapshotWith(['a.ts', 'b.ts'], 2))
    expect(moved.completed.paths).toEqual(['a.ts', 'b.ts'])
    // The new list is what the next repeat is measured against.
    const claim = cache.claim()
    expect(omitHeldPaths(snapshotWith(['a.ts', 'b.ts'], 2), heldPathList(claim)).paths).toBeUndefined()
  })

  it('sends the list to a window that holds another root or nothing at all', () => {
    const snapshot = snapshotWith(['a.ts'], 3)
    expect(omitHeldPaths(snapshot, null).paths).toEqual(['a.ts'])
    expect(omitHeldPaths(snapshot, { root: '/other', pathsRevision: 3 }).paths).toEqual(['a.ts'])
    expect(omitHeldPaths(snapshot, { root: '/repo', pathsRevision: 2 }).paths).toEqual(['a.ts'])
    expect(omitHeldPaths({ ...snapshot, pathsRevision: undefined }, { root: '/repo', pathsRevision: 3 }).paths)
      .toEqual(['a.ts'])
    expect(omitHeldPaths(snapshot, 'garbage').paths).toEqual(['a.ts'])
  })

  it('keeps the list the reader acts on when a background root broadcasts', () => {
    const cache = new HeldPathCache()
    cache.remember(snapshotWith(['a.ts'], 1))
    cache.rememberBroadcast(snapshotWith(['other.ts'], 9, '/other'))
    expect(cache.claim()?.root).toBe('/repo')

    cache.rememberBroadcast(snapshotWith(['a.ts', 'b.ts'], 2))
    expect(cache.claim()?.pathsRevision).toBe(2)
  })

  it('completes a reply from the list it claimed even if the cache moved on meanwhile', () => {
    const cache = new HeldPathCache()
    const snapshot = snapshotWith(['a.ts'], 1)
    cache.remember(snapshot)
    const claim = cache.claim()
    const reply = omitHeldPaths(snapshot, heldPathList(claim))
    cache.remember(snapshotWith(['x.ts'], 5, '/other'))

    expect(cache.complete(reply, claim).paths).toEqual(['a.ts'])
    expect(cache.claim()?.root).toBe('/repo')
  })

  it('refuses a reply that left out a list nobody claimed', () => {
    const cache = new HeldPathCache()
    const reply = omitHeldPaths(snapshotWith(['a.ts'], 1), { root: '/repo', pathsRevision: 1 })
    expect(() => cache.complete(reply, null)).toThrow('missing its file list')
  })
})
