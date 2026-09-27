import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'bun:test'

import type {
  LocalReviewProgress,
  PullRequestFile,
  PullRequestReview,
  PullRequestReviewProgress
} from '../shared/contracts.js'
import { agentReviewPaths } from './agentReviewBundle.js'
import {
  cachedPullRequestPages,
  filesFromPatch,
  PullRequestReviewCache,
  RepositoryService
} from './repository.js'

const executeFile = promisify(execFile)

async function runGit(repositoryPath: string, ...args: string[]): Promise<void> {
  await executeFile('git', ['-C', repositoryPath, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      HOME: repositoryPath
    }
  })
}

async function commitAll(repositoryPath: string, message: string): Promise<void> {
  await runGit(repositoryPath, 'add', '--all')
  await runGit(
    repositoryPath,
    '-c', 'user.name=Kodi Test',
    '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', message
  )
}

function section(path: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`
}

function fileEntry(path: string): PullRequestFile {
  return { path, additions: 1, deletions: 1 }
}

const paths = Array.from({ length: 60 }, (_, index) => `src/file-${String(index).padStart(2, '0')}.ts`)
// Listed but never diffed, as a file too large for the patch is.
const omittedPath = 'src/file-30-huge.ts'
const listedFiles = [
  ...paths.slice(0, 31).map(fileEntry),
  fileEntry(omittedPath),
  ...paths.slice(31).map(fileEntry)
]
const largePatch = paths.map(section).join('')

describe('cachedPullRequestPages', () => {
  it('pages a cached review the way a fresh download streams it', () => {
    const pages = cachedPullRequestPages({
      patch: largePatch,
      files: listedFiles,
      omittedFiles: [{ path: omittedPath, reason: 'too-large', additions: 9, deletions: 0 }]
    })

    expect(pages.map((page) => filesFromPatch(page.patch).length)).toEqual([25, 25, 10])
    expect(pages.map((page) => page.patch).join('')).toBe(largePatch)
    expect(pages.flatMap((page) => page.files)).toEqual(listedFiles)
    for (const page of pages) {
      const inPatch = filesFromPatch(page.patch).map((file) => file.path)
      expect(page.files.map((file) => file.path).filter((path) => path !== omittedPath)).toEqual(inPatch)
    }
    // The listed-only file travels with the section before it.
    expect(pages[1]!.files.map((file) => file.path)).toContain(omittedPath)
    expect(pages.map((page) => page.omittedFiles.length)).toEqual([1, 0, 0])
  })

  it('keeps a small review as one page and still delivers a file list with no patch', () => {
    const files = [fileEntry('a.ts')]
    expect(cachedPullRequestPages({ patch: section('a.ts'), files, omittedFiles: [] }))
      .toEqual([{ patch: section('a.ts'), files, omittedFiles: [] }])
    expect(cachedPullRequestPages({ patch: '', files, omittedFiles: [] }))
      .toEqual([{ patch: '', files, omittedFiles: [] }])
  })

  it('hands the files of a page it cannot match to the page before it', () => {
    const files = listedFiles.filter((file) => file.path !== paths[25])
    const pages = cachedPullRequestPages({ patch: largePatch, files, omittedFiles: [] })
    expect(pages.flatMap((page) => page.files)).toEqual(files)
    expect(pages[1]!.files).toEqual([])
  })
})

describe('RepositoryService review paging', () => {
  const url = 'https://github.com/acme/app/pull/9'
  const review = (): PullRequestReview => ({
    kind: 'github',
    selector: url,
    baseOid: 'base-oid-9',
    headOid: 'oid-9',
    commitId: 'oid-9',
    viewerCanSubmitDecision: true,
    pullRequest: {
      number: 9,
      title: 'Touch sixty files',
      url,
      state: 'open',
      isDraft: false,
      author: { login: 'author' },
      headRefName: 'feature',
      baseRefName: 'main',
      reviewDecision: null,
      updatedAt: '2026-09-25T00:00:00Z',
      additions: 60,
      deletions: 60,
      changedFiles: listedFiles.length
    },
    files: listedFiles,
    patch: largePatch,
    omittedFiles: [],
    expectedFileCount: listedFiles.length
  })

  it('streams a cached reopen in pages and forgets remembered reviews on dispose', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-pr-paged-'))
    const repository = new RepositoryService()
    try {
      await runGit(repositoryPath, '-c', 'init.defaultBranch=main', 'init', '--quiet')
      await writeFile(join(repositoryPath, 'value.ts'), 'export const value = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      const cacheDirectory = join(repositoryPath, 'pr-cache')
      await new PullRequestReviewCache(cacheDirectory).write(url, 'oid-9', review())
      await repository.open(repositoryPath)
      repository.setPullRequestCacheDirectory(cacheDirectory)

      const events: PullRequestReviewProgress[] = []
      const promise = repository.getPullRequestReview(url, (progress) => events.push(progress), 'req-9')
      repository.cancelPullRequestReview('req-9')
      const reply = await promise

      const pages = events.flatMap((event) => event.kind === 'files' ? [event] : [])
      expect(events[0]?.kind).toBe('metadata')
      expect(events.at(-1)?.kind).toBe('done')
      expect(pages).toHaveLength(3)
      expect(pages.map((page) => page.patch).join('')).toBe(largePatch)
      expect(pages.flatMap((page) => page.files)).toEqual(listedFiles)
      expect(reply.patch).toBe('')

      expect(repository.getRememberedReviewStatsForTests()).toEqual({ entries: 1, bytes: largePatch.length })
      repository.dispose()
      expect(repository.getRememberedReviewStatsForTests()).toEqual({ entries: 0, bytes: 0 })
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('builds a local review from its pages without re-reading the joined patch', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-local-paged-'))
    const repository = new RepositoryService()
    try {
      await runGit(repositoryPath, '-c', 'init.defaultBranch=main', 'init', '--quiet')
      await writeFile(join(repositoryPath, 'a.txt'), 'base-a\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.txt'), 'base-b\n', 'utf8')
      await commitAll(repositoryPath, 'Base')
      await runGit(repositoryPath, 'switch', '--quiet', '-c', 'feature')
      await writeFile(join(repositoryPath, 'a.txt'), 'base-a\nfeature-a\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.txt'), 'base-b\nfeature-b\n', 'utf8')
      await commitAll(repositoryPath, 'Feature')
      await repository.open(repositoryPath)

      const progress: LocalReviewProgress[] = []
      const streamed = await repository.getLocalBranchReview('main', 'feature', (event) => progress.push(event))
      const streamedFiles = progress.flatMap((event) => {
        if (event.kind === 'metadata') return event.review.files
        return event.kind === 'files' ? event.files : []
      })
      const streamedPatch = progress.flatMap((event) => {
        if (event.kind === 'metadata') return [event.review.patch]
        return event.kind === 'files' ? [event.patch] : []
      }).filter((patch) => patch !== '').join('\n')

      expect(streamed.patch).toBe('')
      // The reply's files are the pages' files. Re-reading the joined patch gave
      // each page's last file the hash of its section plus the join's newline.
      expect(streamed.files).toEqual(streamedFiles)

      const whole = await repository.getLocalBranchReview('main', 'feature')
      expect(whole.patch).toBe(streamedPatch)
      expect(whole.files).toEqual(streamed.files)

      // The streamed review was still remembered with its patch for an agent.
      const context = await repository.prepareAgentReview({
        tabId: 'local',
        repositoryRoot: repositoryPath,
        repositoryName: 'repo',
        source: 'since',
        baseOid: streamed.baseOid,
        headOid: streamed.headOid
      })
      const bundle = agentReviewPaths(repository.getSessionSnapshot()!.root)
      expect(context).toContain(bundle.patch)
      expect(await readFile(bundle.patch, 'utf8')).toBe(streamedPatch)
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })
})
