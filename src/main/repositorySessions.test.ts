import { afterEach, describe, expect, it, spyOn } from 'bun:test'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RepositoryChangeEvent, RepositorySnapshot } from '../shared/contracts.js'
import { runCommand } from './gitCommands.js'
import { RepositoryService } from './repository.js'
import { RepositorySessionRegistry } from './repositorySessions.js'
import { RepositoryWatcher } from './repositoryWatcher.js'

const sleep = (ms: number): Promise<void> => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms) })

async function waitFor(satisfied: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (satisfied()) return true
    await sleep(25)
  }
  return satisfied()
}

const directories: string[] = []
const registries: RepositorySessionRegistry[] = []

afterEach(async () => {
  for (const registry of registries.splice(0)) registry.stopAll()
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })))
})

describe('RepositorySessionRegistry', () => {
  it('ignores content-search cancellation until a repository is active', () => {
    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)

    expect(() => registry.cancelActiveContentSearch()).not.toThrow()
    expect(registry.tryGetActive()).toBeNull()
    expect(() => registry.requireActive()).toThrow('Open a repository before using this action.')
  })

  it('cancels content search for the active repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-repository-cancel-search-'))
    directories.push(root)
    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    await registry.open(root)
    const cancelContentSearch = spyOn(registry.requireActive(), 'cancelContentSearch')

    registry.cancelActiveContentSearch()

    expect(cancelContentSearch).toHaveBeenCalledTimes(1)
  })

  it('keeps independent repository sessions and changes only the requested active root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kodi-repository-sessions-'))
    directories.push(parent)
    const firstRoot = join(parent, 'first')
    const secondRoot = join(parent, 'second')
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])

    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    const first = await registry.open(firstRoot)
    const second = await registry.open(secondRoot, false)

    expect(registry.roots).toEqual([first.root, second.root])
    expect(registry.activeRoot).toBe(first.root)
    expect(registry.require(first.root)).not.toBe(registry.require(second.root))

    const activated = await registry.activate(second.root)
    expect(activated.root).toBe(second.root)
    expect(registry.activeRoot).toBe(second.root)
  })

  it('reuses a registered root without changing focus for a background open', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kodi-repository-reuse-'))
    directories.push(parent)
    const firstRoot = join(parent, 'first')
    const secondRoot = join(parent, 'second')
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])

    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    const first = await registry.open(firstRoot)
    const second = await registry.open(secondRoot)
    const reopened = await registry.open(firstRoot, false)

    expect(reopened.root).toBe(first.root)
    expect(registry.activeRoot).toBe(second.root)
    expect(registry.require(reopened.root)).toBe(registry.require(first.root))
  })

  it('releases an unused repository session without disturbing another root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kodi-repository-release-'))
    directories.push(parent)
    const firstRoot = join(parent, 'first')
    const secondRoot = join(parent, 'second')
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])

    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    const first = await registry.open(firstRoot)
    const second = await registry.open(secondRoot)
    const firstRepository = registry.require(first.root)
    const dispose = spyOn(firstRepository, 'dispose')
    registry.release(first.root)

    expect(registry.roots).toEqual([second.root])
    expect(registry.activeRoot).toBe(second.root)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(registry.tryGet(first.root)).toBeNull()
    expect(() => registry.require(first.root)).toThrow('The repository tab is no longer open.')
    expect(registry.require(second.root).getSessionSnapshot()?.root).toBe(second.root)
  })

  it('trims the caches of repositories that become inactive', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kodi-repository-trim-'))
    directories.push(parent)
    const firstRoot = join(parent, 'first')
    const secondRoot = join(parent, 'second')
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])
    const contents = Buffer.alloc(1_500_000, 97)
    const paths = Array.from({ length: 6 }, (_unused, index) => `large-${index}.txt`)
    await Promise.all(paths.map((path) => writeFile(join(firstRoot, path), contents)))

    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    const first = await registry.open(firstRoot)
    const second = await registry.open(secondRoot, false)
    const firstRepository = registry.require(first.root)
    for (const path of paths) await firstRepository.getComparison(path)

    expect(firstRepository.getHeadCacheStatsForTests().workingBytes).toBeGreaterThan(8 * 1024 * 1024)
    await registry.activate(second.root)

    expect(firstRepository.getHeadCacheStatsForTests().workingBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('refreshes the root it is given, not whichever one is active', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kodi-refresh-root-'))
    directories.push(parent)
    await Promise.all([mkdir(join(parent, 'active')), mkdir(join(parent, 'background'))])
    const activeRoot = await realpath(join(parent, 'active'))
    const backgroundRoot = await realpath(join(parent, 'background'))

    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    await registry.open(backgroundRoot, false)
    await registry.open(activeRoot)
    expect(registry.activeRoot).toBe(activeRoot)

    const active = spyOn(registry.require(activeRoot), 'refresh')
    const background = spyOn(registry.require(backgroundRoot), 'refresh')
    try {
      await registry.refresh(backgroundRoot)

      expect(background).toHaveBeenCalledTimes(1)
      expect(active).not.toHaveBeenCalled()
      expect(await registry.refresh(join(parent, 'never-opened'))).toBeNull()
    } finally {
      active.mockRestore()
      background.mockRestore()
    }
  })

  it('returns a snapshot before git status finishes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kodi-open-instant-')))
    directories.push(root)
    await writeFile(join(root, 'readme.md'), 'hello\n', 'utf8')
    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)

    let release!: (snapshot: RepositorySnapshot) => void
    const hung = new Promise<RepositorySnapshot>((resolve) => {
      release = resolve
    })
    const refresh = spyOn(RepositoryService.prototype, 'refresh').mockImplementation(() => hung)

    try {
      const started = Date.now()
      const snapshot = await registry.open(root)
      expect(Date.now() - started).toBeLessThan(1_000)
      expect(snapshot.paths).toContain('readme.md')
      expect(snapshot.statuses).toEqual([])
      expect(refresh).toHaveBeenCalled()
      release(snapshot)
    } finally {
      refresh.mockRestore()
    }
  })

  it('returns the live snapshot when the refresh beats the open deadline', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kodi-open-live-')))
    directories.push(root)
    await writeFile(join(root, 'readme.md'), 'hello\n', 'utf8')
    const events: RepositoryChangeEvent[] = []
    const registry = new RepositorySessionRegistry((event) => events.push(event), () => {})
    registries.push(registry)
    const live: RepositorySnapshot = {
      root,
      name: 'live',
      kind: 'git',
      branch: 'main',
      head: 'abcdef',
      paths: ['readme.md'],
      statuses: [{ path: 'readme.md', status: 'modified' }]
    }
    const refresh = spyOn(RepositoryService.prototype, 'refresh')
      .mockImplementation(async () => {
        await sleep(10)
        return live
      })

    try {
      const snapshot = await registry.open(root)

      expect(snapshot).toBe(live)
      expect(snapshot.statuses).toEqual([{ path: 'readme.md', status: 'modified' }])
      // The caller already has it; publishing the same snapshot again is noise.
      expect(events).toEqual([])
    } finally {
      refresh.mockRestore()
    }
  })

  it('falls back to the listing and publishes the live snapshot when the refresh is slow', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kodi-open-slow-')))
    directories.push(root)
    await writeFile(join(root, 'readme.md'), 'hello\n', 'utf8')
    const events: RepositoryChangeEvent[] = []
    const registry = new RepositorySessionRegistry((event) => events.push(event), () => {})
    registries.push(registry)
    const live: RepositorySnapshot = {
      root,
      name: 'live',
      kind: 'git',
      branch: 'main',
      head: 'abcdef',
      paths: ['readme.md'],
      statuses: [{ path: 'readme.md', status: 'modified' }]
    }
    const refresh = spyOn(RepositoryService.prototype, 'refresh')
      .mockImplementation(async () => {
        await sleep(400)
        return live
      })

    try {
      const snapshot = await registry.open(root)

      expect(snapshot).not.toBe(live)
      expect(snapshot.paths).toContain('readme.md')
      expect(snapshot.statuses).toEqual([])
      expect(events).toEqual([])

      expect(await waitFor(() => events.length > 0)).toBe(true)
      expect(events.at(-1)?.snapshot).toBe(live)
      expect(events.at(-1)?.changedPaths).toEqual(['readme.md'])
    } finally {
      refresh.mockRestore()
    }
  })

  it('rejects a missing folder without walking git', async () => {
    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    const missing = join(tmpdir(), 'kodi-missing-folder-does-not-exist')
    await expect(registry.open(missing)).rejects.toThrow()
  })

  it('publishes dirty paths when the first live refresh finishes', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kodi-refresh-dirty-')))
    directories.push(root)
    await runCommand('git', ['-C', root, '-c', 'init.defaultBranch=main', 'init', '--quiet'])
    await writeFile(join(root, 'clean.ts'), 'export const clean = 1\n', 'utf8')
    await writeFile(join(root, 'dirty.ts'), 'export const dirty = 1\n', 'utf8')
    await runCommand('git', ['-C', root, 'add', '--all'])
    await runCommand('git', [
      '-C', root,
      '-c', 'user.name=Kodi Test',
      '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '--quiet', '-m', 'init'
    ])
    await writeFile(join(root, 'dirty.ts'), 'export const dirty = 2\n', 'utf8')

    const events: RepositoryChangeEvent[] = []
    const registry = new RepositorySessionRegistry((event) => events.push(event), () => {})
    registries.push(registry)
    await registry.open(root)
    await registry.refreshActive()

    const published = events.filter((event) => event.changedPaths.includes('dirty.ts'))
    expect(published.length).toBeGreaterThan(0)
    expect(published.at(-1)?.changedPaths).not.toContain('clean.ts')
  })

  it('counts a watcher tick as an external change instead of joining an older refresh', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kodi-session-watch-tick-')))
    directories.push(root)
    const file = join(root, 'watched.ts')
    await writeFile(file, 'export const watched = 0\n', 'utf8')
    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    await registry.open(root)

    const external = spyOn(registry.requireActive(), 'refreshAfterExternalChange')
    try {
      // FSEvents coalesces and every write restarts the watcher's debounce, so
      // the settle between attempts has to outlast it.
      for (let attempt = 0; attempt < 30 && external.mock.calls.length === 0; attempt += 1) {
        await writeFile(file, `export const watched = ${attempt + 1}\n`, 'utf8')
        await sleep(150)
      }

      expect(external).toHaveBeenCalled()
    } finally {
      external.mockRestore()
    }
  }, 30_000)

  it('opens an already-resolved path into the session the symlink opened', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'kodi-session-resolved-')))
    directories.push(parent)
    const realRoot = join(parent, 'project')
    const linkPath = join(parent, 'link')
    await mkdir(realRoot)
    await symlink(realRoot, linkPath)

    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    const viaLink = await registry.open(linkPath)
    expect(viaLink.root).toBe(realRoot)

    // `openRepository` has already run the path through realpath, so the
    // registry is told not to do it again; the session must still be the same one.
    const viaResolved = await registry.open(realRoot, true, true)
    expect(viaResolved.root).toBe(realRoot)
    expect(registry.roots).toEqual([realRoot])
  })

  it('pauses every background watcher when a repository is activated', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'kodi-session-pause-')))
    directories.push(parent)
    const firstRoot = join(parent, 'first')
    const secondRoot = join(parent, 'second')
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)])
    const pause = spyOn(RepositoryWatcher.prototype, 'pause')
    const resume = spyOn(RepositoryWatcher.prototype, 'resume')

    try {
      const registry = new RepositorySessionRegistry(() => {}, () => {})
      registries.push(registry)
      const first = await registry.open(firstRoot)
      const second = await registry.open(secondRoot)

      // Activating the second root parked the first one.
      expect(pause).toHaveBeenCalled()
      pause.mockClear()
      resume.mockClear()

      await registry.activate(first.root)
      expect(registry.activeRoot).toBe(first.root)
      expect(resume).toHaveBeenCalled()
      expect(pause).toHaveBeenCalled()
      expect(second.root).not.toBe(first.root)
    } finally {
      pause.mockRestore()
      resume.mockRestore()
    }
  }, 30_000)

  it('never arms a watcher for a repository opened in the background', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'kodi-session-background-')))
    directories.push(parent)
    const activeRoot = join(parent, 'active')
    const backgroundRoot = join(parent, 'background')
    await Promise.all([mkdir(activeRoot), mkdir(backgroundRoot)])
    const pause = spyOn(RepositoryWatcher.prototype, 'pause')

    try {
      const registry = new RepositorySessionRegistry(() => {}, () => {})
      registries.push(registry)
      await registry.open(activeRoot)
      pause.mockClear()
      await registry.open(backgroundRoot, false)
      // The watcher is armed on the next tick, and parked on the same one.
      await sleep(50)

      expect(registry.activeRoot).toBe(await realpath(activeRoot))
      expect(pause).toHaveBeenCalled()
    } finally {
      pause.mockRestore()
    }
  }, 30_000)

  it('caps resident sessions and reopens an evicted root when its tab returns', async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'kodi-session-cap-')))
    directories.push(parent)
    const roots: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const root = join(parent, `repo-${index}`)
      await mkdir(root)
      await writeFile(join(root, 'app.ts'), 'export {}\n', 'utf8')
      roots.push(root)
    }

    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    for (const root of roots) await registry.open(root)
    const evictedRoot = roots[0]!
    const newestRoot = roots.at(-1)!

    expect(registry.roots).toHaveLength(4)
    expect(registry.roots).toEqual(roots.slice(2))
    expect(registry.activeRoot).toBe(newestRoot)
    expect(() => registry.require(evictedRoot)).toThrow('The repository tab is no longer open.')

    const reopened = await registry.activate(evictedRoot)
    expect(reopened.root).toBe(evictedRoot)
    expect(registry.activeRoot).toBe(evictedRoot)
    expect(registry.roots).toHaveLength(4)
  }, 30_000)

  it('hydrates a cached snapshot so the tree is available before git refresh', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kodi-session-hydrate-')))
    directories.push(root)
    await writeFile(join(root, 'app.ts'), 'export {}\n', 'utf8')
    const registry = new RepositorySessionRegistry(() => {}, () => {})
    registries.push(registry)
    const cached = {
      root,
      name: 'hydrated',
      kind: 'folder' as const,
      branch: null,
      head: null,
      paths: ['app.ts'],
      statuses: []
    }

    expect(registry.hydrate(cached)).toEqual(cached)
    expect(registry.getActiveSnapshot()).toEqual(cached)
    expect(await registry.requireActive().getComparison('app.ts')).toMatchObject({
      path: 'app.ts'
    })

    const reopened = await registry.open(root)
    expect(reopened.paths).toContain('app.ts')
    expect(registry.getActiveSnapshot()?.root).toBe(reopened.root)
  })
})
