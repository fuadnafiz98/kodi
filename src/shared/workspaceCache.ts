import type { FileComparison, RepositorySnapshot, RepositoryStatusEntry } from './contracts.js'

export const WORKSPACE_CACHE_VERSION = 1
/**
 * The file holding several entries. Version 1 files carry a single workspace at
 * the top level and are read as a one-slot store.
 */
export const WORKSPACE_CACHE_STORE_VERSION = 2
export const MAX_CACHED_PATHS = 25_000
export const MAX_CACHED_STATUSES = 5_000
export const MAX_CACHED_FILE_CHARS = 512 * 1024
// Alternating between two repositories used to repaint the second one from a
// skeleton every time, because the cache had exactly one slot.
export const MAX_WORKSPACE_CACHE_SLOTS = 3

export type CachedWorkspaceView = 'file' | 'multi'

export interface CachedFileText {
  path: string
  text: string
}

export interface WorkspaceCache {
  version: typeof WORKSPACE_CACHE_VERSION
  lastRoot: string
  snapshot: RepositorySnapshot
  selectedPath: string | null
  workspaceView: CachedWorkspaceView
  fileText: CachedFileText | null
  savedAt: number
}

/**
 * A patch, not a snapshot of the whole UI: the open file's text travels on its
 * own channel and only when its contents actually changed, so most updates
 * carry two strings instead of half a megabyte.
 */
export interface WorkspaceUiState {
  selectedPath?: string | null
  workspaceView?: CachedWorkspaceView
  fileText?: CachedFileText | null
}

export interface WorkspaceCacheStore {
  version: typeof WORKSPACE_CACHE_STORE_VERSION
  lastRoot: string | null
  /** Most recently opened first, capped at MAX_WORKSPACE_CACHE_SLOTS. */
  entries: WorkspaceCache[]
}

export const EMPTY_WORKSPACE_CACHE_STORE: WorkspaceCacheStore = {
  version: WORKSPACE_CACHE_STORE_VERSION,
  lastRoot: null,
  entries: []
}

export interface InitialWorkspacePaint {
  snapshot: RepositorySnapshot | null
  selectedPath: string | null
  workspaceView: CachedWorkspaceView
  fileText: CachedFileText | null
}

const EMPTY_PAINT: InitialWorkspacePaint = {
  snapshot: null,
  selectedPath: null,
  workspaceView: 'file',
  fileText: null
}

export function parseWorkspaceCache(raw: unknown): WorkspaceCache | null {
  if (typeof raw !== 'object' || raw == null) return null
  const record = raw as Record<string, unknown>
  if (record.version !== WORKSPACE_CACHE_VERSION) return null
  if (typeof record.lastRoot !== 'string' || record.lastRoot === '') return null
  const snapshot = parseCachedSnapshot(record.snapshot)
  if (snapshot == null) return null
  if (snapshot.root !== record.lastRoot) snapshot.root = record.lastRoot
  const selectedPath = parseSelectedPath(record.selectedPath, snapshot.paths)
  const fileText = parseCachedFileText(record.fileText)
  return capWorkspaceCache({
    version: WORKSPACE_CACHE_VERSION,
    lastRoot: record.lastRoot,
    snapshot,
    selectedPath,
    workspaceView: record.workspaceView === 'multi' ? 'multi' : 'file',
    fileText: fileText != null && selectedPath != null && fileText.path === selectedPath
      ? fileText
      : null,
    savedAt: typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) ? record.savedAt : 0
  })
}

export function parseWorkspaceUi(raw: unknown): WorkspaceUiState | null {
  if (typeof raw !== 'object' || raw == null) return null
  const record = raw as Record<string, unknown>
  const selectedPath = typeof record.selectedPath === 'string' && record.selectedPath !== ''
    ? record.selectedPath
    : null
  return {
    selectedPath,
    workspaceView: record.workspaceView === 'multi' ? 'multi' : 'file',
    ...(record.fileText === undefined ? {} : { fileText: parseCachedFileText(record.fileText) })
  }
}


/**
 * Bounded by counts. Measuring the cache by serializing it cost up to 112 ms of
 * the main process on every publish, for a limit that path and status counts
 * already imply.
 */
export function capWorkspaceCache(cache: WorkspaceCache): WorkspaceCache {
  const snapshot = capSnapshot(cache.snapshot)
  const selectedPath = parseSelectedPath(cache.selectedPath, snapshot.paths)
  const fileText = capFileText(cache.fileText)
  return {
    ...cache,
    version: WORKSPACE_CACHE_VERSION,
    snapshot,
    selectedPath,
    fileText: fileText != null && selectedPath != null && fileText.path === selectedPath ? fileText : null
  }
}

/**
 * Reads both file shapes: the version 1 single workspace and the version 2
 * multi-slot store.
 */
export function parseWorkspaceCacheStore(raw: unknown): WorkspaceCacheStore {
  if (typeof raw !== 'object' || raw == null) return EMPTY_WORKSPACE_CACHE_STORE
  const record = raw as Record<string, unknown>
  if (record.version === WORKSPACE_CACHE_VERSION) {
    const single = parseWorkspaceCache(raw)
    return single == null
      ? EMPTY_WORKSPACE_CACHE_STORE
      : { version: WORKSPACE_CACHE_STORE_VERSION, lastRoot: single.lastRoot, entries: [single] }
  }
  if (record.version !== WORKSPACE_CACHE_STORE_VERSION || !Array.isArray(record.entries)) {
    return EMPTY_WORKSPACE_CACHE_STORE
  }
  const seen = new Set<string>()
  const entries: WorkspaceCache[] = []
  for (const candidate of record.entries) {
    if (entries.length >= MAX_WORKSPACE_CACHE_SLOTS) break
    const entry = parseWorkspaceCache(candidate)
    if (entry == null || seen.has(entry.lastRoot)) continue
    seen.add(entry.lastRoot)
    entries.push(entry)
  }
  // An explicit null is a closed folder: the next launch opens the dashboard,
  // not whichever entry happens to be first.
  const lastRoot = record.lastRoot === null
    ? null
    : typeof record.lastRoot === 'string' && seen.has(record.lastRoot)
      ? record.lastRoot
      : entries[0]?.lastRoot ?? null
  return { version: WORKSPACE_CACHE_STORE_VERSION, lastRoot, entries }
}

export function workspaceCacheForRoot(
  store: WorkspaceCacheStore,
  root: string | null | undefined
): WorkspaceCache | null {
  if (root == null || root === '') return null
  return store.entries.find((entry) => entry.lastRoot === root) ?? null
}

/** The workspace the next launch paints before git answers. */
export function lastWorkspaceCache(store: WorkspaceCacheStore): WorkspaceCache | null {
  return workspaceCacheForRoot(store, store.lastRoot)
}

/**
 * Points the next launch at `root` — or at nothing, when it is null or has no
 * cached entry to paint. The entries themselves stay, so reopening a closed
 * folder still paints from its cache.
 */
export function withLastWorkspaceRoot(store: WorkspaceCacheStore, root: string | null): WorkspaceCacheStore {
  const lastRoot = root != null && store.entries.some((entry) => entry.lastRoot === root) ? root : null
  return lastRoot === store.lastRoot ? store : { ...store, lastRoot }
}

/**
 * Upserts one repository's entry and moves it to the front. Beyond
 * MAX_WORKSPACE_CACHE_SLOTS the least recently opened entry falls off.
 */
export function rememberWorkspaceCacheEntry(
  store: WorkspaceCacheStore,
  entry: WorkspaceCache
): WorkspaceCacheStore {
  const rest = store.entries.filter((candidate) => candidate.lastRoot !== entry.lastRoot)
  return {
    version: WORKSPACE_CACHE_STORE_VERSION,
    lastRoot: entry.lastRoot,
    entries: [entry, ...rest].slice(0, MAX_WORKSPACE_CACHE_SLOTS)
  }
}

export function initialWorkspacePaint(cache: WorkspaceCache | null): InitialWorkspacePaint {
  if (cache == null) return EMPTY_PAINT
  const selectedPath = parseSelectedPath(cache.selectedPath, cache.snapshot.paths)
    ?? cache.snapshot.paths[0]
    ?? null
  return {
    snapshot: cache.snapshot,
    selectedPath,
    workspaceView: cache.workspaceView,
    fileText: cache.fileText != null && cache.fileText.path === selectedPath ? cache.fileText : null
  }
}

export function idleFileComparison(path: string): FileComparison {
  return {
    path,
    mode: 'file',
    status: 'unchanged',
    oldFile: null,
    newFile: null,
    binary: false,
    oversized: false
  }
}

export function comparisonFromCachedText(fileText: CachedFileText | null): FileComparison | null {
  if (fileText == null || fileText.text === '') return null
  const name = fileText.path.slice(fileText.path.lastIndexOf('/') + 1) || fileText.path
  return {
    path: fileText.path,
    mode: 'file',
    status: 'unchanged',
    oldFile: null,
    newFile: {
      name,
      contents: fileText.text,
      cacheKey: `workspace-cache:${fileText.path}`
    },
    binary: false,
    oversized: false
  }
}

/** Used when the renderer asks for a file before hydrate/open has a session. */
export function comparisonWithoutOpenSession(
  path: string,
  fileText: CachedFileText | null
): FileComparison {
  if (fileText != null && fileText.path === path) {
    return comparisonFromCachedText(fileText) ?? idleFileComparison(path)
  }
  return idleFileComparison(path)
}

/**
 * Identity of the text the cache would keep for this comparison. `cacheKey` is
 * main's sha1 of the file's contents, so the renderer can tell "the same file
 * again" from "the file changed" without hashing half a megabyte per render.
 */
export function cachedFileTextIdentity(comparison: FileComparison | null): string | null {
  if (cachedFileTextFromComparison(comparison) == null || comparison == null) return null
  return `${comparison.path}\0${comparison.newFile?.cacheKey ?? ''}`
}

export function cachedFileTextFromComparison(comparison: FileComparison | null): CachedFileText | null {
  const text = comparison?.newFile?.contents
  if (comparison == null || text == null || text === '' || comparison.binary || comparison.oversized) {
    return null
  }
  if (text.length > MAX_CACHED_FILE_CHARS) return null
  return { path: comparison.path, text }
}

export function mergeWorkspaceCache(
  snapshot: RepositorySnapshot,
  ui: WorkspaceUiState | null,
  previous: WorkspaceCache | null
): WorkspaceCache {
  const selectedPath = parseSelectedPath(ui?.selectedPath ?? previous?.selectedPath, snapshot.paths)
  const fileText = ui?.fileText !== undefined
    ? ui.fileText
    : previous?.fileText ?? null
  return capWorkspaceCache({
    version: WORKSPACE_CACHE_VERSION,
    lastRoot: snapshot.root,
    snapshot,
    selectedPath,
    workspaceView: ui?.workspaceView ?? previous?.workspaceView ?? defaultWorkspaceView(snapshot),
    fileText: fileText != null && selectedPath != null && fileText.path === selectedPath ? fileText : null,
    savedAt: Date.now()
  })
}

export function defaultWorkspaceView(snapshot: Pick<RepositorySnapshot, 'kind' | 'statuses'>): CachedWorkspaceView {
  return snapshot.kind === 'git' && snapshot.statuses.length > 0 ? 'multi' : 'file'
}

function parseCachedSnapshot(raw: unknown): RepositorySnapshot | null {
  if (typeof raw !== 'object' || raw == null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.root !== 'string' || record.root === '') return null
  if (typeof record.name !== 'string' || record.name === '') return null
  if (record.kind !== 'git' && record.kind !== 'folder') return null
  if (!Array.isArray(record.paths)) return null
  const paths = uniqueStrings(record.paths, MAX_CACHED_PATHS)
  return {
    root: record.root,
    name: record.name,
    kind: record.kind,
    branch: typeof record.branch === 'string' && record.branch !== '' ? record.branch : null,
    head: typeof record.head === 'string' && record.head !== '' ? record.head : null,
    paths,
    statuses: parseStatuses(record.statuses, paths)
  }
}

function parseStatuses(raw: unknown, paths: readonly string[]): RepositoryStatusEntry[] {
  if (!Array.isArray(raw)) return []
  const allowed = pathSet(paths)
  const statuses: RepositoryStatusEntry[] = []
  for (const entry of raw) {
    if (statuses.length >= MAX_CACHED_STATUSES) break
    if (typeof entry !== 'object' || entry == null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.path !== 'string' || !allowed.has(record.path)) continue
    if (!isStatus(record.status)) continue
    statuses.push({
      path: record.path,
      status: record.status,
      ...(typeof record.previousPath === 'string' && record.previousPath !== ''
        ? { previousPath: record.previousPath }
        : {})
    })
  }
  return statuses
}

function isStatus(value: unknown): value is RepositoryStatusEntry['status'] {
  return value === 'added'
    || value === 'conflicted'
    || value === 'deleted'
    || value === 'modified'
    || value === 'renamed'
    || value === 'untracked'
}

function parseSelectedPath(raw: unknown, paths: readonly string[]): string | null {
  if (typeof raw !== 'string' || raw === '') return null
  // Membership in a 25,000-path list, run once per publish and once per parse.
  return pathSet(paths).has(raw) ? raw : null
}

// Snapshots keep their path array identity across publishes, so the set behind
// one is built once and reused by every membership question about it.
const pathSetsByList = new WeakMap<readonly string[], Set<string>>()

function pathSet(paths: readonly string[]): Set<string> {
  const cached = pathSetsByList.get(paths)
  if (cached != null) return cached
  const set = new Set(paths)
  pathSetsByList.set(paths, set)
  return set
}

/** Also the IPC payload of the open file's own channel; `null` clears what was kept. */
export function parseCachedFileText(raw: unknown): CachedFileText | null {
  if (typeof raw !== 'object' || raw == null) return null
  const record = raw as Record<string, unknown>
  if (typeof record.path !== 'string' || record.path === '') return null
  if (typeof record.text !== 'string') return null
  return capFileText({ path: record.path, text: record.text })
}

function capSnapshot(snapshot: RepositorySnapshot): RepositorySnapshot {
  if (snapshot.paths.length <= MAX_CACHED_PATHS && snapshot.statuses.length <= MAX_CACHED_STATUSES) {
    return snapshot
  }
  const paths = snapshot.paths.slice(0, MAX_CACHED_PATHS)
  const allowed = pathSet(paths)
  return {
    ...snapshot,
    paths,
    statuses: snapshot.statuses.filter((entry) => allowed.has(entry.path)).slice(0, MAX_CACHED_STATUSES)
  }
}

function capFileText(fileText: CachedFileText | null): CachedFileText | null {
  if (fileText == null) return null
  if (fileText.text.length <= MAX_CACHED_FILE_CHARS) return fileText
  return { path: fileText.path, text: fileText.text.slice(0, MAX_CACHED_FILE_CHARS) }
}

function uniqueStrings(values: readonly unknown[], limit: number): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const value of values) {
    if (paths.length >= limit) break
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue
    seen.add(value)
    paths.push(value)
  }
  return paths
}
