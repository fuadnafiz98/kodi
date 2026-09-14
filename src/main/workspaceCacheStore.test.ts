import { describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EMPTY_WORKSPACE_CACHE_STORE } from '../shared/workspaceCache.js'
import { flushWorkspaceCache, loadWorkspaceCache, saveWorkspaceCache } from './workspaceCacheStore.js'

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
