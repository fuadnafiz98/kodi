import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { access } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import type { RepositoryChangeEvent, RepositorySnapshot } from '../shared/contracts.js'

const CHANGE_DEBOUNCE_MS = 80
// A commit or a rebase writes `.git/index` and the refs it moves several times in
// a row. Measured over five commits in a temp repo the watcher accepted 36 events;
// giving metadata-only batches their own longer window collapses them into one
// flush without delaying a content edit, which still uses the short debounce.
const METADATA_DEBOUNCE_MS = 350
// An abandoned `.git/index.lock` must not freeze refreshes forever.
const MAX_OPERATION_DEFERRAL_MS = 5_000
// A save writes a sibling temp file and renames it over the target; without this
// the temp file surfaces as an untracked path in whatever snapshot lands between
// the write and the rename.
const SELF_WRITE_PREFIX = '.kodi-save-'
const SELF_WRITE_WINDOW_MS = 1_000
const OPERATION_MARKERS = ['index.lock', 'rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'] as const
const EXCLUDED_SEGMENTS = new Set([
  '.cache', '.next', '.nuxt', '.output', '.parcel-cache', '.svelte-kit', '.turbo',
  '.vercel', '.vite', '.kodi', '.horus', 'DerivedData', 'build', 'coverage', 'dist', 'node_modules',
  'out', 'target'
])

export function normalizeChangedPath(filename: string | Buffer | null): string | null {
  if (filename == null) return '*'
  const path = filename.toString().replaceAll('\\', '/').replace(/^\.\//, '')
  if (path === '') return null
  const segments = path.split('/')
  // Lock files inside .git are git's own scratch space: `.git/refs/heads/main.lock`
  // accounted for every fifth accepted event during a commit loop and never
  // carries state. A project's bun.lock / Cargo.lock is a real change.
  if (segments[0] === '.git' && path.endsWith('.lock')) return null
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return null
  if (segments.at(-1)?.startsWith(SELF_WRITE_PREFIX) === true) return null
  if (segments[0] !== '.git') return path
  return path === '.git/HEAD' || path === '.git/index' || path.startsWith('.git/refs/')
    ? path
    : null
}

// A linked worktree's `.git` is a file pointing at the real git directory, so the
// recursive watch on the worktree root never sees HEAD, the index or refs move.
export function resolveLinkedGitDirectory(root: string): string | null {
  try {
    const pointer = readFileSync(resolve(root, '.git'), 'utf8')
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer)
    const target = match?.[1]
    if (target == null || target === '') return null
    return isAbsolute(target) ? target : resolve(root, target)
  } catch {
    return null
  }
}

// The app's own saves are announced before the rename lands, so the event they
// produce carries no news. The window expires so a genuine external write to the
// same path moments later is still reported.
export function dropSelfWrites(
  pendingPaths: Set<string>,
  selfWrites: Map<string, number>,
  now: number
): void {
  for (const [path, expiry] of selfWrites) {
    if (expiry <= now) selfWrites.delete(path)
    else pendingPaths.delete(path)
  }
}

function statusSignature(snapshot: RepositorySnapshot): Map<string, string> {
  return new Map(snapshot.statuses.map((status) => [
    status.path,
    `${status.status}\0${status.previousPath ?? ''}`
  ]))
}

function snapshotsMatch(left: RepositorySnapshot, right: RepositorySnapshot): boolean {
  if (left.root !== right.root || left.kind !== right.kind || left.branch !== right.branch || left.head !== right.head) return false
  if (left.paths.length !== right.paths.length || left.statuses.length !== right.statuses.length) return false
  if (left.paths.some((path, index) => path !== right.paths[index])) return false
  return left.statuses.every((status, index) => {
    const other = right.statuses[index]
    return other != null
      && status.path === other.path
      && status.status === other.status
      && status.previousPath === other.previousPath
  })
}

export function collectChangedPaths(
  previous: RepositorySnapshot,
  next: RepositorySnapshot,
  filesystemPaths: ReadonlySet<string>
): string[] {
  const previousPaths = new Set(previous.paths)
  const nextPaths = new Set(next.paths)
  const previousStatuses = statusSignature(previous)
  const nextStatuses = statusSignature(next)
  const visiblePaths = new Set([...previousPaths, ...nextPaths])
  const statusPaths = new Set([...previousStatuses.keys(), ...nextStatuses.keys()])
  const changedPaths = new Set<string>()
  const directoryPrefixes = new Set<string>()

  for (const path of filesystemPaths) {
    if (path === '*') {
      const paths = previous.kind === 'git' ? statusPaths : visiblePaths
      for (const visiblePath of paths) changedPaths.add(visiblePath)
    } else if (!path.startsWith('.git/') && (previousPaths.has(path) || nextPaths.has(path))) {
      changedPaths.add(path)
    } else if (!path.startsWith('.git/')) {
      directoryPrefixes.add(`${path.replace(/\/$/, '')}/`)
    }
  }
  if (directoryPrefixes.size > 0) {
    for (const visiblePath of visiblePaths) {
      let slash = visiblePath.indexOf('/')
      while (slash >= 0) {
        if (directoryPrefixes.has(visiblePath.slice(0, slash + 1))) {
          changedPaths.add(visiblePath)
          break
        }
        slash = visiblePath.indexOf('/', slash + 1)
      }
    }
  }
  for (const path of previousPaths) {
    if (!nextPaths.has(path)) changedPaths.add(path)
  }
  for (const path of nextPaths) {
    if (!previousPaths.has(path)) changedPaths.add(path)
  }
  for (const path of statusPaths) {
    if (previousStatuses.get(path) !== nextStatuses.get(path)) changedPaths.add(path)
  }
  if (previous.head !== next.head || previous.branch !== next.branch) {
    for (const path of statusPaths) changedPaths.add(path)
  }

  return [...changedPaths].sort()
}

export class RepositoryWatcher {
  #watcher: FSWatcher | null = null
  #gitDirectoryWatcher: FSWatcher | null = null
  #gitDirectory: string | null = null
  #selfWrites = new Map<string, number>()
  #deferredSince = 0
  #snapshot: RepositorySnapshot | null = null
  #publishedPaths: string[] | null = null
  #pendingPaths = new Set<string>()
  #pendingContentCount = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  #refreshing = false
  #suspended = false
  #paused = false
  #generation = 0
  #revision = 0

  constructor(
    private readonly refresh: () => Promise<RepositorySnapshot>,
    private readonly publish: (event: RepositoryChangeEvent) => void,
    private readonly reportError: (error: unknown) => void
  ) {}

  /** True while the OS watch handles are closed but the snapshot is still held. */
  get paused(): boolean {
    return this.#paused
  }

  get handleCount(): number {
    return Number(this.#watcher != null) + Number(this.#gitDirectoryWatcher != null)
  }

  get pendingPathCount(): number {
    return this.#pendingPaths.size
  }

  start(snapshot: RepositorySnapshot): void {
    this.stop()
    this.#snapshot = snapshot
    this.#publishedPaths = snapshot.paths
    if (this.#suspended) {
      this.#paused = true
      return
    }
    this.#paused = false
    const generation = this.#generation
    const accept = (path: string | null): void => {
      if (generation !== this.#generation || path == null) return
      const alreadyPending = this.#pendingPaths.has(path)
      this.#pendingPaths.add(path)
      if (!alreadyPending && !path.startsWith('.git/')) this.#pendingContentCount += 1
      this.#schedule(generation)
    }
    try {
      this.#watcher = watch(snapshot.root, { recursive: true }, (_eventType, filename) => {
        accept(normalizeChangedPath(filename))
      })
      this.#watcher.on('error', this.reportError)
    } catch (error) {
      this.reportError(error)
    }

    this.#gitDirectory = resolveLinkedGitDirectory(snapshot.root)
    const gitDirectory = this.#gitDirectory
    if (gitDirectory == null) return
    try {
      this.#gitDirectoryWatcher = watch(gitDirectory, { recursive: true }, (_eventType, filename) => {
        accept(normalizeChangedPath(filename == null ? null : `.git/${filename.toString()}`))
      })
      this.#gitDirectoryWatcher.on('error', this.reportError)
    } catch (error) {
      this.reportError(error)
    }
  }

  // Called before the rename that completes a save: the app already knows what it
  // wrote, so refreshing on its own write costs a whole-tree status walk for
  // nothing. The window is short so a genuine external edit is never swallowed.
  expectSelfWrite(path: string): void {
    this.#selfWrites.set(path, Date.now() + SELF_WRITE_WINDOW_MS)
  }

  sync(snapshot: RepositorySnapshot): void {
    if (this.#snapshot?.root !== snapshot.root) return
    this.#snapshot = snapshot
    // sync follows a snapshot returned directly to the renderer by an IPC
    // mutation, so both processes already share this logical path revision.
    this.#publishedPaths = snapshot.paths
  }

  setSuspended(suspended: boolean): void {
    if (this.#suspended === suspended) return
    this.#suspended = suspended
    if (suspended) {
      if (this.#timer != null) clearTimeout(this.#timer)
      this.#timer = null
    } else if (this.#pendingPaths.size > 0) {
      this.#schedule(this.#generation)
    }
  }

  /**
   * Closes the watch handles of a repository nobody is looking at. The snapshot
   * stays, so re-arming costs one `watch()` instead of a reopen — and a machine
   * with six folders open stops running six recursive watches and six refresh
   * loops against every broad filesystem event.
   */
  pause(): void {
    if (this.#paused) return
    this.#paused = true
    this.#generation += 1
    this.#closeHandles()
    this.#pendingPaths.clear()
    this.#pendingContentCount = 0
    this.#deferredSince = 0
    if (this.#timer != null) clearTimeout(this.#timer)
    this.#timer = null
  }

  /** Re-arms a paused watcher. Returns false when there was nothing to re-arm. */
  resume(): boolean {
    if (!this.#paused) return false
    this.#paused = false
    const snapshot = this.#snapshot
    if (snapshot == null) return false
    this.start(snapshot)
    return true
  }

  stop(): void {
    this.#paused = false
    this.#generation += 1
    this.#closeHandles()
    this.#snapshot = null
    this.#publishedPaths = null
    this.#pendingPaths.clear()
    this.#pendingContentCount = 0
    this.#selfWrites.clear()
    this.#deferredSince = 0
    if (this.#timer != null) clearTimeout(this.#timer)
    this.#timer = null
  }

  #closeHandles(): void {
    this.#watcher?.close()
    this.#watcher = null
    this.#gitDirectoryWatcher?.close()
    this.#gitDirectoryWatcher = null
    this.#gitDirectory = null
  }

  #schedule(generation: number, delay?: number): void {
    if (this.#suspended || this.#paused) return
    if (this.#timer != null) clearTimeout(this.#timer)
    const metadataOnly = this.#pendingContentCount === 0
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.#flush(generation)
    }, delay ?? (metadataOnly && this.#pendingPaths.size > 0 ? METADATA_DEBOUNCE_MS : CHANGE_DEBOUNCE_MS))
  }

  // Refreshing in the middle of a commit, rebase or merge reads a half-written
  // index and then has to do it all again when the operation lands.
  async #operationInProgress(): Promise<boolean> {
    const gitDirectory = this.#gitDirectory ?? (this.#snapshot == null ? null : resolve(this.#snapshot.root, '.git'))
    if (gitDirectory == null) return false
    const markers = await Promise.all(OPERATION_MARKERS.map((marker) =>
      access(resolve(gitDirectory, marker)).then(() => true, () => false)
    ))
    return markers.some(Boolean)
  }

  async #flush(generation: number): Promise<void> {
    if (generation !== this.#generation || this.#snapshot == null || this.#suspended || this.#paused) return
    if (this.#refreshing) {
      this.#schedule(generation)
      return
    }

    const operationInProgress = await this.#operationInProgress()
    if (generation !== this.#generation || this.#snapshot == null || this.#suspended || this.#paused) return
    if (operationInProgress) {
      const now = Date.now()
      if (this.#deferredSince === 0) this.#deferredSince = now
      if (now - this.#deferredSince < MAX_OPERATION_DEFERRAL_MS) {
        this.#schedule(generation, METADATA_DEBOUNCE_MS)
        return
      }
    }
    this.#deferredSince = 0

    const previous = this.#snapshot
    dropSelfWrites(this.#pendingPaths, this.#selfWrites, Date.now())
    this.#pendingContentCount = 0
    for (const path of this.#pendingPaths) {
      if (!path.startsWith('.git/')) this.#pendingContentCount += 1
    }
    // Nothing left once the app's own writes are dropped, so the whole point of
    // the hint would be lost by refreshing anyway.
    if (this.#pendingPaths.size === 0) return

    const filesystemPaths = new Set(this.#pendingPaths)
    const previousPathSet = new Set(previous.paths)
    this.#pendingPaths.clear()
    this.#pendingContentCount = 0
    this.#refreshing = true
    try {
      const knownContentPaths = [...filesystemPaths].filter((path) =>
        path !== '*' && !path.startsWith('.git/') && previousPathSet.has(path)
      )
      const knownContentPathSet = new Set(knownContentPaths)
      if (knownContentPaths.length > 0) this.#publish(previous, knownContentPaths)

      const snapshot = await this.refresh()
      if (generation !== this.#generation) return
      this.#snapshot = snapshot
      const previousStatus = statusSignature(previous)
      const nextStatus = statusSignature(snapshot)
      const metadataPaths = collectChangedPaths(previous, snapshot, filesystemPaths)
        .filter((path) =>
          !knownContentPathSet.has(path) || previousStatus.get(path) !== nextStatus.get(path)
        )
      if (!snapshotsMatch(previous, snapshot) || metadataPaths.length > 0) {
        this.#publish(snapshot, metadataPaths)
      }
    } catch (error) {
      if (generation === this.#generation) this.reportError(error)
    } finally {
      this.#refreshing = false
      if (generation === this.#generation && this.#pendingPaths.size > 0) this.#schedule(generation)
    }
  }

  #publish(snapshot: RepositorySnapshot, changedPaths: string[]): void {
    this.#revision += 1
    const pathsChanged = this.#publishedPaths !== snapshot.paths
    if (pathsChanged) this.#publishedPaths = snapshot.paths
    const eventSnapshot = pathsChanged
      ? snapshot
      : {
          root: snapshot.root,
          name: snapshot.name,
          kind: snapshot.kind,
          branch: snapshot.branch,
          head: snapshot.head,
          statuses: snapshot.statuses
        }
    this.publish({ snapshot: eventSnapshot, changedPaths, revision: this.#revision })
  }
}
