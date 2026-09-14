import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'bun:test'

import { splitNullDelimited, type CommandResult } from './gitCommands.js'
import {
  EXCLUDED_DIRECTORIES,
  EXCLUDED_DIRECTORY_SET,
  EXCLUDED_IGNORED_EXTENSIONS,
  listIgnoredPaths,
  MAX_EXPANDED_IGNORED_DIRECTORIES,
  partitionIgnoredEntries,
  withIgnoredListingDeadline
} from './ignoredListing.js'
import { mergeVisiblePaths } from './repository.js'

const executeFile = promisify(execFile)

// The command this listing replaced: git walked every ignored directory in full
// and the pathspecs threw the result away afterwards.
const LEGACY_IGNORED_ARGS = [
  'ls-files',
  '--others',
  '--ignored',
  '--exclude-standard',
  '-z',
  '--',
  '.',
  ...EXCLUDED_DIRECTORIES.flatMap((directory) => [
    `:(exclude,glob)${directory}/**`,
    `:(exclude,glob)**/${directory}/**`
  ])
]

const gitEnvironment = (repositoryPath: string): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: join(repositoryPath, '.gitconfig-absent'),
  GIT_CONFIG_SYSTEM: join(repositoryPath, '.gitconfig-absent'),
  HOME: repositoryPath
})

function gitFor(repositoryPath: string) {
  return async (args: readonly string[], signal?: AbortSignal): Promise<CommandResult> => {
    const { stdout, stderr } = await executeFile('git', ['-C', repositoryPath, ...args], {
      encoding: 'buffer',
      env: gitEnvironment(repositoryPath),
      signal
    })
    return { stdout, stderr }
  }
}

const listingOptions = (root: string) => ({
  root,
  excludedDirectories: EXCLUDED_DIRECTORY_SET,
  excludedExtensions: EXCLUDED_IGNORED_EXTENSIONS,
  maxPaths: 20_000
})

async function buildFixture(repositoryPath: string): Promise<void> {
  const git = gitFor(repositoryPath)
  await git(['-c', 'init.defaultBranch=main', 'init', '--quiet'])
  await mkdir(join(repositoryPath, 'src'), { recursive: true })
  await mkdir(join(repositoryPath, 'ignored-data', 'deep'), { recursive: true })
  await mkdir(join(repositoryPath, 'ignored-data', 'node_modules'), { recursive: true })
  await mkdir(join(repositoryPath, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(repositoryPath, 'build'), { recursive: true })
  await writeFile(
    join(repositoryPath, '.gitignore'),
    '.env\nnode_modules/\nbuild/\nignored-data/\nvendor/\n*.pyc\n',
    'utf8'
  )
  await writeFile(join(repositoryPath, 'src', 'tracked.ts'), 'export const tracked = 1\n', 'utf8')
  await writeFile(join(repositoryPath, 'src', 'untracked.ts'), 'export const untracked = 1\n', 'utf8')
  await writeFile(join(repositoryPath, '.env'), 'SECRET=1\n', 'utf8')
  await writeFile(join(repositoryPath, 'ignored-data', 'one.txt'), 'one\n', 'utf8')
  await writeFile(join(repositoryPath, 'ignored-data', 'deep', 'two.txt'), 'two\n', 'utf8')
  await writeFile(join(repositoryPath, 'ignored-data', 'module.pyc'), 'bytecode\n', 'utf8')
  await writeFile(join(repositoryPath, 'ignored-data', 'node_modules', 'dep.js'), 'dep\n', 'utf8')
  await writeFile(join(repositoryPath, 'node_modules', 'pkg', 'index.js'), 'pkg\n', 'utf8')
  await writeFile(join(repositoryPath, 'build', 'bundle.js'), 'bundle\n', 'utf8')
  await git(['-c', 'init.defaultBranch=main', 'init', '--quiet', 'ignored-data/nested'])
  await writeFile(join(repositoryPath, 'ignored-data', 'nested', 'checked-in.txt'), 'nested\n', 'utf8')
  // An ignored directory that is itself a checkout, reported by git at the top
  // level of the `--directory` listing rather than one level down.
  await mkdir(join(repositoryPath, 'vendor', 'lib'), { recursive: true })
  await git(['-c', 'init.defaultBranch=main', 'init', '--quiet', 'vendor'])
  await writeFile(join(repositoryPath, 'vendor', 'lib', 'x.js'), 'export const x = 1\n', 'utf8')
  await git(['add', '.gitignore', 'src/tracked.ts'])
  await git([
    '-c', 'user.name=Kodi Test',
    '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'Initial commit'
  ])
}

describe('partitionIgnoredEntries', () => {
  const options = {
    excludedDirectories: EXCLUDED_DIRECTORY_SET,
    excludedExtensions: EXCLUDED_IGNORED_EXTENSIONS
  }

  it('keeps ignored files and the directories worth expanding', () => {
    expect(partitionIgnoredEntries(['.env', 'ignored-data/', 'node_modules/', 'apps/web/dist/'], options))
      .toEqual({ files: ['.env'], directories: ['ignored-data'] })
  })

  it('drops bytecode files reported directly by git', () => {
    expect(partitionIgnoredEntries(['keep.log', 'module.pyc', 'nested/module.PYO'], options).files)
      .toEqual(['keep.log'])
  })

  it('expands at most a bounded number of directories', () => {
    const entries = Array.from({ length: MAX_EXPANDED_IGNORED_DIRECTORIES + 5 }, (_unused, index) => `ignored${index}/`)
    expect(partitionIgnoredEntries([...entries, 'tail.log'], options)).toEqual({
      files: ['tail.log'],
      directories: entries.slice(0, MAX_EXPANDED_IGNORED_DIRECTORIES).map((entry) => entry.slice(0, -1))
    })
  })
})

describe('listIgnoredPaths', () => {
  it('matches the pathspec-filtered git walk it replaced', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-ignored-'))
    try {
      await buildFixture(repositoryPath)
      const git = gitFor(repositoryPath)

      const legacy = splitNullDelimited((await git(LEGACY_IGNORED_ARGS)).stdout)
      const listed = await listIgnoredPaths(git, listingOptions(repositoryPath))

      const tracked = Buffer.from('.gitignore\0src/tracked.ts\0')
      const untracked = ['src/untracked.ts']
      expect(mergeVisiblePaths(tracked, untracked, listed))
        .toEqual(mergeVisiblePaths(tracked, untracked, legacy))
      expect(mergeVisiblePaths(tracked, untracked, listed)).toEqual([
        '.env',
        '.gitignore',
        'ignored-data/deep/two.txt',
        'ignored-data/nested/',
        'ignored-data/one.txt',
        'src/tracked.ts',
        'src/untracked.ts',
        'vendor/'
      ])
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('stops at a nested repository and skips excluded directories and bytecode', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-ignored-shape-'))
    try {
      await buildFixture(repositoryPath)
      const listed = await listIgnoredPaths(gitFor(repositoryPath), listingOptions(repositoryPath))

      expect(listed).toEqual([
        '.env',
        'ignored-data/deep/two.txt',
        'ignored-data/nested/',
        'ignored-data/one.txt',
        'vendor/'
      ])
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('reports an ignored directory that is its own repository without descending into it', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-ignored-root-repo-'))
    try {
      await buildFixture(repositoryPath)
      const listed = await listIgnoredPaths(gitFor(repositoryPath), listingOptions(repositoryPath))

      expect(listed).toContain('vendor/')
      expect(listed).not.toContain('vendor/lib/x.js')
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('truncates at the path cap instead of walking the whole tree', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-ignored-cap-'))
    try {
      await buildFixture(repositoryPath)
      const listed = await listIgnoredPaths(gitFor(repositoryPath), {
        ...listingOptions(repositoryPath),
        maxPaths: 2
      })

      expect(listed).toHaveLength(2)
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('rejects once the listing is aborted', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-ignored-abort-'))
    try {
      await buildFixture(repositoryPath)
      const abort = new AbortController()
      abort.abort()

      await expect(listIgnoredPaths(gitFor(repositoryPath), {
        ...listingOptions(repositoryPath),
        signal: abort.signal
      })).rejects.toThrow()
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })
})

describe('withIgnoredListingDeadline', () => {
  const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => { setTimeout(resolveDelay, ms) })
  const run = { id: 'run' }

  it('hands the paths back when the listing beats the deadline', async () => {
    const late: string[][] = []
    const paths = await withIgnoredListingDeadline(Promise.resolve(['.env']), 50, run, (value) => late.push(value))

    expect(paths).toEqual(['.env'])
    await delay(10)
    expect(late).toEqual([])
  })

  it('yields the critical path and merges a slow listing afterwards', async () => {
    const late: string[][] = []
    const listing = delay(30).then(() => ['.env', 'ignored-data/one.txt'])

    expect(await withIgnoredListingDeadline(listing, 5, run, (value) => late.push(value))).toBeNull()

    await listing
    await delay(0)
    expect(late).toEqual([['.env', 'ignored-data/one.txt']])
  })

  it('names the run that produced the late set so a superseded one can be dropped', async () => {
    const late: { paths: string[]; run: { id: string } }[] = []
    const superseded = { id: 'superseded' }
    const listing = delay(20).then(() => ['.env'])

    expect(await withIgnoredListingDeadline(listing, 1, superseded, (paths, source) => {
      late.push({ paths, run: source })
    })).toBeNull()

    await listing
    await delay(0)
    expect(late).toEqual([{ paths: ['.env'], run: superseded }])
    expect(late[0]?.run).toBe(superseded)
  })

  it('keeps the last known set when the listing fails', async () => {
    const late: string[][] = []
    const listing = delay(5).then<string[]>(() => { throw new Error('cancelled') })

    expect(await withIgnoredListingDeadline(listing, 1, run, (value) => late.push(value))).toBeNull()

    await delay(15)
    expect(late).toEqual([])
  })

  it('drops a phase-1 spawn that never answers before the deadline', async () => {
    const late: string[][] = []
    const slowGit = async (args: readonly string[]): Promise<CommandResult> => {
      await delay(30)
      return { stdout: Buffer.from(args.join(' ').length === 0 ? '' : '.env\0'), stderr: Buffer.alloc(0) }
    }
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-ignored-slow-'))
    try {
      const listing = listIgnoredPaths(slowGit, listingOptions(repositoryPath))

      expect(await withIgnoredListingDeadline(listing, 5, run, (value) => late.push(value))).toBeNull()

      await listing
      await delay(0)
      expect(late).toEqual([['.env']])
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })
})
