import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { comparePaths, splitNullDelimited, type CommandResult } from './gitCommands.js'

// Generated trees that git tracks as ignored but that nobody reviews. Kept here
// rather than in the repository service because both the ignored listing and the
// ripgrep exclusions have to agree on the same set.
export const EXCLUDED_DIRECTORIES = [
  '.cache',
  '.eggs',
  '.horus',
  '.kodi',
  '.mypy_cache',
  '.next',
  '.nox',
  '.nuxt',
  '.output',
  '.parcel-cache',
  '.pytest_cache',
  '.ruff_cache',
  '.svelte-kit',
  '.tox',
  '.turbo',
  '.vercel',
  '.venv',
  '.vite',
  'DerivedData',
  '__pycache__',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'site-packages',
  'target',
  'venv'
] as const
export const EXCLUDED_DIRECTORY_SET = new Set<string>(EXCLUDED_DIRECTORIES)
export const EXCLUDED_IGNORED_EXTENSIONS = new Set(['.pyc', '.pyd', '.pyo'])

/**
 * `ls-files --others --ignored` with exclusion pathspecs walks every ignored
 * directory in full and only then drops it: 3.3-3.8 s on a repository with 369k
 * gitignored files, to return 405 paths, on every refresh. Asking git for the
 * collapsed directory list instead costs 30-40 ms, and everything below an
 * ignored directory is ignored by definition, so the few surviving directories
 * can be expanded with plain readdir — no gitignore evaluation needed. Measured
 * byte-identical output on four repositories at 20-79 ms total.
 */
export const IGNORED_DIRECTORY_LISTING_ARGS = [
  'ls-files',
  '--others',
  '--ignored',
  '--exclude-standard',
  '--directory',
  '--no-empty-directory',
  '-z'
] as const

// A repository that ignores hundreds of sibling directories is telling us the
// tree is generated; expanding all of them would put the old walk back.
export const MAX_EXPANDED_IGNORED_DIRECTORIES = 32
const MAX_IGNORED_WALK_DEPTH = 12

export interface IgnoredListingOptions {
  root: string
  excludedDirectories: ReadonlySet<string>
  excludedExtensions: ReadonlySet<string>
  maxPaths: number
  signal?: AbortSignal
}

export interface PartitionedIgnoredEntries {
  files: string[]
  directories: string[]
}

function hasExcludedExtension(name: string, excludedExtensions: ReadonlySet<string>): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && excludedExtensions.has(name.slice(dot).toLowerCase())
}

/**
 * Splits the `--directory` listing into the files git reported directly and the
 * ignored directories whose contents still have to be enumerated.
 */
export function partitionIgnoredEntries(
  entries: readonly string[],
  options: Pick<IgnoredListingOptions, 'excludedDirectories' | 'excludedExtensions'>
): PartitionedIgnoredEntries {
  const files: string[] = []
  const directories: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith('/')) {
      if (!hasExcludedExtension(entry, options.excludedExtensions)) files.push(entry)
      continue
    }
    const directory = entry.slice(0, -1)
    if (directory === '') continue
    if (directory.split('/').some((segment) => options.excludedDirectories.has(segment))) continue
    if (directories.length >= MAX_EXPANDED_IGNORED_DIRECTORIES) continue
    directories.push(directory)
  }
  return { files, directories }
}

async function walkIgnoredDirectory(
  relativePath: string,
  depth: number,
  options: IgnoredListingOptions,
  collected: string[]
): Promise<void> {
  if (collected.length >= options.maxPaths || depth > MAX_IGNORED_WALK_DEPTH) return
  options.signal?.throwIfAborted()
  let entries
  try {
    entries = await readdir(join(options.root, relativePath), { withFileTypes: true })
  } catch {
    // An unreadable directory contributes nothing, exactly as it does to git.
    return
  }
  // `git ls-files --others` stops at a nested repository boundary and reports the
  // directory itself, so a directory holding its own `.git` is never walked into.
  // This holds at depth 0 too: git's `--directory` listing can name an ignored
  // directory that is itself a checkout (`vendor/`), and expanding it would print
  // paths the command being replaced never printed.
  if (entries.some((entry) => entry.name === '.git')) {
    collected.push(`${relativePath}/`)
    return
  }
  for (const entry of entries) {
    if (collected.length >= options.maxPaths) return
    if (entry.isDirectory()) {
      if (entry.name === '.git' || options.excludedDirectories.has(entry.name)) continue
      await walkIgnoredDirectory(`${relativePath}/${entry.name}`, depth + 1, options, collected)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (hasExcludedExtension(entry.name, options.excludedExtensions)) continue
    collected.push(`${relativePath}/${entry.name}`)
  }
}

export type IgnoredListingGit = (args: readonly string[], signal?: AbortSignal) => Promise<CommandResult>

/** Two-phase gitignored listing: collapsed directories from git, contents from readdir. */
export async function listIgnoredPaths(
  git: IgnoredListingGit,
  options: IgnoredListingOptions
): Promise<string[]> {
  const listing = await git(IGNORED_DIRECTORY_LISTING_ARGS, options.signal)
  options.signal?.throwIfAborted()
  const { files, directories } = partitionIgnoredEntries(splitNullDelimited(listing.stdout), options)
  const collected = files.slice(0, options.maxPaths)
  for (const directory of directories) {
    if (collected.length >= options.maxPaths) break
    await walkIgnoredDirectory(directory, 0, options, collected)
  }
  // Sorted so an unchanged tree hands the snapshot cache an element-wise equal
  // list whatever order the filesystem enumerated it in.
  return collected.sort(comparePaths)
}

/**
 * Resolves with the listing only while it is still on the critical path. Once
 * `deadlineMs` passes the caller gets `null` and publishes without the ignored
 * set; the listing keeps running and is handed to `onLate` when it lands. A
 * failed or cancelled listing resolves `null` and never calls `onLate`, so the
 * caller falls back to the last set it had. `run` identifies the listing to
 * `onLate`: cancellation is cooperative, so a superseded run can still resolve,
 * and only the caller knows whether its answer is still wanted.
 */
export function withIgnoredListingDeadline<Run>(
  listing: Promise<string[]>,
  deadlineMs: number,
  run: Run,
  onLate: (paths: string[], run: Run) => void
): Promise<string[] | null> {
  let missedDeadline = false
  const settled = listing.then(
    (paths) => {
      if (missedDeadline) onLate(paths, run)
      return paths
    },
    () => null
  )
  const deadline = new Promise<null>((resolveDeadline) => {
    const timer = setTimeout(() => {
      missedDeadline = true
      resolveDeadline(null)
    }, deadlineMs)
    timer.unref?.()
    void settled.finally(() => clearTimeout(timer))
  })
  return Promise.race([settled, deadline])
}
