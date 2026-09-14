import { realpath } from 'node:fs/promises'

import type { RepositoryChangeEvent, RepositorySnapshot } from '../shared/contracts.js'
import { RepositoryService } from './repository.js'
import { collectChangedPaths, RepositoryWatcher } from './repositoryWatcher.js'
import { listRootSnapshot } from './workspaceListing.js'

interface RepositorySession {
  repository: RepositoryService
  watcher: RepositoryWatcher
  lastActiveAt: number
}

const INACTIVE_CACHE_FLOOR_BYTES = 8 * 1024 * 1024
// How many repositories keep a live session. Every folder ever opened used to
// hold its own recursive `fs.watch` and its own refresh loop, so a broad
// filesystem event cost one full git cycle per folder. Four covers the desk plus
// the pull requests a review realistically spans; the rest reopen on demand.
const MAX_RESIDENT_SESSIONS = 4
// How long opening a folder waits for the real snapshot before falling back to
// the directory listing. A refresh costs 30-130 ms on the repositories measured,
// so the wait almost always ends with the branch, the statuses and the full path
// list in hand instead of a skeleton the workspace has to be re-derived from.
const LIVE_SNAPSHOT_DEADLINE_MS = 150

export class RepositorySessionRegistry {
  #activeRoot: string | null = null
  #cacheDirectory: string | null = null
  #sessions = new Map<string, RepositorySession>()
  #suspended = false

  constructor(
    private readonly publish: (change: RepositoryChangeEvent) => void,
    private readonly reportError: (error: unknown) => void
  ) {}

  setPullRequestCacheDirectory(directory: string | null): void {
    this.#cacheDirectory = directory
    for (const { repository } of this.#sessions.values()) {
      repository.setPullRequestCacheDirectory(directory)
    }
  }

  get activeRoot(): string | null {
    return this.#activeRoot
  }

  get roots(): readonly string[] {
    return [...this.#sessions.keys()]
  }

  resourceStats(): { watcherCount: number; pendingWatcherPaths: number } {
    let watcherCount = 0
    let pendingWatcherPaths = 0
    for (const { watcher } of this.#sessions.values()) {
      watcherCount += watcher.handleCount
      pendingWatcherPaths += watcher.pendingPathCount
    }
    return { watcherCount, pendingWatcherPaths }
  }

  getActiveSnapshot(): RepositorySnapshot | null {
    return this.#activeRoot == null
      ? null
      : this.#sessions.get(this.#activeRoot)?.repository.getSessionSnapshot() ?? null
  }

  requireActive(): RepositoryService {
    if (this.#activeRoot == null) throw new Error('Open a repository before using this action.')
    return this.require(this.#activeRoot)
  }

  tryGetActive(): RepositoryService | null {
    return this.tryGet(this.#activeRoot)
  }

  cancelActiveContentSearch(): void {
    if (this.#activeRoot == null) return
    this.#sessions.get(this.#activeRoot)?.repository.cancelContentSearch()
  }

  require(root: string): RepositoryService {
    const session = this.#sessions.get(root)
    if (session == null) throw new Error('The repository tab is no longer open.')
    return session.repository
  }

  tryGet(root: string | null): RepositoryService | null {
    if (root == null) return null
    return this.#sessions.get(root)?.repository ?? null
  }

  /**
   * Review worlds outlive sessions: the resident cap can dispose the repository
   * behind a tab that is still on screen. Reopening it is cheaper than keeping
   * every folder armed — `open()` returns a live snapshot in tens of
   * milliseconds — so a stale tab reopens instead of failing.
   */
  async activate(root: string): Promise<RepositorySnapshot> {
    const snapshot = this.#sessions.get(root)?.repository.getSessionSnapshot() ?? null
    if (snapshot == null) return this.open(root)
    this.#setActiveRoot(root)
    return snapshot
  }

  hydrate(snapshot: RepositorySnapshot, activate = true): RepositorySnapshot {
    const existing = this.#sessions.get(snapshot.root)
    if (existing != null) {
      existing.repository.hydrate(snapshot)
      existing.watcher.sync(snapshot)
      if (activate) this.#setActiveRoot(snapshot.root)
      return snapshot
    }

    const session = this.#createSession(new RepositoryService())
    session.repository.hydrate(snapshot)
    session.watcher.start(snapshot)
    this.#sessions.set(snapshot.root, session)
    if (activate) this.#setActiveRoot(snapshot.root)
    else this.#parkBackgroundSession(snapshot.root, session)
    return snapshot
  }

  // Refreshing "whatever is active" is wrong for a background open: it re-reads the
  // repository the user is looking at and leaves the one that was just opened
  // stale.
  refresh(root: string): Promise<RepositorySnapshot | null> {
    const session = this.#sessions.get(root)
    if (session == null) return Promise.resolve(null)
    return this.#refreshAndPublish(session)
  }

  refreshActive(): Promise<RepositorySnapshot | null> {
    return this.#activeRoot == null ? Promise.resolve(null) : this.refresh(this.#activeRoot)
  }

  /**
   * `resolved` says the caller has already run the path through `realpath`, so
   * an open does one resolution rather than one per layer.
   */
  async open(folderPath: string, activate = true, resolved = false): Promise<RepositorySnapshot> {
    const selectedRoot = resolved ? folderPath : await realpath(folderPath)
    const known = this.#sessions.get(selectedRoot)
    if (known != null) {
      if (activate) this.#setActiveRoot(selectedRoot)
      const current = known.repository.getSessionSnapshot()
      if (current != null) {
        void this.#refreshAndPublish(known)
        return current
      }
      const instant = known.repository.hydrate(listRootSnapshot(selectedRoot))
      return await this.#raceLiveSnapshot(known) ?? instant
    }

    const repository = new RepositoryService()
    repository.setPullRequestCacheDirectory(this.#cacheDirectory)
    const snapshot = await repository.open(selectedRoot, true)
    const existing = this.#sessions.get(snapshot.root)
    if (existing != null) {
      repository.dispose()
      if (activate) this.#setActiveRoot(snapshot.root)
      const current = existing.repository.getSessionSnapshot()
      if (current != null) {
        void this.#refreshAndPublish(existing)
        return current
      }
      existing.repository.hydrate(snapshot)
      return await this.#raceLiveSnapshot(existing) ?? snapshot
    }

    const session = this.#createSession(repository)
    const { watcher } = session
    this.#sessions.set(snapshot.root, session)
    if (activate) this.#setActiveRoot(snapshot.root)
    else this.#evictBeyondCap()
    const live = await this.#raceLiveSnapshot(session)
    const opened = live ?? snapshot
    setImmediate(() => {
      if (this.#sessions.get(snapshot.root)?.watcher !== watcher) return
      watcher.start(opened)
      this.#parkBackgroundSession(snapshot.root, session)
    })
    return opened
  }

  sync(snapshot: RepositorySnapshot): RepositorySnapshot {
    this.#sessions.get(snapshot.root)?.watcher.sync(snapshot)
    return snapshot
  }

  release(root: string): void {
    const session = this.#sessions.get(root)
    if (session == null) return
    this.#stopSession(session)
    this.#sessions.delete(root)
    if (this.#activeRoot === root) this.#activeRoot = null
  }

  setSuspended(suspended: boolean): void {
    if (this.#suspended === suspended) return
    this.#suspended = suspended
    if (suspended) {
      for (const { watcher } of this.#sessions.values()) {
        watcher.setSuspended(true)
        watcher.pause()
      }
      return
    }
    // A paused watcher deliberately records no unbounded path list. One full
    // refresh is the authoritative dirty flag, and only the visible root is
    // rearmed. Background roots remain parked until the user selects them.
    const active = this.#activeRoot == null ? null : this.#sessions.get(this.#activeRoot)
    for (const { watcher } of this.#sessions.values()) watcher.setSuspended(false)
    if (active != null && active.watcher.resume()) void this.#refreshAndPublish(active)
  }

  stopAll(): void {
    for (const session of this.#sessions.values()) this.#stopSession(session)
    this.#sessions.clear()
    this.#activeRoot = null
  }

  #createSession(repository: RepositoryService): RepositorySession {
    repository.setPullRequestCacheDirectory(this.#cacheDirectory)
    // Not `refresh()`: a tick reports a write the refresh already in flight may
    // predate, and joining it would leave the snapshot stale until the next event.
    const watcher = new RepositoryWatcher(
      () => repository.refreshAfterExternalChange(),
      this.publish,
      this.reportError
    )
    const session: RepositorySession = { repository, watcher, lastActiveAt: Date.now() }
    repository.setSelfWriteObserver((path) => watcher.expectSelfWrite(path))
    // The gitignored set can land after the refresh that asked for it returned,
    // and it only ever adds paths, so it is published on its own with no
    // invalidated files.
    repository.setSnapshotObserver((snapshot) => {
      watcher.sync(snapshot)
      this.publish({ snapshot, changedPaths: [], revision: Date.now() })
    })
    watcher.setSuspended(this.#suspended)
    return session
  }

  #stopSession({ repository, watcher }: RepositorySession): void {
    watcher.stop()
    repository.cancelContentSearch()
    repository.cancelPullRequestReview()
    repository.setSelfWriteObserver(null)
    repository.setSnapshotObserver(null)
    repository.dispose()
  }

  #setActiveRoot(root: string): void {
    this.#activeRoot = root
    for (const [sessionRoot, session] of this.#sessions) {
      if (sessionRoot === root) continue
      session.repository.trimCaches(INACTIVE_CACHE_FLOOR_BYTES)
      session.watcher.pause()
    }
    const active = this.#sessions.get(root)
    if (active != null) {
      active.lastActiveAt = Date.now()
      // A paused session watched nothing while it was in the background, so its
      // snapshot is as old as the moment it lost focus. One refresh catches it up.
      if (active.watcher.resume()) void this.#refreshAndPublish(active)
    }
    this.#evictBeyondCap()
  }

  // A repository opened behind the reader's back — a pull request warmup, a
  // restore of a second tab — must not arm a watcher nobody is reading from.
  #parkBackgroundSession(root: string, session: RepositorySession): void {
    if (this.#activeRoot !== root) session.watcher.pause()
    this.#evictBeyondCap()
  }

  // Least-recently-active first, never the root in front of the reader.
  #evictBeyondCap(): void {
    if (this.#sessions.size <= MAX_RESIDENT_SESSIONS) return
    const evictable = [...this.#sessions]
      .filter(([root]) => root !== this.#activeRoot)
      .sort((left, right) => left[1].lastActiveAt - right[1].lastActiveAt)
    for (const [root, session] of evictable) {
      if (this.#sessions.size <= MAX_RESIDENT_SESSIONS) break
      this.#stopSession(session)
      this.#sessions.delete(root)
    }
  }

  /**
   * Opening a folder is worth a short wait: the caller returns the live snapshot
   * to the renderer instead of a listing the workspace view and the first
   * selection then have to be re-derived from. A refresh that misses the deadline
   * keeps running and is published as a change event, exactly as before.
   */
  async #raceLiveSnapshot(session: RepositorySession): Promise<RepositorySnapshot | null> {
    const previous = session.repository.getSessionSnapshot()
    const refreshed = session.repository.refresh()
    const deadline = new Promise<null>((resolveDeadline) => {
      const timer = setTimeout(() => resolveDeadline(null), LIVE_SNAPSHOT_DEADLINE_MS)
      timer.unref?.()
      void refreshed.then(
        () => clearTimeout(timer),
        () => clearTimeout(timer)
      )
    })
    const live = await Promise.race([refreshed.catch(() => null), deadline])
    if (live != null) {
      session.watcher.sync(live)
      return live
    }
    void refreshed.then(
      (late) => this.#publishRefreshed(session, previous, late),
      (error) => this.reportError(error)
    )
    return null
  }

  #publishRefreshed(
    session: RepositorySession,
    previous: RepositorySnapshot | null,
    live: RepositorySnapshot
  ): RepositorySnapshot {
    session.watcher.sync(live)
    const changedPaths = previous == null
      ? live.statuses.map((entry) => entry.path)
      : collectChangedPaths(previous, live, new Set(['*']))
    this.publish({ snapshot: live, changedPaths, revision: Date.now() })
    return live
  }

  async #refreshAndPublish(session: RepositorySession): Promise<RepositorySnapshot | null> {
    try {
      const previous = session.repository.getSessionSnapshot()
      const live = await session.repository.refresh()
      return this.#publishRefreshed(session, previous, live)
    } catch (error) {
      this.reportError(error)
      return session.repository.getSessionSnapshot()
    }
  }
}
