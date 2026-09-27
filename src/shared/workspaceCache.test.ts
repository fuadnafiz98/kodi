import { describe, expect, it } from 'bun:test'

import type { RepositorySnapshot } from './contracts.js'
import { sessionWorkspaceStage } from './sessionRestore.js'
import {
  EMPTY_WORKSPACE_CACHE_STORE,
  MAX_CACHED_FILE_CHARS,
  MAX_CACHED_PATHS,
  MAX_WORKSPACE_CACHE_SLOTS,
  cachedFileTextFromComparison,
  cachedFileTextIdentity,
  capWorkspaceCache,
  comparisonFromCachedText,
  comparisonWithoutOpenSession,
  idleFileComparison,
  initialWorkspacePaint,
  lastWorkspaceCache,
  mergeWorkspaceCache,
  parseWorkspaceCache,
  parseWorkspaceCacheStore,
  parseWorkspaceUi,
  rememberWorkspaceCacheEntry,
  withLastWorkspaceRoot,
  workspaceCacheForRoot
} from './workspaceCache.js'

const snapshot = (paths: string[] = ['src/a.ts', 'src/b.ts']): RepositorySnapshot => ({
  root: '/work/kodi',
  name: 'kodi',
  kind: 'git',
  branch: 'main',
  head: 'abc123',
  paths,
  statuses: [{ path: 'src/a.ts', status: 'modified' }]
})

const cache = {
  version: 1 as const,
  lastRoot: '/work/kodi',
  snapshot: snapshot(),
  selectedPath: 'src/a.ts',
  workspaceView: 'file' as const,
  fileText: { path: 'src/a.ts', text: 'export const a = 1\n' },
  savedAt: 1
}

describe('parseWorkspaceCache', () => {
  it('round-trips a complete cache', () => {
    expect(parseWorkspaceCache(cache)).toEqual(cache)
  })

  it('returns null for corrupt or version-mismatched JSON', () => {
    expect(parseWorkspaceCache(null)).toBeNull()
    expect(parseWorkspaceCache('{"lastRoot":"/work"}')).toBeNull()
    expect(parseWorkspaceCache({ ...cache, version: 2 })).toBeNull()
    expect(parseWorkspaceCache({ ...cache, snapshot: { root: '/work' } })).toBeNull()
  })

  it('drops a selected path that is no longer in the tree', () => {
    expect(parseWorkspaceCache({
      ...cache,
      selectedPath: 'gone.ts',
      fileText: { path: 'gone.ts', text: 'stale' }
    })).toMatchObject({
      selectedPath: null,
      fileText: null
    })
  })
})

describe('capWorkspaceCache', () => {
  it('caps huge path lists and file text', () => {
    const paths = Array.from({ length: MAX_CACHED_PATHS + 50 }, (_unused, index) => `f${index}.ts`)
    const capped = capWorkspaceCache({
      ...cache,
      snapshot: snapshot(paths),
      selectedPath: 'f0.ts',
      fileText: { path: 'f0.ts', text: 'x'.repeat(MAX_CACHED_FILE_CHARS + 20) }
    })
    expect(capped.snapshot.paths).toHaveLength(MAX_CACHED_PATHS)
    expect(capped.fileText?.text).toHaveLength(MAX_CACHED_FILE_CHARS)
    expect(capped.selectedPath).toBe('f0.ts')
  })
})

describe('initialWorkspacePaint', () => {
  it('uses the cached snapshot so first paint is real names, not a skeleton', () => {
    const paint = initialWorkspacePaint(cache)
    expect(paint.snapshot?.paths).toEqual(['src/a.ts', 'src/b.ts'])
    expect(paint.selectedPath).toBe('src/a.ts')
    expect(paint.workspaceView).toBe('file')
    expect(paint.fileText).toEqual(cache.fileText)
  })

  it('is empty when there is no cache', () => {
    expect(initialWorkspacePaint(null)).toEqual({
      snapshot: null,
      selectedPath: null,
      workspaceView: 'file',
      fileText: null
    })
  })

  it('first paint with a cache is a workspace, not an opening skeleton', () => {
    const paint = initialWorkspacePaint(cache)
    expect(sessionWorkspaceStage({
      hasNewWorld: true,
      snapshot: paint.snapshot,
      restorePending: true,
      pullRequestPending: false
    })).toBe('workspace')
  })
})

describe('cached file text', () => {
  it('rebuilds a file comparison from cached text', () => {
    expect(comparisonFromCachedText({ path: 'src/a.ts', text: 'hello' })).toEqual({
      path: 'src/a.ts',
      mode: 'file',
      status: 'unchanged',
      oldFile: null,
      newFile: {
        name: 'a.ts',
        contents: 'hello',
        cacheKey: 'workspace-cache:src/a.ts'
      },
      binary: false,
      oversized: false
    })
  })

  it('returns cached text instead of throwing when no session is open', () => {
    expect(comparisonWithoutOpenSession('Makefile', { path: 'Makefile', text: 'all:\n' })).toMatchObject({
      path: 'Makefile',
      mode: 'file',
      newFile: { contents: 'all:\n' }
    })
    expect(comparisonWithoutOpenSession('README.md', { path: 'Makefile', text: 'all:\n' })).toEqual(
      idleFileComparison('README.md')
    )
  })

  it('does not persist binary or oversized comparisons', () => {
    expect(cachedFileTextFromComparison({
      path: 'src/a.ts',
      mode: 'file',
      status: 'unchanged',
      oldFile: null,
      newFile: { name: 'a.ts', contents: 'hello', cacheKey: 'k' },
      binary: true,
      oversized: false
    })).toBeNull()
  })
})

describe('mergeWorkspaceCache', () => {
  it('keeps the last UI selection when a live snapshot arrives', () => {
    const merged = mergeWorkspaceCache(snapshot(['src/a.ts', 'src/c.ts']), {
      selectedPath: 'src/a.ts',
      workspaceView: 'file',
      fileText: { path: 'src/a.ts', text: 'kept' }
    }, cache)
    expect(merged.selectedPath).toBe('src/a.ts')
    expect(merged.snapshot.paths).toEqual(['src/a.ts', 'src/c.ts'])
    expect(merged.fileText).toEqual({ path: 'src/a.ts', text: 'kept' })
  })
})

describe('parseWorkspaceUi', () => {
  it('reads a renderer UI update', () => {
    expect(parseWorkspaceUi({
      selectedPath: 'src/b.ts',
      workspaceView: 'multi',
      fileText: { path: 'src/b.ts', text: 'b' }
    })).toEqual({
      selectedPath: 'src/b.ts',
      workspaceView: 'multi',
      fileText: { path: 'src/b.ts', text: 'b' }
    })
  })

  it('leaves the cached text alone when the update does not carry any', () => {
    const ui = parseWorkspaceUi({ selectedPath: 'src/a.ts', workspaceView: 'file' })
    expect(ui).toEqual({ selectedPath: 'src/a.ts', workspaceView: 'file' })
    expect(mergeWorkspaceCache(snapshot(), ui, cache).fileText)
      .toEqual({ path: 'src/a.ts', text: 'export const a = 1\n' })
  })
})

describe('cachedFileTextIdentity', () => {
  it('changes only when the file contents change', () => {
    const comparison = comparisonFromCachedText({ path: 'src/a.ts', text: 'one' })!
    expect(cachedFileTextIdentity(comparison)).toBe(cachedFileTextIdentity({ ...comparison }))
    expect(cachedFileTextIdentity({
      ...comparison,
      newFile: { ...comparison.newFile!, cacheKey: 'moved' }
    })).not.toBe(cachedFileTextIdentity(comparison))
    expect(cachedFileTextIdentity(idleFileComparison('src/a.ts'))).toBeNull()
    expect(cachedFileTextIdentity(null)).toBeNull()
  })
})

describe('workspace cache store', () => {
  const other = { ...cache, lastRoot: '/work/other', snapshot: { ...snapshot(), root: '/work/other' } }

  it('reads a version 1 file as a single slot', () => {
    const store = parseWorkspaceCacheStore(cache)
    expect(store.lastRoot).toBe(cache.lastRoot)
    expect(store.entries).toEqual([cache])
    expect(lastWorkspaceCache(store)).toEqual(cache)
  })

  it('returns the empty store for anything it cannot read', () => {
    expect(parseWorkspaceCacheStore(null)).toEqual(EMPTY_WORKSPACE_CACHE_STORE)
    expect(parseWorkspaceCacheStore({ version: 9 })).toEqual(EMPTY_WORKSPACE_CACHE_STORE)
    expect(parseWorkspaceCacheStore({ version: 2, lastRoot: '/gone', entries: [{ nope: true }] }))
      .toEqual({ version: 2, lastRoot: null, entries: [] })
  })

  it('keeps both repositories so alternating between them never repaints a skeleton', () => {
    const store = rememberWorkspaceCacheEntry(rememberWorkspaceCacheEntry(
      EMPTY_WORKSPACE_CACHE_STORE,
      cache
    ), other)

    expect(store.lastRoot).toBe(other.lastRoot)
    expect(workspaceCacheForRoot(store, cache.lastRoot)).toEqual(cache)
    expect(workspaceCacheForRoot(store, other.lastRoot)).toEqual(other)
    expect(workspaceCacheForRoot(store, '/never/opened')).toBeNull()
  })

  it('drops the least recently opened entry past the slot cap', () => {
    let store = EMPTY_WORKSPACE_CACHE_STORE
    const roots: string[] = []
    for (let index = 0; index < MAX_WORKSPACE_CACHE_SLOTS + 2; index += 1) {
      const root = `/work/repo-${index}`
      roots.push(root)
      store = rememberWorkspaceCacheEntry(store, {
        ...cache,
        lastRoot: root,
        snapshot: { ...snapshot(), root }
      })
    }

    expect(store.entries).toHaveLength(MAX_WORKSPACE_CACHE_SLOTS)
    expect(store.entries.map((entry) => entry.lastRoot)).toEqual([...roots].reverse().slice(0, 3))
    expect(workspaceCacheForRoot(store, roots[0]!)).toBeNull()
  })

  it('moves a repository back to the front when it is opened again', () => {
    const store = rememberWorkspaceCacheEntry(
      rememberWorkspaceCacheEntry(rememberWorkspaceCacheEntry(EMPTY_WORKSPACE_CACHE_STORE, cache), other),
      cache
    )

    expect(store.entries.map((entry) => entry.lastRoot)).toEqual([cache.lastRoot, other.lastRoot])
    expect(store.lastRoot).toBe(cache.lastRoot)
  })

  it('survives the round trip through parse', () => {
    const store = rememberWorkspaceCacheEntry(
      rememberWorkspaceCacheEntry(EMPTY_WORKSPACE_CACHE_STORE, cache),
      other
    )
    const onDisk = JSON.stringify(store)
    expect(parseWorkspaceCacheStore(JSON.parse(onDisk))).toEqual(store)
  })

  // Closing the last folder must open the dashboard next launch, not the folder
  // that was just closed — which the first-entry fallback used to bring back.
  it('keeps a closed folder closed across a restart while keeping its cache', () => {
    const store = rememberWorkspaceCacheEntry(rememberWorkspaceCacheEntry(EMPTY_WORKSPACE_CACHE_STORE, cache), other)
    const closed = withLastWorkspaceRoot(store, null)

    expect(closed.lastRoot).toBeNull()
    expect(closed.entries).toEqual(store.entries)
    const restarted = parseWorkspaceCacheStore(JSON.parse(JSON.stringify(closed)))
    expect(restarted.lastRoot).toBeNull()
    expect(lastWorkspaceCache(restarted)).toBeNull()
  })

  it('points the next launch at the tab in front, or at nothing without a cache for it', () => {
    const store = rememberWorkspaceCacheEntry(rememberWorkspaceCacheEntry(EMPTY_WORKSPACE_CACHE_STORE, cache), other)
    expect(withLastWorkspaceRoot(store, cache.lastRoot).lastRoot).toBe(cache.lastRoot)
    expect(withLastWorkspaceRoot(store, '/never/cached').lastRoot).toBeNull()
    expect(withLastWorkspaceRoot(store, other.lastRoot)).toBe(store)
  })
})
