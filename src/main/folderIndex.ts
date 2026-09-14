import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'

import type { FolderCandidate, FolderPickerCatalog } from '../shared/contracts.js'
import { displayUserPath, folderNameFromPath } from '../shared/folderPath.js'

export const DEFAULT_SCAN_ROOT_NAMES = ['Developer', 'Projects', 'src', 'code', 'work', 'repos'] as const

export const SKIPPED_DIRECTORY_NAMES = new Set([
  '.cache',
  '.git',
  '.horus',
  '.kodi',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'DerivedData',
  'Pods',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target',
  'vendor',
  'venv'
])

const MAX_FOLDERS = 400
const MAX_DEPTH = 4
const CACHE_TTL_MS = 30_000

export function isPathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

export async function collectFolderCandidates(
  home: string,
  extraRoots: readonly string[] = []
): Promise<FolderCandidate[]> {
  const resolvedHome = await safeRealpath(home) ?? home
  // Every root probe is independent of every other one, so the whole set of
  // stats resolves in one round instead of one root at a time.
  const [defaultRoots, extraDirectories] = await Promise.all([
    Promise.all(DEFAULT_SCAN_ROOT_NAMES.map((name) => resolveScanRoot(join(resolvedHome, name)))),
    Promise.all(extraRoots.map((root) => resolveExtraRoot(root)))
  ])

  const found = new Map<string, FolderCandidate>()
  const scanRoots = new Set<string>()
  for (const root of defaultRoots) {
    if (root != null) scanRoots.add(root)
  }
  for (const root of extraDirectories) {
    if (root != null) addCandidate(found, root, resolvedHome)
  }

  // Roots are walked in `DEFAULT_SCAN_ROOT_NAMES` order, one at a time, so the
  // folder cap always keeps the same candidates. Concurrency lives inside
  // `walk`, per directory.
  await visitInOrder([...scanRoots], (root) => walk(root, 0, found, resolvedHome))

  return [...found.values()].toSorted((left, right) => left.displayPath.localeCompare(right.displayPath))
}

/** A default scan root counts only when it exists as a directory; its realpath is what gets walked. */
async function resolveScanRoot(root: string): Promise<string | null> {
  const [directory, resolved] = await Promise.all([isDirectory(root), safeRealpath(root)])
  if (!directory) return null
  return resolved ?? root
}

/** A remembered root is named by the caller, so it is resolved first and checked afterwards. */
async function resolveExtraRoot(root: string): Promise<string | null> {
  const resolved = await safeRealpath(root)
  if (resolved == null || !await isDirectory(resolved)) return null
  return resolved
}

export async function resolveOpenableFolder(
  value: unknown,
  options: { home: string; approvedRoots: readonly string[] }
): Promise<string> {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error('Folder path must be absolute.')
  }
  const resolved = await realpath(value).catch(() => {
    throw new Error('That folder no longer exists.')
  })
  const info = await stat(resolved).catch(() => {
    throw new Error('That folder no longer exists.')
  })
  if (!info.isDirectory()) throw new Error('Choose a folder, not a file.')

  // The home realpath and the approved-root realpaths need nothing from each
  // other; only the scan roots are built from the resolved home.
  const [resolvedHome, approved] = await Promise.all([
    safeRealpath(options.home),
    Promise.all(options.approvedRoots.map((root) => safeRealpath(root)))
  ])
  const home = resolvedHome ?? options.home
  if (resolved === home) throw new Error('Choose a project folder, not your home directory.')
  const scanRoots = await Promise.all(
    DEFAULT_SCAN_ROOT_NAMES.map((name) => safeRealpath(join(home, name)))
  )
  const allowed = approved.some((root) => root != null && isPathInside(root, resolved))
    || scanRoots.some((root) => root != null && isPathInside(root, resolved))
  if (!allowed) {
    throw new Error('Select this folder with Use Existing… if it lives outside your usual project folders.')
  }
  return resolved
}

export class FolderIndex {
  #folders: FolderCandidate[] | null = null
  #expiresAt = 0
  #inflight: Promise<FolderCandidate[]> | null = null
  #extraRoots: readonly string[] = []

  constructor(readonly home: string) {}

  setExtraRoots(roots: readonly string[]): void {
    if (sameRoots(this.#extraRoots, roots)) return
    this.#extraRoots = [...roots]
    this.#expiresAt = 0
  }

  async list(extraRoots?: readonly string[]): Promise<FolderPickerCatalog> {
    if (extraRoots != null) this.setExtraRoots(extraRoots)
    const folders = await this.#ensure()
    return { home: this.home, folders }
  }

  async #ensure(): Promise<FolderCandidate[]> {
    if (this.#folders != null && Date.now() < this.#expiresAt) return this.#folders
    if (this.#inflight != null) return this.#inflight
    this.#inflight = collectFolderCandidates(this.home, this.#extraRoots)
      .then((folders) => {
        this.#folders = folders
        this.#expiresAt = Date.now() + CACHE_TTL_MS
        return folders
      })
      .finally(() => {
        this.#inflight = null
      })
    return this.#inflight
  }
}

function addCandidate(found: Map<string, FolderCandidate>, path: string, home: string): void {
  if (found.has(path) || found.size >= MAX_FOLDERS) return
  found.set(path, {
    name: folderNameFromPath(path),
    path,
    displayPath: displayUserPath(path, home)
  })
}

type WalkChild = { path: string; repository: boolean }

async function walk(
  directory: string,
  depth: number,
  found: Map<string, FolderCandidate>,
  home: string
): Promise<void> {
  if (depth >= MAX_DEPTH || found.size >= MAX_FOLDERS) return
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const probes: Promise<WalkChild | null>[] = []
  for (const entry of entries) {
    if (!isWalkableEntry(entry)) continue
    probes.push(describeChild(join(directory, entry.name)))
  }
  // A directory of 40 children used to cost 80 serial syscalls before the first
  // candidate landed. The realpath and the `.git` probe are independent per
  // child, so the whole directory resolves in one round.
  const children = await Promise.all(probes)
  // Depth-first, in readdir order: a later sibling must not claim a cap slot
  // that a nested folder of an earlier sibling would have taken.
  await visitInOrder(children, async (child) => {
    if (found.size >= MAX_FOLDERS || child == null) return
    if (depth < 2 || child.repository) addCandidate(found, child.path, home)
    if (!child.repository) await walk(child.path, depth + 1, found, home)
  })
}

/**
 * Runs `visit` over `items` one at a time, in order. The folder cap makes the
 * order load-bearing — the first `MAX_FOLDERS` candidates are the ones kept — so
 * these walks must not overlap, and a promise chain puts that in the structure
 * rather than in a comment.
 */
function visitInOrder<Item>(
  items: readonly Item[],
  visit: (item: Item) => Promise<void>
): Promise<void> {
  return items.reduce<Promise<void>>(
    (previous, item) => previous.then(() => visit(item)),
    Promise.resolve()
  )
}

function isWalkableEntry(entry: Dirent): boolean {
  if (!entry.isDirectory() || entry.isSymbolicLink()) return false
  return !entry.name.startsWith('.') && !SKIPPED_DIRECTORY_NAMES.has(entry.name)
}

async function describeChild(child: string): Promise<WalkChild | null> {
  const path = await safeRealpath(child)
  if (path == null) return null
  return { path, repository: await isGitDirectory(path) }
}

async function isGitDirectory(directory: string): Promise<boolean> {
  return stat(join(directory, '.git')).then(() => true).catch(() => false)
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then((info) => info.isDirectory()).catch(() => false)
}

async function safeRealpath(path: string): Promise<string | null> {
  return realpath(path).catch(() => null)
}

function sameRoots(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((root, index) => root === right[index])
}
