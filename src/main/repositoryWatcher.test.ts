import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RepositoryChangeEvent, RepositorySnapshot } from '../shared/contracts.js'
import {
  collectChangedPaths,
  dropSelfWrites,
  normalizeChangedPath,
  RepositoryWatcher,
  resolveLinkedGitDirectory
} from './repositoryWatcher.js'

function snapshot(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    root: '/repo',
    name: 'repo',
    kind: 'git',
    branch: 'main',
    head: 'abc',
    paths: ['src/existing.ts'],
    statuses: [{ path: 'src/existing.ts', status: 'modified' }],
    ...overrides
  }
}

describe('collectChangedPaths', () => {
  it('keeps a direct content edit targeted to its file', () => {
    const current = snapshot()
    expect(collectChangedPaths(current, current, new Set(['src/existing.ts'])))
      .toEqual(['src/existing.ts'])
  })

  it('detects new files and Git status changes', () => {
    const previous = snapshot({ paths: [], statuses: [] })
    const next = snapshot({
      paths: ['src/new.ts'],
      statuses: [{ path: 'src/new.ts', status: 'untracked' }]
    })
    expect(collectChangedPaths(previous, next, new Set(['src/new.ts'])))
      .toEqual(['src/new.ts'])
  })

  it('invalidates changed files when HEAD moves', () => {
    const previous = snapshot()
    const next = snapshot({ head: 'def' })
    expect(collectChangedPaths(previous, next, new Set(['.git/HEAD'])))
      .toEqual(['src/existing.ts'])
  })

  it('expands multiple changed directories over the combined path set', () => {
    const previous = snapshot({
      paths: ['docs/guide.md', 'src/existing.ts', 'unchanged.txt'],
      statuses: []
    })
    const next = snapshot({
      paths: ['docs/guide.md', 'src/new.ts', 'unchanged.txt'],
      statuses: []
    })

    expect(collectChangedPaths(previous, next, new Set(['docs', 'src/'])))
      .toEqual(['docs/guide.md', 'src/existing.ts', 'src/new.ts'])
  })

  it('does not name a path whose only change is being staged', () => {
    const previous = snapshot({ statuses: [{ path: 'src/existing.ts', status: 'modified' }] })
    const next = snapshot({ statuses: [{ path: 'src/existing.ts', status: 'modified', staged: 'all' }] })
    expect(collectChangedPaths(previous, next, new Set(['.git/index']))).toEqual([])
    // A status that does change what the diff shows is still named.
    const deleted = snapshot({ statuses: [{ path: 'src/existing.ts', status: 'deleted', staged: 'all' }] })
    expect(collectChangedPaths(previous, deleted, new Set(['.git/index']))).toEqual(['src/existing.ts'])
  })

  it('answers the same for an unsorted path list, which gets no binary search', () => {
    const previous = snapshot({ paths: ['z.txt', 'src/b.ts', 'src/a.ts', 'docs/x.md'], statuses: [] })
    const next = snapshot({ paths: ['z.txt', 'src/b.ts', 'docs/x.md', 'src/c.ts'], statuses: [] })
    expect(collectChangedPaths(previous, next, new Set(['src', 'z.txt'])))
      .toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'z.txt'])
  })

  it('does not match a sibling that only shares a name prefix', () => {
    const current = snapshot({ paths: ['src/a.ts', 'src-old/a.ts', 'srcx.ts'], statuses: [] })
    expect(collectChangedPaths(current, current, new Set(['src']))).toEqual(['src/a.ts'])
  })

  // The watcher tick that froze the main process: 100k paths, one save. Every
  // flush built four Sets of every path; on this list that was ~30–45 ms.
  it('costs next to nothing on a large unchanged path list', () => {
    const paths: string[] = []
    for (let a = 0; a < 250; a += 1) {
      for (let b = 0; b < 25; b += 1) {
        for (let c = 0; c < 16; c += 1) paths.push(`imux/m${a}/s${b}/f${c}.ts`)
      }
    }
    paths.sort()
    const statuses = paths.slice(0, 2_000).map((path) => ({ path, status: 'untracked' as const }))
    const previous = snapshot({ paths, statuses })
    const next = snapshot({ paths, statuses: statuses.map((status, index) => index === 5 ? { ...status, status: 'modified' as const } : status) })
    collectChangedPaths(previous, next, new Set(['build/cache']))

    const started = performance.now()
    const changed = collectChangedPaths(previous, next, new Set(['imux/m3/s2/f1.ts', 'build/cache']))
    const elapsed = performance.now() - started

    expect(changed).toEqual([paths[5]!, 'imux/m3/s2/f1.ts'].sort())
    expect(elapsed).toBeLessThan(10)
  })
})

describe('normalizeChangedPath', () => {
  it('keeps the Git metadata that changes what the snapshot says', () => {
    expect(normalizeChangedPath('.git/HEAD')).toBe('.git/HEAD')
    expect(normalizeChangedPath('.git/index')).toBe('.git/index')
    expect(normalizeChangedPath('.git/refs/heads/main')).toBe('.git/refs/heads/main')
    expect(normalizeChangedPath('src/app.ts')).toBe('src/app.ts')
    expect(normalizeChangedPath(null)).toBe('*')
  })

  it('drops lock files, save temporaries and generated directories', () => {
    expect(normalizeChangedPath('.git/index.lock')).toBeNull()
    expect(normalizeChangedPath('.git/refs/heads/main.lock')).toBeNull()
    expect(normalizeChangedPath('src/.kodi-save-1234')).toBeNull()
    expect(normalizeChangedPath('node_modules/pkg/index.js')).toBeNull()
    expect(normalizeChangedPath('.kodi/review/changes.patch')).toBeNull()
    expect(normalizeChangedPath('.git/COMMIT_EDITMSG')).toBeNull()
  })
})

describe('dropSelfWrites', () => {
  it('drops a path the app announced and leaves everything else alone', () => {
    const pending = new Set(['src/saved.ts', 'src/other.ts'])
    const selfWrites = new Map([['src/saved.ts', 2_000]])
    dropSelfWrites(pending, selfWrites, 1_000)
    expect([...pending]).toEqual(['src/other.ts'])
    expect(selfWrites.has('src/saved.ts')).toBe(true)
  })

  it('forgets an expired hint so a later external write is still reported', () => {
    const pending = new Set(['src/saved.ts'])
    const selfWrites = new Map([['src/saved.ts', 2_000]])
    dropSelfWrites(pending, selfWrites, 2_000)
    expect([...pending]).toEqual(['src/saved.ts'])
    expect(selfWrites.size).toBe(0)
  })
})

describe('resolveLinkedGitDirectory', () => {
  it('resolves the gitdir pointer of a linked worktree and ignores a normal repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-worktree-'))
    try {
      await writeFile(join(root, '.git'), `gitdir: ${join(root, 'real', 'worktrees', 'wt')}\n`, 'utf8')
      expect(resolveLinkedGitDirectory(root)).toBe(join(root, 'real', 'worktrees', 'wt'))

      const plain = await mkdtemp(join(tmpdir(), 'kodi-plain-'))
      try {
        await mkdir(join(plain, '.git'))
        expect(resolveLinkedGitDirectory(plain)).toBeNull()
      } finally {
        await rm(plain, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves a relative gitdir pointer against the worktree root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-worktree-rel-'))
    try {
      await writeFile(join(root, '.git'), 'gitdir: ../shared/.git/worktrees/wt\n', 'utf8')
      expect(resolveLinkedGitDirectory(root)).toBe(join(root, '..', 'shared', '.git', 'worktrees', 'wt'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// A recursive fs.watch is armed asynchronously on macOS (it is backed by an
// FSEvents stream), so a write issued right after start() can land before the
// stream is listening and is then never reported at all. Waiting longer cannot
// recover a missed event, so these tests rewrite until one is observed instead.
const WATCH_SETTLE_MS = 150
const WATCH_ATTEMPTS = 30
const WATCH_TEST_TIMEOUT_MS = 30_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(satisfied: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < WATCH_ATTEMPTS; attempt += 1) {
    if (satisfied()) return true
    await sleep(WATCH_SETTLE_MS)
  }
  return satisfied()
}

async function rewriteUntil(file: string, satisfied: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < WATCH_ATTEMPTS; attempt += 1) {
    await writeFile(file, `revision ${attempt}\n`, 'utf8')
    // Each write restarts the watcher's debounce, so settling has to outlast it
    // or the flush never gets a chance to run.
    await sleep(WATCH_SETTLE_MS)
    if (satisfied()) return true
  }
  return satisfied()
}

// Publishes triggered by the arming writes may still be in flight, and one
// landing later would corrupt whatever the test asserts next. Two equal samples
// are not enough on a loaded machine, where FSEvents can coalesce and deliver
// late, so quiet also has to last a minimum stretch of wall clock.
const QUIET_MINIMUM_MS = WATCH_SETTLE_MS * 4

async function waitForQuiet(count: () => number): Promise<void> {
  let previous = -1
  let quietSince = Date.now()
  while (previous !== count() || Date.now() - quietSince < QUIET_MINIMUM_MS) {
    if (previous !== count()) quietSince = Date.now()
    previous = count()
    await sleep(WATCH_SETTLE_MS)
  }
}

// A `.git/*` change is metadata-only, so the watcher gives it the longer
// debounce; a rewrite loop has to outlast that or every write just restarts the
// timer and the flush never runs.
const METADATA_SETTLE_MS = 500

async function rewriteMetadataUntil(file: string, satisfied: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await writeFile(file, `revision ${attempt}\n`, 'utf8')
    await sleep(METADATA_SETTLE_MS)
    if (satisfied()) return true
  }
  return satisfied()
}

describe('RepositoryWatcher', () => {
  it('publishes a targeted event after an existing file changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-watcher-'))
    const current = snapshot({ root, kind: 'folder', branch: null, head: null, statuses: [] })
    const events: RepositoryChangeEvent[] = []
    const errors: unknown[] = []
    const watcher = new RepositoryWatcher(
      async () => current,
      (event) => events.push(event),
      (error) => errors.push(error)
    )
    const targeted = (): RepositoryChangeEvent | undefined =>
      events.find((event) => event.changedPaths.includes('src/existing.ts'))

    try {
      const sourceDirectory = join(root, 'src')
      await mkdir(sourceDirectory)
      const file = join(sourceDirectory, 'existing.ts')
      await writeFile(file, 'first\n', 'utf8')
      watcher.start(current)

      expect(await rewriteUntil(file, () => targeted() != null)).toBe(true)
      expect(errors).toEqual([])
      expect(targeted()?.changedPaths).toEqual(['src/existing.ts'])
      expect(targeted()?.snapshot.paths).toBeUndefined()
    } finally {
      watcher.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, WATCH_TEST_TIMEOUT_MS)

  it('tells the renderer to drop everything when a folder reports an unnamed change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-watcher-'))
    const paths = Array.from({ length: 5_000 }, (_unused, index) => `src/file-${index}.ts`)
    const current = snapshot({ root, kind: 'folder', branch: null, head: null, statuses: [], paths })
    const events: RepositoryChangeEvent[] = []
    const watcher = new RepositoryWatcher(async () => current, (event) => events.push(event), () => {})
    try {
      watcher.start(current)
      watcher.acceptChangedPathForTests('*')
      expect(await waitFor(() => events.some((event) => event.invalidateAll === true))).toBe(true)
      const event = events.find((candidate) => candidate.invalidateAll === true)!
      // Every path used to be listed here — a second copy of the whole list.
      expect(event.changedPaths).toEqual([])
    } finally {
      watcher.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, WATCH_TEST_TIMEOUT_MS)

  it('coalesces file changes while suspended and publishes after resume', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-watcher-'))
    const current = snapshot({ root, kind: 'folder', branch: null, head: null, statuses: [] })
    const events: RepositoryChangeEvent[] = []
    const errors: unknown[] = []
    const watcher = new RepositoryWatcher(
      async () => current,
      (event) => events.push(event),
      (error) => errors.push(error)
    )

    try {
      const sourceDirectory = join(root, 'src')
      await mkdir(sourceDirectory)
      const file = join(sourceDirectory, 'existing.ts')
      await writeFile(file, 'first\n', 'utf8')
      watcher.start(current)

      // Suspending a watcher that was never armed would make the assertions
      // below pass for the wrong reason, so prove it is live first.
      expect(await rewriteUntil(file, () => events.length > 0)).toBe(true)
      await waitForQuiet(() => events.length)

      watcher.setSuspended(true)
      events.length = 0
      await writeFile(file, 'while suspended\n', 'utf8')
      await sleep(WATCH_SETTLE_MS * 2)
      // A stray publish left over from arming must not read as "the suspended
      // watcher fired", so the assertion is about the file under test only.
      const targeted = (): RepositoryChangeEvent[] =>
        events.filter((event) => event.changedPaths.includes('src/existing.ts'))
      expect(targeted()).toEqual([])

      watcher.setSuspended(false)
      expect(await waitFor(() => targeted().length > 0)).toBe(true)
      expect(targeted()[0]?.changedPaths).toEqual(['src/existing.ts'])
      expect(errors).toEqual([])
    } finally {
      watcher.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, WATCH_TEST_TIMEOUT_MS)

  it('stops watching while paused and catches up once it is re-armed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-watcher-pause-'))
    const current = snapshot({ root, kind: 'folder', branch: null, head: null, statuses: [] })
    const events: RepositoryChangeEvent[] = []
    const errors: unknown[] = []
    const watcher = new RepositoryWatcher(
      async () => current,
      (event) => events.push(event),
      (error) => errors.push(error)
    )
    const targeted = (): RepositoryChangeEvent[] =>
      events.filter((event) => event.changedPaths.includes('src/existing.ts'))

    try {
      const sourceDirectory = join(root, 'src')
      await mkdir(sourceDirectory)
      const file = join(sourceDirectory, 'existing.ts')
      await writeFile(file, 'first\n', 'utf8')
      watcher.start(current)
      expect(await rewriteUntil(file, () => targeted().length > 0)).toBe(true)
      await waitForQuiet(() => events.length)

      watcher.pause()
      expect(watcher.paused).toBe(true)
      events.length = 0
      await writeFile(file, 'while paused\n', 'utf8')
      await sleep(WATCH_SETTLE_MS * 2)
      // Unlike suspension, a paused watcher holds no OS handle, so the write is
      // never seen at all — not even after it is re-armed.
      expect(targeted()).toEqual([])

      expect(watcher.resume()).toBe(true)
      expect(watcher.paused).toBe(false)
      expect(await rewriteUntil(file, () => targeted().length > 0)).toBe(true)
      expect(errors).toEqual([])
    } finally {
      watcher.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, WATCH_TEST_TIMEOUT_MS)

  it('resuming a watcher that was never paused re-arms nothing', () => {
    const watcher = new RepositoryWatcher(
      async () => snapshot(),
      () => {},
      () => {}
    )
    expect(watcher.paused).toBe(false)
    expect(watcher.resume()).toBe(false)
  })

  it('drops the index write a refresh announced and still reports HEAD moving', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-watcher-index-'))
    const errors: unknown[] = []
    let refreshes = 0
    const watcher = new RepositoryWatcher(
      async () => {
        refreshes += 1
        return snapshot({ root, head: `head-${refreshes}` })
      },
      () => {},
      (error) => errors.push(error)
    )

    try {
      const gitDirectory = join(root, '.git')
      await mkdir(gitDirectory)
      const indexFile = join(gitDirectory, 'index')
      const headFile = join(gitDirectory, 'HEAD')
      await writeFile(indexFile, 'index 0\n', 'utf8')
      await writeFile(headFile, 'ref: refs/heads/main\n', 'utf8')
      watcher.start(snapshot({ root }))

      // An unannounced index write must reach the watcher, or the assertion
      // below would pass for a watcher that never sees `.git/index` at all.
      expect(await rewriteMetadataUntil(indexFile, () => refreshes > 0)).toBe(true)
      await waitForQuiet(() => refreshes)

      const announced = refreshes
      for (let attempt = 0; attempt < 6; attempt += 1) {
        // Every refresh re-arms the window, exactly as `RepositoryService` does.
        watcher.expectSelfWrite('.git/index')
        await writeFile(indexFile, `index self ${attempt}\n`, 'utf8')
        await sleep(METADATA_SETTLE_MS)
      }
      expect(refreshes).toBe(announced)

      watcher.expectSelfWrite('.git/index')
      expect(await rewriteMetadataUntil(headFile, () => refreshes > announced)).toBe(true)
      expect(errors).toEqual([])
    } finally {
      watcher.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, WATCH_TEST_TIMEOUT_MS)
})

describe('RepositoryWatcher revisions', () => {
  it('numbers ticks and announcements from one counter across every watcher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-watcher-revision-'))
    const current = snapshot({ root })
    const events: RepositoryChangeEvent[] = []
    const first = new RepositoryWatcher(async () => current, (event) => events.push(event), () => {})
    const second = new RepositoryWatcher(async () => current, (event) => events.push(event), () => {})
    try {
      first.start(current)
      first.announce(current, [])
      // A tick publishes the path it names before the refresh even returns.
      first.acceptChangedPathForTests('src/existing.ts')
      expect(await waitFor(() => events.length >= 2)).toBe(true)
      second.announce(snapshot({ root: `${root}-other` }), [])
      first.announce(current, [], { invalidateAll: true })

      const revisions = events.map((event) => event.revision)
      // Registry refreshes used to stamp `Date.now()` next to per-watcher
      // counters, so a later event could carry a smaller number.
      expect(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!)).toBe(true)
      expect(revisions.every((revision) => revision < 1e12)).toBe(true)
    } finally {
      first.stop()
      second.stop()
      await rm(root, { recursive: true, force: true })
    }
  }, WATCH_TEST_TIMEOUT_MS)
})

describe('normalizeChangedPath lock files', () => {
  it('drops git\'s own lock files', () => {
    expect(normalizeChangedPath('.git/refs/heads/main.lock')).toBeNull()
    expect(normalizeChangedPath('.git/index.lock')).toBeNull()
  })

  it('keeps a project lockfile, which is a real change', () => {
    expect(normalizeChangedPath('bun.lock')).toBe('bun.lock')
    expect(normalizeChangedPath('crates/app/Cargo.lock')).toBe('crates/app/Cargo.lock')
  })
})
