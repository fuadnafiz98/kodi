import { readFileSync, watch, type FSWatcher } from 'node:fs'
import { access } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

import type { RepositoryChangeEvent, RepositorySnapshot } from '../shared/contracts.js'
import { snapshotWithoutPaths } from '../shared/heldPaths.js'

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

/** A save the app announced: until `expiry`, events for its path are its own. */
export interface SelfWrite {
  expiry: number
  /** Set when an event for the path was dropped as the app's own. */
  dropped: boolean
  /** Whether the file still holds exactly what the app wrote. */
  stillOurs?: () => Promise<boolean>
}

// The app's own saves are announced before the rename lands, so the event they
// produce carries no news. The window expires so a genuine external write to the
// same path moments later is still reported — and one that lands inside it (a
// formatter on save, an agent) is caught when it closes (see expectSelfWrite).
export function dropSelfWrites(
  pendingPaths: Set<string>,
  selfWrites: Map<string, SelfWrite>,
  now: number
): void {
  for (const [path, write] of selfWrites) {
    if (write.expiry <= now) {
      selfWrites.delete(path)
    } else if (pendingPaths.delete(path)) {
      write.dropped = true
    }
  }
}

// One counter for every watcher and every publish in the process. Registry
// refreshes once stamped `Date.now()` while ticks counted from zero per watcher,
// so an event's revision said nothing about which came later, and two sessions
// could hand the renderer the same number for different trees.
let lastChangeRevision = 0

function nextChangeRevision(): number {
  lastChangeRevision += 1
  return lastChangeRevision
}

type StatusSignature = Map<string, string>

function statusSignature(snapshot: RepositorySnapshot): StatusSignature {
  return new Map(snapshot.statuses.map((status) => [
    status.path,
    `${status.status}\0${status.previousPath ?? ''}\0${status.staged ?? ''}`
  ]))
}

/** The part of a status signature that changes what the file's diff shows. */
function contentSignature(signature: string | undefined): string | undefined {
  return signature?.slice(0, signature.lastIndexOf('\0'))
}

function snapshotsMatch(left: RepositorySnapshot, right: RepositorySnapshot): boolean {
  if (left.root !== right.root || left.kind !== right.kind || left.branch !== right.branch || left.head !== right.head) return false
  if (left.paths.length !== right.paths.length || left.statuses.length !== right.statuses.length) return false
  if (left.paths !== right.paths && left.paths.some((path, index) => path !== right.paths[index])) return false
  return left.statuses.every((status, index) => {
    const other = right.statuses[index]
    return other != null
      && status.path === other.path
      && status.status === other.status
      && status.previousPath === other.previousPath
      && status.staged === other.staged
  })
}

/**
 * Membership and prefix lookups over one snapshot's path list. Snapshot lists
 * are sorted in byte order, so both are binary searches; the answer to "is it
 * sorted" is kept per list identity, and an unchanged tick reuses the list. A
 * Set of every path was built — twice per side — on every watcher flush, ~55 ms
 * of blocked main process per tick at 100k paths.
 */
interface PathIndex {
  has(path: string): boolean
  forEachWithPrefix(prefix: string, visit: (path: string) => void): void
}

const pathIndexes = new WeakMap<readonly string[], PathIndex>()

function pathIndex(paths: readonly string[]): PathIndex {
  const cached = pathIndexes.get(paths)
  if (cached != null) return cached
  let sorted = true
  for (let index = 1; index < paths.length && sorted; index += 1) {
    if (paths[index - 1]! >= paths[index]!) sorted = false
  }
  const index: PathIndex = sorted ? sortedPathIndex(paths) : unsortedPathIndex(paths)
  pathIndexes.set(paths, index)
  return index
}

function lowerBound(paths: readonly string[], target: string): number {
  let low = 0
  let high = paths.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (paths[middle]! < target) low = middle + 1
    else high = middle
  }
  return low
}

function sortedPathIndex(paths: readonly string[]): PathIndex {
  return {
    has: (path) => paths[lowerBound(paths, path)] === path,
    forEachWithPrefix(prefix, visit) {
      for (let index = lowerBound(paths, prefix); index < paths.length; index += 1) {
        const path = paths[index]!
        if (!path.startsWith(prefix)) return
        visit(path)
      }
    }
  }
}

function unsortedPathIndex(paths: readonly string[]): PathIndex {
  let set: Set<string> | null = null
  return {
    has: (path) => (set ??= new Set(paths)).has(path),
    forEachWithPrefix(prefix, visit) {
      for (const path of paths) if (path.startsWith(prefix)) visit(path)
    }
  }
}

/** Paths in one list and not the other. A tick differs in a short window, so the shared head and tail are skipped by identity first. */
function differingPaths(previous: readonly string[], next: readonly string[], visit: (path: string) => void): void {
  let head = 0
  const shortest = Math.min(previous.length, next.length)
  while (head < shortest && previous[head] === next[head]) head += 1
  let previousEnd = previous.length
  let nextEnd = next.length
  while (previousEnd > head && nextEnd > head && previous[previousEnd - 1] === next[nextEnd - 1]) {
    previousEnd -= 1
    nextEnd -= 1
  }
  const before = new Set(previous.slice(head, previousEnd))
  const after = new Set(next.slice(head, nextEnd))
  for (const path of before) if (!after.has(path)) visit(path)
  for (const path of after) if (!before.has(path)) visit(path)
}

export function collectChangedPaths(
  previous: RepositorySnapshot,
  next: RepositorySnapshot,
  filesystemPaths: ReadonlySet<string>,
  signatures: { previous: StatusSignature; next: StatusSignature } = {
    previous: statusSignature(previous),
    next: statusSignature(next)
  }
): string[] {
  const samePaths = previous.paths === next.paths
  const previousIndex = pathIndex(previous.paths)
  const nextIndex = samePaths ? previousIndex : pathIndex(next.paths)
  const previousStatuses = signatures.previous
  const nextStatuses = signatures.next
  const statusPaths = new Set([...previousStatuses.keys(), ...nextStatuses.keys()])
  const changedPaths = new Set<string>()
  const add = (path: string): void => { changedPaths.add(path) }
  const directoryPrefixes = new Set<string>()

  for (const path of filesystemPaths) {
    if (path === '*') {
      if (previous.kind === 'git') {
        for (const statusPath of statusPaths) changedPaths.add(statusPath)
      } else {
        for (const visiblePath of previous.paths) changedPaths.add(visiblePath)
        if (!samePaths) for (const visiblePath of next.paths) changedPaths.add(visiblePath)
      }
    } else if (path.startsWith('.git/')) {
      continue
    } else if (previousIndex.has(path) || nextIndex.has(path)) {
      changedPaths.add(path)
    } else {
      directoryPrefixes.add(`${path.replace(/\/$/, '')}/`)
    }
  }
  for (const prefix of directoryPrefixes) {
    previousIndex.forEachWithPrefix(prefix, add)
    if (!samePaths) nextIndex.forEachWithPrefix(prefix, add)
  }
  if (!samePaths) differingPaths(previous.paths, next.paths, add)
  // Staging flips `staged` and nothing the reader sees: the working-tree diff is
  // the same bytes. Naming those paths made the review refetch, re-parse and
  // re-highlight every staged file on every stage, unstage and Stage All.
  for (const path of statusPaths) {
    if (contentSignature(previousStatuses.get(path)) !== contentSignature(nextStatuses.get(path))) changedPaths.add(path)
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
  #selfWrites = new Map<string, SelfWrite>()
  #selfWriteTimers = new Set<ReturnType<typeof setTimeout>>()
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
    const accept = (path: string | null): void => this.#accept(generation, path)
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

  #accept(generation: number, path: string | null): void {
    if (generation !== this.#generation || path == null) return
    const alreadyPending = this.#pendingPaths.has(path)
    this.#pendingPaths.add(path)
    if (!alreadyPending && !path.startsWith('.git/')) this.#pendingContentCount += 1
    this.#schedule(generation)
  }

  // `fs.watch` reports an unnamed event (the '*' path) only when the OS drops
  // or coalesces events, which a test cannot arrange on demand.
  acceptChangedPathForTests(path: string): void {
    this.#accept(this.#generation, path)
  }

  // Called before the rename that completes a save: the app already knows what it
  // wrote, so refreshing on its own write costs a whole-tree status walk for
  // nothing. The window is short so a genuine external edit is never swallowed.
  //
  // Everything dropped inside the window is checked once it closes: a file that
  // no longer holds what the app wrote was written by someone else in that
  // second, and swallowing it left the reader on the app's own text for good.
  expectSelfWrite(path: string, stillOurs?: () => Promise<boolean>): void {
    const write: SelfWrite = { expiry: Date.now() + SELF_WRITE_WINDOW_MS, dropped: false, stillOurs }
    this.#selfWrites.set(path, write)
    if (stillOurs == null) return
    const generation = this.#generation
    const timer = setTimeout(() => {
      this.#selfWriteTimers.delete(timer)
      if (generation !== this.#generation) return
      if (this.#selfWrites.get(path) === write) this.#selfWrites.delete(path)
      if (!write.dropped) return
      void stillOurs().then((ours) => {
        if (ours || generation !== this.#generation) return
        this.#pendingPaths.add(path)
        this.#schedule(generation)
      }, () => {})
    }, SELF_WRITE_WINDOW_MS)
    this.#selfWriteTimers.add(timer)
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
    for (const timer of this.#selfWriteTimers) clearTimeout(timer)
    this.#selfWriteTimers.clear()
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
    const previousPathIndex = pathIndex(previous.paths)
    this.#pendingPaths.clear()
    this.#pendingContentCount = 0
    this.#refreshing = true
    try {
      const knownContentPaths = [...filesystemPaths].filter((path) =>
        path !== '*' && !path.startsWith('.git/') && previousPathIndex.has(path)
      )
      const knownContentPathSet = new Set(knownContentPaths)
      if (knownContentPaths.length > 0) this.#publish(previous, knownContentPaths)

      const snapshot = await this.refresh()
      if (generation !== this.#generation) return
      this.#snapshot = snapshot
      const previousStatus = statusSignature(previous)
      const nextStatus = statusSignature(snapshot)
      // A folder has no statuses to narrow an unknown event with, so "something
      // changed" names every path; the renderer is told to drop everything
      // instead of receiving (and cloning, and indexing) the whole list again.
      if (previous.kind !== 'git' && filesystemPaths.has('*')) {
        this.#publish(snapshot, [], { invalidateAll: true })
        return
      }
      const metadataPaths = collectChangedPaths(previous, snapshot, filesystemPaths, {
        previous: previousStatus,
        next: nextStatus
      })
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

  /**
   * Publishes a refresh the registry ran on the reader's behalf — a tab
   * activation, reopening a known root, waking from suspension. It goes
   * through the same path-list check as a tick: those refreshes almost always
   * keep the list, and shipping it anyway cost a full clone into every window
   * on each tab switch.
   */
  announce(
    snapshot: RepositorySnapshot,
    changedPaths: string[],
    options: { invalidateAll?: boolean } = {}
  ): void {
    if (this.#snapshot?.root === snapshot.root) this.#snapshot = snapshot
    this.#publish(snapshot, changedPaths, options)
  }

  #publish(
    snapshot: RepositorySnapshot,
    changedPaths: string[],
    options: { invalidateAll?: boolean } = {}
  ): void {
    const pathsChanged = this.#publishedPaths !== snapshot.paths
    if (pathsChanged) this.#publishedPaths = snapshot.paths
    const eventSnapshot = pathsChanged ? snapshot : snapshotWithoutPaths(snapshot)
    this.publish({
      snapshot: eventSnapshot,
      changedPaths,
      ...(options.invalidateAll === true ? { invalidateAll: true } : {}),
      revision: nextChangeRevision()
    })
  }
}
