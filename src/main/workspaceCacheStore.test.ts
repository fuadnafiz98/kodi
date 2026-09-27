import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  EMPTY_WORKSPACE_CACHE_STORE,
  parseWorkspaceCacheStore,
  rememberWorkspaceCacheEntry,
  type WorkspaceCache
} from '../shared/workspaceCache.js'
import {
  flushWorkspaceCache,
  loadWorkspaceCache,
  saveWorkspaceCache,
  serializeWorkspaceCacheStore
} from './workspaceCacheStore.js'

const cache = {
  version: 1 as const,
  lastRoot: '/work/kodi',
  snapshot: {
    root: '/work/kodi',
    name: 'kodi',
    kind: 'git' as const,
    branch: 'main',
    head: 'abc',
    paths: ['src/a.ts'],
    statuses: [{ path: 'src/a.ts', status: 'modified' as const }]
  },
  selectedPath: 'src/a.ts',
  workspaceView: 'file' as const,
  fileText: { path: 'src/a.ts', text: 'export const a = 1\n' },
  savedAt: 10
}

const store = {
  version: 2 as const,
  lastRoot: cache.lastRoot,
  entries: [cache]
}

describe('workspaceCacheStore', () => {
  it('round-trips a multi-slot store through disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-workspace-cache-'))
    try {
      expect(loadWorkspaceCache(directory)).toEqual(EMPTY_WORKSPACE_CACHE_STORE)
      await saveWorkspaceCache(directory, store)
      await flushWorkspaceCache()
      expect(loadWorkspaceCache(directory)).toEqual(store)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('leaves no temp file behind and reads a version 1 file as one slot', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-workspace-migrate-'))
    try {
      await writeFile(join(directory, 'last-workspace.json'), JSON.stringify(cache), 'utf8')
      expect(loadWorkspaceCache(directory)).toEqual(store)

      await saveWorkspaceCache(directory, store)
      await flushWorkspaceCache()
      expect(existsSync(join(directory, 'last-workspace.json.tmp'))).toBe(false)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns the empty store for corrupt JSON', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-workspace-corrupt-'))
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'last-workspace.json'), '{not-json', 'utf8')
      expect(loadWorkspaceCache(directory)).toEqual(EMPTY_WORKSPACE_CACHE_STORE)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('serializeWorkspaceCacheStore', () => {
  const slot = (root: string, pathCount: number): WorkspaceCache => ({
    ...cache,
    lastRoot: root,
    snapshot: {
      ...cache.snapshot,
      root,
      name: root.slice(root.lastIndexOf('/') + 1),
      paths: Array.from({ length: pathCount }, (_, index) => `src/file-${index}.ts`),
      statuses: []
    },
    selectedPath: null,
    fileText: null
  })

  it('never re-serializes a slot or snapshot it has already written', () => {
    // Stringifying a snapshot reads its path list, so reads count serializations.
    const reads = new Map<string, number>()
    const counted = (entry: WorkspaceCache): WorkspaceCache => {
      const paths = entry.snapshot.paths
      const snapshot = { ...entry.snapshot }
      Object.defineProperty(snapshot, 'paths', {
        enumerable: true,
        get: () => {
          reads.set(entry.lastRoot, (reads.get(entry.lastRoot) ?? 0) + 1)
          return paths
        }
      })
      return { ...entry, snapshot }
    }
    // A root that spells the splice markers out must not confuse the splice.
    const tricky = counted(slot('/work/"snapshot":0 "entries":[]', 50))
    const other = counted(slot('/work/other', 50))
    const active = counted(slot('/work/active', 50))
    let current = rememberWorkspaceCacheEntry(
      rememberWorkspaceCacheEntry(rememberWorkspaceCacheEntry(EMPTY_WORKSPACE_CACHE_STORE, tricky), other),
      active
    )
    const first = serializeWorkspaceCacheStore(current)
    expect(first).toBe(JSON.stringify(current))
    reads.clear()

    // A UI-only change: a new entry object around the same snapshot.
    current = rememberWorkspaceCacheEntry(current, { ...active, selectedPath: 'src/file-3.ts', savedAt: 99 })
    const text = serializeWorkspaceCacheStore(current)
    expect([...reads.entries()]).toEqual([])

    expect(text).toBe(JSON.stringify(current))
    expect(parseWorkspaceCacheStore(JSON.parse(text))).toEqual(parseWorkspaceCacheStore(JSON.parse(JSON.stringify(current))))
    expect(JSON.parse(text).entries[0].selectedPath).toBe('src/file-3.ts')
  })

  it('writes the same bytes as stringifying the whole store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-workspace-splice-'))
    try {
      await saveWorkspaceCache(directory, store)
      await flushWorkspaceCache()
      expect(await readFile(join(directory, 'last-workspace.json'), 'utf8')).toBe(JSON.stringify(store))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
