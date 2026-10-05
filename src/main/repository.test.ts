import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it, spyOn } from 'bun:test'

import type { PullRequestReview, PullRequestReviewProgress } from '../shared/contracts.js'
import { COMMAND_ABORTED_MESSAGE, commandSemaphore, MAX_BACKGROUND_COMMANDS } from './gitCommands.js'

import {
  buildPullRequestPatchFromFiles,
  chunkPatchByFileCount,
  chunkPathspecs,
  classifySearchCompletion,
  contentSearchOpenPath,
  createNewFilePatch,
  createPullRequestReviewPayload,
  diffFilesFromChurn,
  filesFromPatch,
  GitObjectReader,
  githubRepoSlugFromRemoteUrl,
  readGitObject,
  isPathWithinApprovedRoots,
  isolateFirstPathspec,
  isolateFirstPathspecGroup,
  pathspecGroupForFile,
  chunkPathspecGroups,
  isPullRequestDiffTooLargeError,
  isSameGitHubLogin,
  limitPatchFileSize,
  mapGitStatus,
  mergeContentSearchResults,
  normalizePullRequestSelector,
  parseNumstat,
  mergeVisiblePaths,
  parsePullRequestInboxResponse,
  parsePorcelainV2Status,
  parsePullRequestConversation,
  PullRequestReviewCache,
  pullRequestInboxVariables,
  pullRequestReviewLane,
  pullRequestReviewReply,
  pullRequestSnapshotIdentity,
  pullRequestFilePageWave,
  pullRequestTargetsRemotes,
  replaceStatusEntry,
  RepositoryService,
  resolvePackagedExecutablePath,
  runGitHubReadCommand,
  sectionPullRequestInbox,
  selectOversizedDiffFiles,
  summarizeCheckRollup
} from './repository.js'

const inboxPullRequest = (number: number): Record<string, unknown> => ({
  number,
  title: `Pull request ${number}`,
  url: `https://github.com/acme/app/pull/${number}`,
  state: 'open',
  isDraft: false,
  author: { login: 'reviewer' },
  updatedAt: '2026-08-17T00:00:00Z'
})

describe('sectionPullRequestInbox', () => {
  it('returns every section in precedence order', () => {
    const sections = sectionPullRequestInbox([])
    expect(sections.map((section) => section.key))
      .toEqual(['review-requested', 'assigned', 'mentioned', 'authored'])
    expect(sections.every((section) => section.pullRequests.length === 0)).toBe(true)
  })

  it('keeps a pull request only in its highest-precedence section', () => {
    const sections = sectionPullRequestInbox([
      { key: 'authored', pullRequest: inboxPullRequest(7) },
      { key: 'review-requested', pullRequest: inboxPullRequest(7) },
      { key: 'assigned', pullRequest: inboxPullRequest(7) },
      { key: 'assigned', pullRequest: inboxPullRequest(9) }
    ])
    expect(sections.find((section) => section.key === 'review-requested')?.pullRequests.map((entry) => entry.number)).toEqual([7])
    expect(sections.find((section) => section.key === 'assigned')?.pullRequests.map((entry) => entry.number)).toEqual([9])
    expect(sections.find((section) => section.key === 'authored')?.pullRequests).toEqual([])
  })

  it('drops malformed entries instead of failing', () => {
    const sections = sectionPullRequestInbox([
      { key: 'assigned', pullRequest: null },
      { key: 'assigned', pullRequest: { number: 'not-a-number' } },
      { key: 'assigned', pullRequest: { ...inboxPullRequest(3), url: 'https://evil.example/pull/3' } },
      { key: 'assigned', pullRequest: { ...inboxPullRequest(4), author: {} } },
      { key: 'assigned', pullRequest: inboxPullRequest(5) }
    ])
    expect(sections.find((section) => section.key === 'assigned')?.pullRequests.map((entry) => entry.number)).toEqual([5])
  })
})

describe('isSameGitHubLogin', () => {
  it('compares GitHub logins without case sensitivity', () => {
    expect(isSameGitHubLogin('PierreComputer', 'pierrecomputer')).toBe(true)
    expect(isSameGitHubLogin('reviewer', 'author')).toBe(false)
  })
})

describe('resolvePackagedExecutablePath', () => {
  it('moves packaged executables outside the asar archive', () => {
    expect(resolvePackagedExecutablePath('/Applications/App.app/Contents/Resources/app.asar/node_modules/rg'))
      .toBe('/Applications/App.app/Contents/Resources/app.asar.unpacked/node_modules/rg')
    expect(resolvePackagedExecutablePath('/workspace/node_modules/rg')).toBe('/workspace/node_modules/rg')
  })
})

const executeFile = promisify(execFile)

// Without this every git test reads the developer's global configuration, so a
// machine with commit signing, a hooks path, a global excludes file or an unusual
// init.defaultBranch produces different results from CI for reasons unrelated to
// the change under test.
function gitEnvironment(repositoryPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    HOME: repositoryPath
  }
}

async function runGit(repositoryPath: string, ...args: string[]): Promise<void> {
  await executeFile('git', ['-C', repositoryPath, ...args], { env: gitEnvironment(repositoryPath) })
}

async function initRepository(repositoryPath: string): Promise<void> {
  await runGit(repositoryPath, '-c', 'init.defaultBranch=main', 'init', '--quiet')
}

async function commitAll(repositoryPath: string, message: string): Promise<void> {
  await runGit(repositoryPath, 'add', '--all')
  await commitIndex(repositoryPath, message)
}

async function commitIndex(repositoryPath: string, message: string): Promise<void> {
  await runGit(
    repositoryPath,
    '-c', 'user.name=Kodi Test',
    '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', message
  )
}

async function runGitAllowingDifferences(repositoryPath: string, ...args: string[]): Promise<string> {
  try {
    return (await executeFile('git', ['-C', repositoryPath, ...args], { env: gitEnvironment(repositoryPath) })).stdout
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? ''
  }
}

describe('mapGitStatus', () => {
  it('maps index and working tree states to explorer states', () => {
    expect(mapGitStatus('?', '?')).toBe('untracked')
    expect(mapGitStatus('R', ' ')).toBe('renamed')
    expect(mapGitStatus(' ', 'D')).toBe('deleted')
    expect(mapGitStatus('M', 'M')).toBe('modified')
  })

  it('maps unmerged combinations to conflicted', () => {
    expect(mapGitStatus('U', 'U')).toBe('conflicted')
    expect(mapGitStatus('A', 'A')).toBe('conflicted')
    expect(mapGitStatus('D', 'D')).toBe('conflicted')
    expect(mapGitStatus('A', 'U')).toBe('conflicted')
    expect(mapGitStatus('U', 'D')).toBe('conflicted')
    expect(mapGitStatus('U', 'A')).toBe('conflicted')
    expect(mapGitStatus('D', 'U')).toBe('conflicted')
  })

  it('keeps staged combinations that only look unmerged', () => {
    expect(mapGitStatus('A', 'M')).toBe('added')
    expect(mapGitStatus('M', 'D')).toBe('deleted')
    expect(mapGitStatus('A', ' ')).toBe('added')
    expect(mapGitStatus('D', ' ')).toBe('deleted')
    expect(mapGitStatus('R', 'M')).toBe('renamed')
  })
})

describe('parsePorcelainV2Status', () => {
  it('reads the branch, head, statuses, and untracked set from one call', () => {
    const output = Buffer.from([
      '# branch.oid 1a2b3c4d5e6f',
      '# branch.head main',
      '# branch.ab +1 -0',
      '1 .M N... 100644 100644 100644 aaa bbb src/value.ts',
      '1 A. N... 000000 100644 100644 000 ccc src/added.ts',
      '1 .D N... 100644 100644 000000 ddd ddd src/gone.ts',
      '? notes.txt'
    ].join('\0') + '\0')

    const status = parsePorcelainV2Status(output)
    expect(status.branch).toBe('main')
    expect(status.head).toBe('1a2b3c4d5e6f')
    expect(status.untrackedPaths).toEqual(['notes.txt'])
    expect(status.statuses).toEqual([
      { path: 'src/value.ts', status: 'modified' },
      { path: 'src/added.ts', status: 'added', staged: 'all' },
      { path: 'src/gone.ts', status: 'deleted' },
      { path: 'notes.txt', status: 'untracked' }
    ])
  })

  it('pairs a rename with the original path that follows it', () => {
    const output = Buffer.from([
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts',
      'src/old.ts',
      '1 .M N... 100644 100644 100644 ccc ddd src/after.ts'
    ].join('\0') + '\0')

    expect(parsePorcelainV2Status(output).statuses).toEqual([
      { path: 'src/new.ts', previousPath: 'src/old.ts', status: 'renamed', staged: 'all' },
      { path: 'src/after.ts', status: 'modified' }
    ])
  })

  it('reports unmerged records as conflicted', () => {
    const output = Buffer.from([
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/both.ts',
      'u AA N... 100644 100644 100644 100644 aaa bbb ccc src/added.ts'
    ].join('\0') + '\0')

    expect(parsePorcelainV2Status(output).statuses).toEqual([
      { path: 'src/both.ts', status: 'conflicted' },
      { path: 'src/added.ts', status: 'conflicted' }
    ])
  })

  it('tells a fully staged change from one with further edits', () => {
    const output = Buffer.from([
      '1 M. N... 100644 100644 100644 aaa bbb src/staged.ts',
      '1 MM N... 100644 100644 100644 aaa bbb src/partial.ts',
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/both.ts'
    ].join('\0') + '\0')

    expect(parsePorcelainV2Status(output).statuses).toEqual([
      { path: 'src/staged.ts', status: 'modified', staged: 'all' },
      { path: 'src/partial.ts', status: 'modified', staged: 'partial' },
      { path: 'src/both.ts', status: 'conflicted' }
    ])
  })

  it('keeps paths that contain spaces intact', () => {
    const output = Buffer.from('1 .M N... 100644 100644 100644 aaa bbb src/my file.ts\0')
    expect(parsePorcelainV2Status(output).statuses).toEqual([
      { path: 'src/my file.ts', status: 'modified' }
    ])
  })

  it('reports a detached head and an empty repository as having no branch or oid', () => {
    const detached = parsePorcelainV2Status(Buffer.from('# branch.oid abc\0# branch.head (detached)\0'))
    expect(detached.branch).toBeNull()
    expect(detached.head).toBe('abc')

    const initial = parsePorcelainV2Status(Buffer.from('# branch.oid (initial)\0# branch.head main\0'))
    expect(initial.head).toBeNull()
    expect(initial.branch).toBe('main')
  })
})

describe('mergeVisiblePaths', () => {
  it('merges tracked and untracked paths without duplicates, sorted', () => {
    const tracked = Buffer.from('src/b.ts\0src/a.ts\0')
    expect(mergeVisiblePaths(tracked, ['notes.txt', 'src/a.ts'])).toEqual([
      'notes.txt', 'src/a.ts', 'src/b.ts'
    ])
  })

  it('drops excluded untracked paths but keeps tracked build output', () => {
    const tracked = Buffer.from('src/a.ts\0dist/app.js\0')
    expect(mergeVisiblePaths(tracked, ['node_modules/other/x.js', 'keep.txt'])).toEqual([
      'dist/app.js', 'keep.txt', 'src/a.ts'
    ])
  })

  it('keeps a file whose own name matches an excluded directory', () => {
    expect(mergeVisiblePaths(Buffer.alloc(0), ['dist', 'src/out'])).toEqual(['dist', 'src/out'])
  })

  it('merges gitignored files and drops ignored generated directories', () => {
    expect(mergeVisiblePaths(Buffer.from('src/a.ts\0'), ['notes.txt'], [
      '.env',
      'node_modules/pkg/index.js',
      'apps/web/node_modules',
      'src/.env.local'
    ])).toEqual(['.env', 'notes.txt', 'src/.env.local', 'src/a.ts'])
  })

  it('drops ignored virtualenvs, bytecode caches, and .pyc files', () => {
    expect(mergeVisiblePaths(Buffer.from('src/a.ts\0'), [], [
      '.env',
      '.venv/lib/python3.12/site-packages/requests/api.py',
      'apps/api/__pycache__/verify.cpython-312.pyc',
      'src/verify.pyc',
      'venv/bin/activate'
    ])).toEqual(['.env', 'src/a.ts'])
  })
})

describe('githubRepoSlugFromRemoteUrl', () => {
  it('extracts the slug from every GitHub remote form', () => {
    expect(githubRepoSlugFromRemoteUrl('https://github.com/pierre/kodi')).toBe('pierre/kodi')
    expect(githubRepoSlugFromRemoteUrl('https://github.com/pierre/kodi.git')).toBe('pierre/kodi')
    expect(githubRepoSlugFromRemoteUrl('git@github.com:pierre/kodi.git')).toBe('pierre/kodi')
    expect(githubRepoSlugFromRemoteUrl('ssh://git@github.com/pierre/kodi.git')).toBe('pierre/kodi')
  })

  it('lowercases the slug and ignores surrounding space and trailing slashes', () => {
    expect(githubRepoSlugFromRemoteUrl('  https://github.com/Pierre/Kodi/  ')).toBe('pierre/kodi')
  })

  it('returns null for remotes that are not GitHub repositories', () => {
    expect(githubRepoSlugFromRemoteUrl('https://gitlab.com/pierre/kodi.git')).toBeNull()
    expect(githubRepoSlugFromRemoteUrl('git@github.example.com:pierre/kodi.git')).toBeNull()
    expect(githubRepoSlugFromRemoteUrl('https://github.com/pierre')).toBeNull()
    expect(githubRepoSlugFromRemoteUrl('')).toBeNull()
  })
})

describe('pullRequestTargetsRemotes', () => {
  const remotes = [
    { name: 'origin', fetchUrl: 'git@github.com:Pierre/Kodi.git', pushUrl: 'git@github.com:Pierre/Kodi.git' },
    { name: 'fork', fetchUrl: 'https://github.com/contributor/kodi.git', pushUrl: '' }
  ]

  it('accepts a pull request hosted by one of the remotes', () => {
    expect(pullRequestTargetsRemotes(remotes, 'https://github.com/pierre/kodi/pull/12')).toBe(true)
    expect(pullRequestTargetsRemotes(remotes, 'https://github.com/Contributor/Kodi/pull/12/files')).toBe(true)
  })

  it('rejects a pull request from another repository', () => {
    expect(pullRequestTargetsRemotes(remotes, 'https://github.com/attacker/kodi/pull/12')).toBe(false)
    expect(pullRequestTargetsRemotes(remotes, 'https://github.com/pierre/other-repository/pull/12')).toBe(false)
    expect(pullRequestTargetsRemotes([], 'https://github.com/pierre/kodi/pull/12')).toBe(false)
  })

  it('rejects non-GitHub remotes and malformed pull request URLs', () => {
    const otherHost = [{ name: 'origin', fetchUrl: 'git@gitlab.com:pierre/kodi.git', pushUrl: '' }]

    expect(pullRequestTargetsRemotes(otherHost, 'https://github.com/pierre/kodi/pull/12')).toBe(false)
    expect(pullRequestTargetsRemotes(remotes, 'https://github.com/pierre/kodi/issues/12')).toBe(false)
  })
})

describe('normalizePullRequestSelector', () => {
  it('accepts a selector that was normalized while opening the review', () => {
    const storedSelector = normalizePullRequestSelector(123)

    expect(storedSelector).toBe('123')
    expect(normalizePullRequestSelector(storedSelector)).toBe('123')
  })

  it('normalizes hash-prefixed PR numbers', () => {
    expect(normalizePullRequestSelector(' #123 ')).toBe('123')
  })

  it('canonicalizes a copied GitHub URL before passing it to gh', () => {
    expect(normalizePullRequestSelector(
      'https://github.com/pierrecomputer/pierre/pull/123/files?notification_referrer_id=abc#discussion_r1'
    )).toBe('https://github.com/pierrecomputer/pierre/pull/123')
  })

  it('rejects invalid numeric selectors', () => {
    expect(() => normalizePullRequestSelector('0')).toThrow('positive integer')
  })
})

describe('createPullRequestReviewPayload', () => {
  it('creates a GitHub review with an inline range comment', () => {
    expect(createPullRequestReviewPayload('0123456789abcdef0123456789abcdef01234567', 'request-changes', 'Please update this.', [{
      path: 'src/value.ts',
      body: 'This range needs a guard.',
      line: 14,
      side: 'RIGHT',
      startLine: 11,
      startSide: 'RIGHT'
    }])).toEqual({
      commitOID: '0123456789abcdef0123456789abcdef01234567',
      event: 'REQUEST_CHANGES',
      body: 'Please update this.',
      threads: [{
        path: 'src/value.ts',
        body: 'This range needs a guard.',
        line: 14,
        side: 'RIGHT',
        startLine: 11,
        startSide: 'RIGHT'
      }]
    })
  })

  it('allows requested changes without a summary when an inline comment exists', () => {
    expect(createPullRequestReviewPayload('0123456789abcdef0123456789abcdef01234567', 'request-changes', '', [{
      path: 'src/value.ts',
      body: 'Please guard this branch.',
      line: 14,
      side: 'RIGHT'
    }])).toEqual({
      commitOID: '0123456789abcdef0123456789abcdef01234567',
      event: 'REQUEST_CHANGES',
      threads: [{
        path: 'src/value.ts',
        body: 'Please guard this branch.',
        line: 14,
        side: 'RIGHT'
      }]
    })
  })

  it('rejects an empty requested-changes review', () => {
    expect(() => createPullRequestReviewPayload(
      '0123456789abcdef0123456789abcdef01234567',
      'request-changes',
      '',
      []
    )).toThrow('summary or at least one inline comment')
  })

  it('rejects unsafe inline paths', () => {
    expect(() => createPullRequestReviewPayload('0123456789abcdef0123456789abcdef01234567', 'approve', '', [{
      path: '../secret.txt',
      body: 'Do not expose this.',
      line: 1,
      side: 'RIGHT'
    }])).toThrow('invalid path')
  })
})

describe('parseNumstat', () => {
  it('parses churn, rename origins, and binary markers', () => {
    const output = Buffer.from(
      '-\t-\tassets/logo.png\x0012\t3\tsrc/value.ts\x004\t0\t\x00src/old.ts\x00src/new.ts\x00'
    )

    expect(parseNumstat(output)).toEqual([
      { path: 'assets/logo.png', additions: 0, deletions: 0, binary: true },
      { path: 'src/value.ts', additions: 12, deletions: 3, binary: false },
      { path: 'src/new.ts', previousPath: 'src/old.ts', additions: 4, deletions: 0, binary: false }
    ])
  })
})

describe('selectOversizedDiffFiles', () => {
  it('omits high-churn files and excludes them from the diff command', () => {
    const selection = selectOversizedDiffFiles([
      { path: 'bun.lock', additions: 40_000, deletions: 30_000, binary: false },
      { path: 'src/value.ts', additions: 20, deletions: 4, binary: false },
      { path: 'assets/logo.png', additions: 0, deletions: 0, binary: true },
      { path: 'src/new.ts', previousPath: 'src/old.ts', additions: 30_000, deletions: 0, binary: false }
    ])

    expect(selection.omittedFiles).toEqual([
      { path: 'bun.lock', reason: 'too-large', additions: 40_000, deletions: 30_000 },
      { path: 'src/new.ts', reason: 'too-large', additions: 30_000, deletions: 0 }
    ])
    expect(selection.excludePathspecs).toEqual([
      ':(exclude,literal)bun.lock',
      ':(exclude,literal)src/new.ts',
      ':(exclude,literal)src/old.ts'
    ])
  })

  it('keeps files at the churn limit and binary files of any size', () => {
    expect(selectOversizedDiffFiles([
      { path: 'generated.ts', additions: 20_000, deletions: 0, binary: false },
      { path: 'assets/movie.mov', additions: 0, deletions: 0, binary: true }
    ])).toEqual({ omittedFiles: [], excludePathspecs: [] })
  })
})

describe('diffFilesFromChurn', () => {
  it('sorts review files by path and carries their churn', () => {
    expect(diffFilesFromChurn([
      { path: 'src/value.ts', additions: 2, deletions: 1, binary: false },
      { path: 'README.md', additions: 4, deletions: 0, binary: false }
    ])).toEqual([
      { path: 'README.md', additions: 4, deletions: 0 },
      { path: 'src/value.ts', additions: 2, deletions: 1 }
    ])
  })
})

describe('pullRequestFilePageWave', () => {
  it('reads a wave of pages at a time', () => {
    expect(pullRequestFilePageWave(1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(pullRequestFilePageWave(9)).toEqual([9, 10, 11, 12, 13, 14, 15, 16])
  })

  it('stops at the ceiling the files API answers', () => {
    expect(pullRequestFilePageWave(25)).toEqual([25, 26, 27, 28, 29, 30])
    expect(pullRequestFilePageWave(31)).toEqual([])
  })

  it('treats a nonsense start page as the first one', () => {
    expect(pullRequestFilePageWave(0)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
})

describe('isPullRequestDiffTooLargeError', () => {
  it('recognises the 406 GitHub returns for pull requests it will not diff', () => {
    expect(isPullRequestDiffTooLargeError(new Error(
      "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of files (300). "
      + '(https://api.github.com/repos/microsoft/TypeScript/pulls/63763) PullRequest.diff too_large'
    ))).toBe(true)
  })

  it('leaves every other failure alone', () => {
    expect(isPullRequestDiffTooLargeError(new Error('HTTP 404: Not Found'))).toBe(false)
    expect(isPullRequestDiffTooLargeError(new Error('gh: command not found'))).toBe(false)
  })
})

describe('buildPullRequestPatchFromFiles', () => {
  it('adds the git headers the files API leaves out', () => {
    const built = buildPullRequestPatchFromFiles([{
      filename: 'src/app.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: '@@ -1 +1 @@\n-old\n+new'
    }])
    expect(built.patch).toBe(
      'diff --git a/src/app.ts b/src/app.ts\n'
      + '--- a/src/app.ts\n'
      + '+++ b/src/app.ts\n'
      + '@@ -1 +1 @@\n-old\n+new\n'
    )
    expect(built.files).toHaveLength(1)
    expect(built.files[0]).toMatchObject({ path: 'src/app.ts', additions: 1, deletions: 1 })
    expect(built.files[0]?.patchHash).toMatch(/^[0-9a-f]{64}$/)
    expect(built.omittedFiles).toEqual([])
  })

  it('marks added, removed and renamed files the way git does', () => {
    const built = buildPullRequestPatchFromFiles([
      { filename: 'added.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+one\n' },
      { filename: 'gone.ts', status: 'removed', additions: 0, deletions: 1, patch: '@@ -1 +0,0 @@\n-one\n' },
      {
        filename: 'new-name.ts',
        previous_filename: 'old-name.ts',
        status: 'renamed',
        additions: 1,
        deletions: 1,
        patch: '@@ -1 +1 @@\n-old\n+new\n'
      }
    ])
    expect(built.patch).toContain('diff --git a/added.ts b/added.ts\nnew file mode 100644\n--- /dev/null\n+++ b/added.ts\n')
    expect(built.patch).toContain('diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n')
    expect(built.patch).toContain(
      'diff --git a/old-name.ts b/new-name.ts\n'
      + 'rename from old-name.ts\nrename to new-name.ts\n'
      + '--- a/old-name.ts\n+++ b/new-name.ts\n'
    )
  })

  it('reports files GitHub sent without a patch instead of dropping them', () => {
    const built = buildPullRequestPatchFromFiles([
      { filename: 'logo.png', status: 'modified', additions: 0, deletions: 0 },
      { filename: 'huge.json', status: 'modified', additions: 900, deletions: 5, patch: '' }
    ])
    expect(built.patch).toBe('')
    expect(built.files.map((file) => file.path)).toEqual(['logo.png', 'huge.json'])
    expect(built.omittedFiles).toEqual([
      { path: 'logo.png', reason: 'too-large', additions: 0, deletions: 0 },
      { path: 'huge.json', reason: 'too-large', additions: 900, deletions: 5 }
    ])
  })

  it('keeps every file GitHub listed so files and patch agree', () => {
    const built = buildPullRequestPatchFromFiles([
      { filename: 'dist/app.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b\n' },
      { filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b\n' }
    ])
    expect(built.files.map((file) => file.path)).toEqual(['dist/app.js', 'src/app.ts'])
    expect(built.patch).toContain('dist/app.js')
  })
})

describe('streamed pull request payloads', () => {
  const review = (): PullRequestReview => ({
    kind: 'github',
    selector: '7',
    baseOid: 'base',
    headOid: 'head',
    commitId: 'head',
    viewerCanSubmitDecision: true,
    pullRequest: {
      number: 7,
      title: 'Large review',
      url: 'https://github.com/acme/repo/pull/7',
      state: 'OPEN',
      isDraft: false,
      author: { login: 'author' },
      headRefName: 'feature',
      baseRefName: 'main',
      reviewDecision: null,
      updatedAt: '2026-08-30T00:00:00Z',
      additions: 60,
      deletions: 0,
      changedFiles: 60
    },
    files: Array.from({ length: 60 }, (_unused, index) => ({
      path: `src/file-${index}.ts`, additions: 1, deletions: 0
    })),
    patch: 'large patch',
    omittedFiles: [{ path: 'large.bin', reason: 'too-large', additions: 0, deletions: 0 }],
    expectedFileCount: 60
  })

  it('the streamed reply omits bytes the pages already delivered', () => {
    expect(pullRequestReviewReply(review(), true)).toMatchObject({
      files: [], patch: '', omittedFiles: [], expectedFileCount: 60
    })
  })

  it('a non-streamed cached reply keeps the full review', () => {
    const cached = review()
    expect(pullRequestReviewReply(cached, false)).toBe(cached)
  })

  it('the fast path emits multiple pages for a 60-file diff', () => {
    const patch = Array.from({ length: 60 }, (_unused, index) => [
      `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
      `--- a/src/file-${index}.ts`,
      `+++ b/src/file-${index}.ts`,
      '@@ -0,0 +1 @@',
      `+${index}`,
      ''
    ].join('\n')).join('')
    const pages = chunkPatchByFileCount(patch)

    expect(pages).toHaveLength(3)
    expect(pages.map((page) => filesFromPatch(page).length)).toEqual([25, 25, 10])
    expect(pages.join('')).toBe(patch)
  })
})

describe('filesFromPatch', () => {
  it('recovers every file GitHub truncated out of its own list', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n context\n',
      'diff --git a/old/name.ts b/new/name.ts\nrename from old/name.ts\nrename to new/name.ts\n--- a/old/name.ts\n+++ b/new/name.ts\n@@ -1 +1 @@\n-a\n+b\n',
      'diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-only\n'
    ].join('')
    const files = filesFromPatch(patch)
    expect(files.map(({ path, previousPath, additions, deletions }) => ({
      path, previousPath, additions, deletions
    }))).toEqual([
      { path: 'src/a.ts', previousPath: undefined, additions: 1, deletions: 1 },
      { path: 'new/name.ts', previousPath: 'old/name.ts', additions: 1, deletions: 1 },
      { path: 'gone.ts', previousPath: undefined, additions: 0, deletions: 1 }
    ])
    expect(files.every((file) => /^[0-9a-f]{64}$/.test(file.patchHash ?? ''))).toBe(true)
  })

  it('unescapes a quoted path and reports a binary section as no churn', () => {
    const patch = 'diff --git "a/dir/a\\"b-\\303\\251.ts" "b/dir/a\\"b-\\303\\251.ts"\nBinary files differ\n'
    expect(filesFromPatch(patch)[0]).toMatchObject({ path: 'dir/a"b-é.ts', additions: 0, deletions: 0 })
  })

  it('returns nothing for an empty patch', () => {
    expect(filesFromPatch('')).toEqual([])
  })
})

describe('limitPatchFileSize', () => {
  const smallSection = 'diff --git a/small.ts b/small.ts\n--- a/small.ts\n+++ b/small.ts\n@@ -1 +1 @@\n-old\n+new\n'
  const largeSection = `diff --git a/large.ts b/large.ts\n--- a/large.ts\n+++ b/large.ts\n@@ -1,2 +1,3 @@\n-removed\n${
    Array.from({ length: 40 }, (_, index) => `+line ${index}`).join('\n')}\n`

  it('returns the original patch when every file fits', () => {
    const patch = `${smallSection}${largeSection}`

    expect(limitPatchFileSize(patch, 4_096)).toEqual({ patch, omittedFiles: [] })
  })

  it('drops oversized file sections and reports their churn', () => {
    const result = limitPatchFileSize(`${smallSection}${largeSection}${smallSection}`, 200)

    expect(result.patch).toBe(`${smallSection}${smallSection}`)
    expect(result.omittedFiles).toEqual([
      { path: 'large.ts', reason: 'too-large', additions: 40, deletions: 1 }
    ])
  })

  it('keeps patch metadata that precedes the first file', () => {
    const result = limitPatchFileSize(`commit metadata\n\n${largeSection}${smallSection}`, 200)

    expect(result.patch).toBe(`commit metadata\n\n${smallSection}`)
    expect(result.omittedFiles.map((file) => file.path)).toEqual(['large.ts'])
  })
})

describe('createNewFilePatch', () => {
  it('creates a unified new-file patch', () => {
    expect(createNewFilePatch('src/value.ts', 'first\nsecond\n')).toBe(
      'diff --git a/src/value.ts b/src/value.ts\n'
      + 'new file mode 100644\n'
      + '--- /dev/null\n'
      + '+++ b/src/value.ts\n'
      + '@@ -0,0 +1,2 @@\n'
      + '+first\n'
      + '+second\n'
    )
  })

  it('marks a missing trailing newline', () => {
    expect(createNewFilePatch('notes.txt', 'only line')).toBe(
      'diff --git a/notes.txt b/notes.txt\n'
      + 'new file mode 100644\n'
      + '--- /dev/null\n'
      + '+++ b/notes.txt\n'
      + '@@ -0,0 +1 @@\n'
      + '+only line\n'
      + '\\ No newline at end of file\n'
    )
  })

  it('keeps carriage returns inside the added lines', () => {
    expect(createNewFilePatch('notes.txt', 'first\r\nsecond\r\n')).toContain('+first\r\n+second\r\n')
  })

  it('emits header-only output for an empty file', () => {
    expect(createNewFilePatch('empty.txt', '')).toBe(
      'diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n'
    )
  })

  it('marks binary files instead of embedding their contents', () => {
    expect(createNewFilePatch('assets/logo.png', '', true)).toBe(
      'diff --git a/assets/logo.png b/assets/logo.png\n'
      + 'new file mode 100644\n'
      + 'Binary files /dev/null and b/assets/logo.png differ\n'
    )
  })

  it('quotes paths that Git would quote', () => {
    expect(createNewFilePatch('we"ird.txt', 'value\n')).toContain(
      'diff --git "a/we\\"ird.txt" "b/we\\"ird.txt"\n'
    )
  })
})

describe('classifySearchCompletion', () => {
  const completion = {
    cancelled: false,
    code: 0,
    signal: null,
    resultCount: 4,
    errorOutput: ''
  }

  it('reports partial results from a cancelled search as an error', () => {
    expect(classifySearchCompletion({ ...completion, cancelled: true, code: null, signal: 'SIGTERM' }))
      .toEqual({ kind: 'error', message: 'The search was cancelled before it finished.' })
  })

  it('reports an externally killed search as an error', () => {
    expect(classifySearchCompletion({ ...completion, code: null, signal: 'SIGKILL' }))
      .toEqual({ kind: 'error', message: 'The search stopped before it finished.' })
  })

  it('keeps results when the search was stopped at the result cap', () => {
    expect(classifySearchCompletion({ ...completion, code: null, signal: 'SIGTERM', resultCount: 200 }))
      .toEqual({ kind: 'results' })
  })

  it('surfaces ripgrep failures', () => {
    expect(classifySearchCompletion({ ...completion, code: 2, errorOutput: 'regex parse error\n' }))
      .toEqual({ kind: 'error', message: 'regex parse error' })
  })

  it('keeps results for a clean exit and for no matches', () => {
    expect(classifySearchCompletion(completion)).toEqual({ kind: 'results' })
    expect(classifySearchCompletion({ ...completion, code: 1, resultCount: 0 })).toEqual({ kind: 'results' })
  })

  it('measures the stop against the cap the caller asked for', () => {
    // The open file's own pass runs to a much higher cap than the palette's.
    expect(classifySearchCompletion({
      ...completion,
      code: null,
      signal: 'SIGTERM',
      resultCount: 30,
      resultCap: 200
    })).toEqual({ kind: 'error', message: 'The search stopped before it finished.' })
    expect(classifySearchCompletion({
      ...completion,
      code: null,
      signal: 'SIGTERM',
      resultCount: 200,
      resultCap: 200
    })).toEqual({ kind: 'results' })
  })
})

describe('contentSearchOpenPath', () => {
  it('accepts a repository-relative path and strips the leading ./', () => {
    expect(contentSearchOpenPath('src/App.tsx')).toBe('src/App.tsx')
    expect(contentSearchOpenPath('./src/App.tsx')).toBe('src/App.tsx')
    expect(contentSearchOpenPath('  src/App.tsx  ')).toBe('src/App.tsx')
  })

  it('refuses anything that could search outside the repository', () => {
    expect(contentSearchOpenPath('/etc/passwd')).toBeNull()
    expect(contentSearchOpenPath('../secrets/keys.txt')).toBeNull()
    expect(contentSearchOpenPath('src/../../out')).toBeNull()
    expect(contentSearchOpenPath('')).toBeNull()
    expect(contentSearchOpenPath(null)).toBeNull()
    expect(contentSearchOpenPath(42)).toBeNull()
    expect(contentSearchOpenPath(`a/${'b'.repeat(1_100)}`)).toBeNull()
  })
})

describe('mergeContentSearchResults', () => {
  const hit = (path: string, line: number): { path: string; line: number; column: number; preview: string } =>
    ({ path, line, column: 1, preview: 'needle' })

  it('keeps the repository hits first and appends what the open file adds', () => {
    const merged = mergeContentSearchResults(
      [hit('src/a.ts', 1), hit('src/open.ts', 4)],
      [hit('src/open.ts', 4), hit('src/open.ts', 9)]
    )
    expect(merged).toEqual([hit('src/a.ts', 1), hit('src/open.ts', 4), hit('src/open.ts', 9)])
  })

  it('returns the repository hits unchanged when no file was open', () => {
    expect(mergeContentSearchResults([hit('src/a.ts', 1)], [])).toEqual([hit('src/a.ts', 1)])
  })
})

describe('isPathWithinApprovedRoots', () => {
  const roots = ['/Users/dev/repository', '/Users/dev/other']

  it('accepts approved roots and paths inside them', () => {
    expect(isPathWithinApprovedRoots(roots, '/Users/dev/repository')).toBe(true)
    expect(isPathWithinApprovedRoots(roots, '/Users/dev/repository/packages/app')).toBe(true)
  })

  it('rejects unapproved roots and sibling prefixes', () => {
    expect(isPathWithinApprovedRoots(roots, '/Users/dev/repository-secrets')).toBe(false)
    expect(isPathWithinApprovedRoots(roots, '/Users/dev')).toBe(false)
    expect(isPathWithinApprovedRoots([], '/Users/dev/repository')).toBe(false)
  })
})

describe('summarizeCheckRollup', () => {
  it('classifies check run entries by status and conclusion', () => {
    expect(summarizeCheckRollup([
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'e2e', status: 'COMPLETED', conclusion: 'TIMED_OUT' },
      { __typename: 'CheckRun', name: 'deploy', status: 'COMPLETED', conclusion: 'ACTION_REQUIRED' },
      { __typename: 'CheckRun', name: 'perf', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { __typename: 'CheckRun', name: 'audit', status: 'IN_PROGRESS', conclusion: null },
      { __typename: 'CheckRun', name: 'bench', status: 'QUEUED', conclusion: null }
    ])).toEqual({ passing: 3, failing: 4, pending: 2 })
  })

  it('ignores a conclusion the check run has not reached yet', () => {
    expect(summarizeCheckRollup([
      { status: 'IN_PROGRESS', conclusion: 'SUCCESS' }
    ])).toEqual({ passing: 0, failing: 0, pending: 1 })
  })

  it('classifies status context entries by state', () => {
    expect(summarizeCheckRollup([
      { __typename: 'StatusContext', context: 'ci/build', state: 'SUCCESS' },
      { __typename: 'StatusContext', context: 'ci/test', state: 'FAILURE' },
      { __typename: 'StatusContext', context: 'ci/deploy', state: 'ERROR' },
      { __typename: 'StatusContext', context: 'ci/lint', state: 'PENDING' },
      { __typename: 'StatusContext', context: 'ci/docs', state: 'EXPECTED' }
    ])).toEqual({ passing: 1, failing: 2, pending: 2 })
  })

  it('summarizes a mixed rollup', () => {
    expect(summarizeCheckRollup([
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', state: 'PENDING' },
      { __typename: 'StatusContext', state: 'FAILURE' },
      { __typename: 'CheckRun', status: 'QUEUED' }
    ])).toEqual({ passing: 1, failing: 1, pending: 2 })
  })

  it('treats unknown result tokens as pending', () => {
    expect(summarizeCheckRollup([{ state: 'STALE' }, { status: 'COMPLETED' }])).toEqual({
      passing: 0,
      failing: 0,
      pending: 2
    })
  })

  it('matches result tokens case insensitively', () => {
    expect(summarizeCheckRollup([
      { status: 'completed', conclusion: 'success' },
      { state: ' failure ' },
      { status: 'in_progress' }
    ])).toEqual({ passing: 1, failing: 1, pending: 1 })
  })

  it('returns zero counts for an empty rollup', () => {
    expect(summarizeCheckRollup([])).toEqual({ passing: 0, failing: 0, pending: 0 })
  })

  it('ignores malformed entries', () => {
    expect(summarizeCheckRollup([
      null,
      'SUCCESS',
      7,
      {},
      { status: '', conclusion: '   ' },
      { name: 'build' },
      { status: 'COMPLETED', conclusion: 'SUCCESS' }
    ])).toEqual({ passing: 1, failing: 0, pending: 0 })
  })

  it('returns null when the rollup is absent or not an array', () => {
    expect(summarizeCheckRollup(null)).toBeNull()
    expect(summarizeCheckRollup(undefined)).toBeNull()
    expect(summarizeCheckRollup('SUCCESS')).toBeNull()
    expect(summarizeCheckRollup({ nodes: [] })).toBeNull()
  })
})

describe('chunkPathspecs', () => {
  it('keeps a small list in one chunk and preserves order across chunks', () => {
    expect(chunkPathspecs(['a', 'b', 'c'])).toEqual([['a', 'b', 'c']])
    expect(chunkPathspecs(['aaa', 'bbb', 'ccc'], 8)).toEqual([['aaa', 'bbb'], ['ccc']])
  })

  it('never drops a path that is longer than the budget on its own', () => {
    expect(chunkPathspecs(['short', 'a-very-long-path'], 8)).toEqual([['short'], ['a-very-long-path']])
  })

  it('stays under the argv budget that E2BIG was measured at', () => {
    const paths = Array.from({ length: 20_000 }, (_unused, index) => `src/generated/module-${index}/index.ts`)
    const chunks = chunkPathspecs(paths)
    expect(chunks.flat()).toEqual(paths)
    for (const chunk of chunks) {
      expect(chunk.reduce((total, path) => total + path.length + 1, 0)).toBeLessThanOrEqual(128 * 1024)
    }
  })
})

describe('isolateFirstPathspec', () => {
  it('pulls the first visible path out so it can be emitted alone', () => {
    expect(isolateFirstPathspec([])).toEqual({ first: null, rest: [] })
    expect(isolateFirstPathspec(['a.ts'])).toEqual({ first: 'a.ts', rest: [] })
    expect(isolateFirstPathspec(['a.ts', 'b.ts', 'c.ts'])).toEqual({ first: 'a.ts', rest: ['b.ts', 'c.ts'] })
  })
})

describe('pathspec groups', () => {
  it('keeps a rename pair atomic and literal', () => {
    expect(pathspecGroupForFile({ path: 'new.ts' })).toEqual([':(literal)new.ts'])
    expect(pathspecGroupForFile({ path: 'new.ts', previousPath: 'old.ts' }))
      .toEqual([':(literal)old.ts', ':(literal)new.ts'])
    expect(isolateFirstPathspecGroup([
      [':(literal)old.ts', ':(literal)new.ts'],
      [':(literal)other.ts']
    ])).toEqual({
      first: [':(literal)old.ts', ':(literal)new.ts'],
      rest: [[':(literal)other.ts']]
    })
    expect(chunkPathspecGroups([
      [':(literal)a.ts', ':(literal)b.ts'],
      [':(literal)c.ts']
    ], 40)).toEqual([
      [':(literal)a.ts', ':(literal)b.ts'],
      [':(literal)c.ts']
    ])
  })
})

describe('replaceStatusEntry', () => {
  const tracked = (path: string): { path: string; status: 'modified' } => ({ path, status: 'modified' })
  const untracked = (path: string): { path: string; status: 'untracked' } => ({ path, status: 'untracked' })

  it('inserts a tracked entry in path order ahead of the untracked section', () => {
    const statuses = [tracked('a.ts'), tracked('c.ts'), untracked('new.ts')]
    expect(replaceStatusEntry(statuses, 'b.ts', tracked('b.ts'))).toEqual([
      tracked('a.ts'), tracked('b.ts'), tracked('c.ts'), untracked('new.ts')
    ])
  })

  it('replaces an existing entry in place and removes it when the file goes clean', () => {
    const statuses = [tracked('a.ts'), tracked('b.ts')]
    expect(replaceStatusEntry(statuses, 'a.ts', { path: 'a.ts', status: 'added' })).toEqual([
      { path: 'a.ts', status: 'added' }, tracked('b.ts')
    ])
    expect(replaceStatusEntry(statuses, 'a.ts', null)).toEqual([tracked('b.ts')])
  })

  it('keeps untracked entries after the tracked ones', () => {
    const statuses = [tracked('a.ts'), untracked('z.ts')]
    expect(replaceStatusEntry(statuses, 'b.ts', untracked('b.ts'))).toEqual([
      tracked('a.ts'), untracked('b.ts'), untracked('z.ts')
    ])
  })
})

describe('GitObjectReader', () => {
  it('serves many reads from a single git process and reports blob type', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-reader-'))
    try {
      await initRepository(repositoryPath)
      for (let index = 0; index < 40; index += 1) {
        await writeFile(join(repositoryPath, `file-${index}.txt`), `value ${index}\n`, 'utf8')
      }
      await commitAll(repositoryPath, 'Initial commit')

      const reader = new GitObjectReader(repositoryPath)
      try {
        const reads = await Promise.all(
          Array.from({ length: 40 }, (_unused, index) => reader.read(`HEAD:file-${index}.txt`))
        )
        for (const [index, read] of reads.entries()) {
          expect(read.missing).toBe(false)
          expect(read.type).toBe('blob')
          expect(read.oid).toMatch(/^[0-9a-f]{40}$/)
          expect(read.contents?.toString('utf8')).toBe(`value ${index}\n`)
        }
        expect(reader.spawnCountForTests).toBe(1)
      } finally {
        reader.dispose()
      }
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('keeps the stream aligned when an oversized object is skipped', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-reader-big-'))
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'small.txt'), 'small\n', 'utf8')
      await writeFile(join(repositoryPath, 'big.bin'), Buffer.alloc(3 * 1024 * 1024, 0x61))
      await commitAll(repositoryPath, 'Initial commit')

      const reader = new GitObjectReader(repositoryPath)
      try {
        const [big, small, absent] = await Promise.all([
          reader.read('HEAD:big.bin'),
          reader.read('HEAD:small.txt'),
          reader.read('HEAD:absent.txt')
        ])
        expect(big?.oversized).toBe(true)
        expect(big?.contents).toBeNull()
        // The record after an oversized one must still be the file that was asked for.
        expect(small?.contents?.toString('utf8')).toBe('small\n')
        expect(absent?.missing).toBe(true)
        expect(reader.spawnCountForTests).toBe(1)
      } finally {
        reader.dispose()
      }
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })
})

describe('PullRequestReviewCache', () => {
  const review = (overrides: Record<string, unknown> = {}): PullRequestReview => ({
    kind: 'github',
    selector: '7',
    baseOid: 'base-oid-1',
    headOid: 'oid-1',
    commitId: 'oid-1',
    viewerCanSubmitDecision: true,
    pullRequest: {
      number: 7,
      title: 'Add a thing',
      url: 'https://github.com/acme/app/pull/7',
      state: 'open',
      isDraft: false,
      author: { login: 'author' },
      headRefName: 'feature',
      baseRefName: 'main',
      reviewDecision: null,
      updatedAt: '2026-08-17T00:00:00Z',
      additions: 1,
      deletions: 0,
      changedFiles: 1
    },
    files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
    patch: 'diff --git a/src/a.ts b/src/a.ts\n',
    omittedFiles: [],
    expectedFileCount: 1,
    ...overrides
  })

  it('round-trips a review and misses on a different head oid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-pr-cache-'))
    try {
      const cache = new PullRequestReviewCache(join(directory, 'pr-cache'))
      const url = 'https://github.com/acme/app/pull/7'
      await cache.write(url, 'oid-1', review())

      const hit = await cache.read(url, 'oid-1')
      expect(hit?.patch).toBe('diff --git a/src/a.ts b/src/a.ts\n')
      expect(hit?.files).toEqual([{ path: 'src/a.ts', additions: 1, deletions: 0 }])
      const names = await readdir(join(directory, 'pr-cache'))
      expect(names.filter((name) => name.endsWith('.json') && !name.endsWith('.latest.json'))).toHaveLength(1)
      expect(names.filter((name) => name.endsWith('.latest.json'))).toHaveLength(1)
      expect(names.filter((name) => name.endsWith('.patch'))).toHaveLength(1)
      const metadataName = names.find((name) => name.endsWith('.json') && !name.endsWith('.latest.json'))
      const metadata = JSON.parse(await readFile(join(directory, 'pr-cache', metadataName ?? ''), 'utf8'))
      expect(metadata.patch).toBeUndefined()
      expect(metadata.patchLength).toBe(review().patch.length)
      // A force-push moves the head oid, which is the key, so the old entry can
      // never be served for the new diff.
      expect(await cache.read(url, 'oid-2')).toBeNull()
      expect(await cache.read('https://github.com/acme/other/pull/7', 'oid-1')).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('misses when the base is retargeted without moving the head', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-pr-cache-retarget-'))
    try {
      const cache = new PullRequestReviewCache(join(directory, 'pr-cache'))
      const original = review()
      await cache.write(original.pullRequest.url, original.headOid, original)
      const retargeted = review({
        baseOid: 'base-oid-2',
        pullRequest: { ...original.pullRequest, baseRefName: 'release' }
      })
      expect(await cache.read(original.pullRequest.url, pullRequestSnapshotIdentity(retargeted))).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('treats a corrupt entry as a miss and never writes an empty review', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-pr-cache-bad-'))
    try {
      const cacheDirectory = join(directory, 'pr-cache')
      const cache = new PullRequestReviewCache(cacheDirectory)
      const url = 'https://github.com/acme/app/pull/7'
      await cache.write(url, 'oid-1', review())
      const names = await readdir(cacheDirectory)
      const entryName = names.find((name) => name.endsWith('.json'))
      const patchName = names.find((name) => name.endsWith('.patch'))
      await writeFile(join(cacheDirectory, patchName ?? ''), 'truncated', 'utf8')
      expect(await cache.read(url, 'oid-1')).toBeNull()

      await writeFile(join(cacheDirectory, entryName ?? ''), '{ not json', 'utf8')
      expect(await cache.read(url, 'oid-1')).toBeNull()

      await cache.write(url, 'oid-3', review({ files: [] }))
      expect(await cache.read(url, 'oid-3')).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('sweeps the oldest entries past the entry cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-pr-cache-sweep-'))
    try {
      const cacheDirectory = join(directory, 'pr-cache')
      const cache = new PullRequestReviewCache(cacheDirectory)
      for (let index = 1; index <= 64; index += 1) {
        const url = `https://github.com/acme/app/pull/${index}`
        await cache.write(url, `oid-${index}`, review({
          headOid: `oid-${index}`,
          commitId: `oid-${index}`,
          pullRequest: { ...review().pullRequest, number: index, url }
        }))
      }
      await writeFile(join(cacheDirectory, 'orphan.patch'), 'orphan', 'utf8')
      await cache.sweep()
      const names = await readdir(cacheDirectory)
      const metadataCount = names.filter((name) => name.endsWith('.json') && !name.endsWith('.latest.json')).length
      const patchCount = names.filter((name) => name.endsWith('.patch')).length
      expect(names.filter((name) => name.endsWith('.latest.json')).length).toBeLessThanOrEqual(60)
      expect(metadataCount).toBeLessThanOrEqual(60)
      expect(patchCount).toBe(metadataCount)
      expect(names).not.toContain('orphan.patch')
      // The most recent write always survives its own sweep.
      expect(await cache.read('https://github.com/acme/app/pull/64', 'oid-64')).not.toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('indexes the latest diff per URL so a reopen needs no head oid', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-pr-index-'))
    try {
      const cache = new PullRequestReviewCache(join(directory, 'pr-cache'))
      const url = 'https://github.com/acme/app/pull/7'
      await cache.write(url, 'oid-1', review())

      const index = await cache.readIndex(url)
      expect(index?.headRefOid).toBe('oid-1')
      expect(index?.url).toBe(url)
      expect(index?.baseRefOid).toBe('base-oid-1')
      expect(index?.viewerCanSubmitDecision).toBe(true)
      expect(index?.summary.title).toBe('Add a thing')
      // The reader has a pasted URL, the writer had GitHub's canonical one.
      expect((await cache.readIndex('https://github.com/acme/app/pull/7?files=1#top'))?.headRefOid).toBe('oid-1')
      expect(await cache.readIndex('https://github.com/acme/other/pull/7')).toBeNull()
      expect(await cache.readIndex('7')).toBeNull()

      // A force push repoints the index at the new diff.
      await cache.write(url, 'oid-2', review({ headOid: 'oid-2', commitId: 'oid-2' }))
      expect((await cache.readIndex(url))?.headRefOid).toBe('oid-2')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('treats a corrupt or superseded index as a miss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-pr-index-bad-'))
    try {
      const cacheDirectory = join(directory, 'pr-cache')
      const cache = new PullRequestReviewCache(cacheDirectory)
      const url = 'https://github.com/acme/app/pull/7'
      await cache.write(url, 'oid-1', review())
      const indexName = (await readdir(cacheDirectory)).find((name) => name.endsWith('.latest.json'))
      await writeFile(join(cacheDirectory, indexName ?? ''), '{ not json', 'utf8')
      expect(await cache.readIndex(url)).toBeNull()

      await writeFile(join(cacheDirectory, indexName ?? ''), JSON.stringify({ version: 0 }), 'utf8')
      expect(await cache.readIndex(url)).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('RepositoryService content search', () => {
  it('caps the repository pass and still marks every hit in the open file', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'kodi-search-cap-'))
    const repository = new RepositoryService()
    try {
      for (let index = 0; index < 30; index += 1) {
        await writeFile(join(folderPath, `file-${index}.ts`), 'const needle = 1\n', 'utf8')
      }
      const openPath = 'open.ts'
      await writeFile(
        join(folderPath, openPath),
        Array.from({ length: 40 }, (_value, line) => `const needle${line} = ${line}`).join('\n'),
        'utf8'
      )
      await repository.open(folderPath)

      const capped = await repository.searchContent('needle')
      // 24 rows, not 200: the palette renders eight of them.
      expect(capped).toHaveLength(24)
      expect(capped.filter((result) => result.path === openPath).length).toBeLessThanOrEqual(20)

      const withOpenFile = await repository.searchContent('needle', openPath)
      // Every hit in the file on screen, so the diff can mark all of them.
      expect(withOpenFile.filter((result) => result.path === openPath)).toHaveLength(40)
      expect(withOpenFile.filter((result) => result.path !== openPath).length).toBeLessThanOrEqual(24)
      const keys = withOpenFile.map((result) => `${result.path}:${result.line}`)
      expect(new Set(keys).size).toBe(keys.length)
    } finally {
      repository.dispose()
      await rm(folderPath, { recursive: true, force: true })
    }
  })

  it('ignores an open path that is not inside the repository', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'kodi-search-escape-'))
    const repository = new RepositoryService()
    try {
      await writeFile(join(folderPath, 'value.ts'), 'const needle = 1\n', 'utf8')
      await repository.open(folderPath)
      expect(await repository.searchContent('needle', '../../etc/passwd'))
        .toEqual(await repository.searchContent('needle'))
    } finally {
      repository.dispose()
      await rm(folderPath, { recursive: true, force: true })
    }
  })
})

describe('RepositoryService pull request review', () => {
  const cachedReview = (): PullRequestReview => ({
    kind: 'github',
    selector: 'https://github.com/acme/app/pull/7',
    baseOid: 'base-oid-1',
    headOid: 'oid-1',
    commitId: 'oid-1',
    viewerCanSubmitDecision: true,
    pullRequest: {
      number: 7,
      title: 'Add a thing',
      url: 'https://github.com/acme/app/pull/7',
      state: 'open',
      isDraft: false,
      author: { login: 'author' },
      headRefName: 'feature',
      baseRefName: 'main',
      reviewDecision: null,
      updatedAt: '2026-08-17T00:00:00Z',
      additions: 1,
      deletions: 0,
      changedFiles: 1
    },
    files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
    patch: 'diff --git a/src/a.ts b/src/a.ts\n',
    omittedFiles: [],
    expectedFileCount: 1
  })

  async function openCachedRepository(prefix: string): Promise<{
    repositoryPath: string
    repository: RepositoryService
    url: string
  }> {
    const repositoryPath = await mkdtemp(join(tmpdir(), prefix))
    await initRepository(repositoryPath)
    await writeFile(join(repositoryPath, 'value.ts'), 'export const value = 1\n', 'utf8')
    await commitAll(repositoryPath, 'Initial commit')
    const cacheDirectory = join(repositoryPath, 'pr-cache')
    const url = 'https://github.com/acme/app/pull/7'
    await new PullRequestReviewCache(cacheDirectory).write(url, 'oid-1', cachedReview())
    const repository = new RepositoryService()
    await repository.open(repositoryPath)
    repository.setPullRequestCacheDirectory(cacheDirectory)
    return { repositoryPath, repository, url }
  }

  it('opens a cached pull request from the URL index before asking GitHub anything', async () => {
    const { repositoryPath, repository, url } = await openCachedRepository('kodi-pr-open-')
    try {
      const events: PullRequestReviewProgress[] = []
      const promise = repository.getPullRequestReview(url, (progress) => events.push(progress), 'req-1')
      // Cancelling now leaves the disk paint intact and stops the background
      // revalidation before it can spawn, so the test never touches the network.
      repository.cancelPullRequestReview('req-1')
      const reply = await promise

      expect(events.map((event) => event.kind)).toEqual(['metadata', 'files', 'done'])
      const [metadata, page] = events
      expect(metadata?.kind === 'metadata' && metadata.review.pullRequest.title).toBe('Add a thing')
      expect(metadata?.kind === 'metadata' && metadata.review.headOid).toBe('oid-1')
      expect(page?.kind === 'files' && page.patch).toBe('diff --git a/src/a.ts b/src/a.ts\n')
      expect(page?.kind === 'files' && page.files).toEqual([{ path: 'src/a.ts', additions: 1, deletions: 0 }])
      // Streamed, so the reply leaves the patch out rather than cloning it twice.
      expect(reply.patch).toBe('')
      expect(reply.files).toEqual([])
      expect(reply.expectedFileCount).toBe(1)
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('lets a reader join the warmup flight instead of waiting behind it', async () => {
    const { repositoryPath, repository, url } = await openCachedRepository('kodi-pr-join-')
    try {
      const events: PullRequestReviewProgress[] = []
      const warmup = repository.getPullRequestReview(url, undefined, `warmup:${url}`, 'warmup')
      const reader = repository.getPullRequestReview(url, (progress) => events.push(progress), 'req-2')
      // The warmup never claimed the flight, so the reader's cancel still ends it.
      repository.cancelPullRequestReview('req-2')
      const [warmed, reply] = await Promise.all([warmup, reader])

      // The warmup used to take the only progress callback with it; the reader
      // received nothing at all and waited for the resolved review.
      expect(events.map((event) => event.kind)).toEqual(['metadata', 'files', 'done'])
      expect(warmed.files).toHaveLength(1)
      expect(reply.files).toEqual([])
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })
})

describe('RepositoryService', () => {
  async function openCommitFixture(prefix: string): Promise<{ repositoryPath: string; repository: RepositoryService }> {
    const repositoryPath = await mkdtemp(join(tmpdir(), prefix))
    await initRepository(repositoryPath)
    // The service spawns git with the real environment, so the fixture pins
    // identity, signing and hooks locally instead of trusting ~/.gitconfig.
    await runGit(repositoryPath, 'config', 'user.name', 'Kodi Test')
    await runGit(repositoryPath, 'config', 'user.email', 'test@example.invalid')
    await runGit(repositoryPath, 'config', 'commit.gpgsign', 'false')
    await runGit(repositoryPath, 'config', 'core.hooksPath', join(repositoryPath, '.no-hooks'))
    await writeFile(join(repositoryPath, 'kept.ts'), 'one\n', 'utf8')
    await writeFile(join(repositoryPath, 'gone.ts'), 'bye\n', 'utf8')
    await commitAll(repositoryPath, 'Initial commit')
    const repository = new RepositoryService()
    await repository.open(repositoryPath)
    return { repositoryPath, repository }
  }

  it('stages, unstages and commits changed files', async () => {
    const { repositoryPath, repository } = await openCommitFixture('kodi-commit-')
    try {
      await writeFile(join(repositoryPath, 'kept.ts'), 'two\n', 'utf8')
      await rm(join(repositoryPath, 'gone.ts'))
      await writeFile(join(repositoryPath, 'new file.ts'), 'new\n', 'utf8')
      await repository.refresh()

      let snapshot = await repository.stagePaths(['kept.ts', 'gone.ts', 'new file.ts'])
      expect(snapshot.statuses.map((entry) => [entry.path, entry.staged])).toEqual([
        ['gone.ts', 'all'],
        ['kept.ts', 'all'],
        ['new file.ts', 'all']
      ])

      snapshot = await repository.unstagePaths(['new file.ts'])
      expect(snapshot.statuses.find((entry) => entry.path === 'new file.ts')).toEqual({
        path: 'new file.ts',
        status: 'untracked'
      })

      snapshot = await repository.commitChanges({ message: '  Update kept\n\n-body with a dash\n' })
      expect(snapshot.statuses).toEqual([{ path: 'new file.ts', status: 'untracked' }])
      expect(await runGitAllowingDifferences(repositoryPath, 'log', '-1', '--format=%B')).toBe('Update kept\n\n-body with a dash\n\n')

      snapshot = await repository.commitChanges({ message: 'Add the rest', all: true })
      expect(snapshot.statuses).toEqual([])
      expect(await runGitAllowingDifferences(repositoryPath, 'show', '--name-only', '--format=', 'HEAD')).toBe('new file.ts\n')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('amends without a message and refuses an empty new commit message', async () => {
    const { repositoryPath, repository } = await openCommitFixture('kodi-amend-')
    try {
      await writeFile(join(repositoryPath, 'kept.ts'), 'two\n', 'utf8')
      await repository.refresh()
      await repository.stagePaths(['kept.ts'])
      await expect(repository.commitChanges({ message: '   ' })).rejects.toThrow('Write a commit message first.')
      const snapshot = await repository.commitChanges({ message: '', amend: true })
      expect(snapshot.statuses).toEqual([])
      expect(await runGitAllowingDifferences(repositoryPath, 'log', '--format=%s')).toBe('Initial commit\n')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('discards only unstaged work and deletes untracked files', async () => {
    const { repositoryPath, repository } = await openCommitFixture('kodi-discard-')
    try {
      await writeFile(join(repositoryPath, 'kept.ts'), 'staged\n', 'utf8')
      await repository.refresh()
      await repository.stagePaths(['kept.ts'])
      await writeFile(join(repositoryPath, 'kept.ts'), 'staged then edited\n', 'utf8')
      await writeFile(join(repositoryPath, 'scratch.ts'), 'temp\n', 'utf8')
      await repository.refresh()

      const snapshot = await repository.discardPaths(['kept.ts', 'scratch.ts'])
      expect(snapshot.statuses).toEqual([{ path: 'kept.ts', status: 'modified', staged: 'all' }])
      expect(await readFile(join(repositoryPath, 'kept.ts'), 'utf8')).toBe('staged\n')
      await expect(stat(join(repositoryPath, 'scratch.ts'))).rejects.toThrow()
      await expect(repository.discardPaths(['../outside'])).rejects.toThrow('no longer changed')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  describe('a staged rename', () => {
    // Long enough that one appended line keeps the pair above git's rename
    // similarity threshold.
    const original = Array.from({ length: 20 }, (_unused, index) => `line ${index}\n`).join('')

    async function openRenameFixture(
      prefix: string,
      worktree: 'unchanged' | 'modified' | 'deleted'
    ): Promise<{ repositoryPath: string; repository: RepositoryService }> {
      const fixture = await openCommitFixture(prefix)
      const { repositoryPath, repository } = fixture
      await writeFile(join(repositoryPath, 'old.ts'), original, 'utf8')
      await commitAll(repositoryPath, 'Add old')
      await runGit(repositoryPath, 'mv', 'old.ts', 'new.ts')
      if (worktree === 'modified') await writeFile(join(repositoryPath, 'new.ts'), `${original}edited\n`, 'utf8')
      if (worktree === 'deleted') await rm(join(repositoryPath, 'new.ts'))
      await repository.refresh()
      return fixture
    }

    async function porcelain(repositoryPath: string): Promise<string> {
      return runGitAllowingDifferences(repositoryPath, 'status', '--porcelain')
    }

    it('stages an RM entry without naming the original path the index already dropped', async () => {
      const { repositoryPath, repository } = await openRenameFixture('kodi-rename-stage-', 'modified')
      try {
        expect(repository.getSessionSnapshot()?.statuses).toEqual([
          { path: 'new.ts', previousPath: 'old.ts', status: 'renamed', staged: 'partial' }
        ])
        // `add -A :(literal)old.ts` failed the whole batch with exit 128.
        const snapshot = await repository.stagePaths(['new.ts'])
        expect(snapshot.statuses).toEqual([{ path: 'new.ts', previousPath: 'old.ts', status: 'renamed', staged: 'all' }])
        expect(await porcelain(repositoryPath)).toBe('R  old.ts -> new.ts\n')
      } finally {
        repository.dispose()
        await rm(repositoryPath, { recursive: true, force: true })
      }
    })

    it('unstages both halves of a rename', async () => {
      const { repositoryPath, repository } = await openRenameFixture('kodi-rename-unstage-', 'modified')
      try {
        await repository.unstagePaths(['new.ts'])
        // Restoring only `new.ts` left a staged deletion of `old.ts` behind.
        expect(await porcelain(repositoryPath)).toBe(' D old.ts\n?? new.ts\n')
        expect(await readFile(join(repositoryPath, 'new.ts'), 'utf8')).toBe(`${original}edited\n`)
      } finally {
        repository.dispose()
        await rm(repositoryPath, { recursive: true, force: true })
      }
    })

    it('discards an RM entry back to the staged rename', async () => {
      const { repositoryPath, repository } = await openRenameFixture('kodi-rename-discard-', 'modified')
      try {
        // `restore --worktree :(literal)old.ts` exited 1 and discarded nothing.
        const snapshot = await repository.discardPaths(['new.ts'])
        expect(snapshot.statuses).toEqual([{ path: 'new.ts', previousPath: 'old.ts', status: 'renamed', staged: 'all' }])
        expect(await readFile(join(repositoryPath, 'new.ts'), 'utf8')).toBe(original)
      } finally {
        repository.dispose()
        await rm(repositoryPath, { recursive: true, force: true })
      }
    })

    it('stages and discards an RD entry', async () => {
      const staged = await openRenameFixture('kodi-rename-rd-stage-', 'deleted')
      try {
        expect(staged.repository.getSessionSnapshot()?.statuses).toEqual([
          { path: 'new.ts', previousPath: 'old.ts', status: 'renamed', staged: 'partial' }
        ])
        await staged.repository.stagePaths(['new.ts'])
        expect(await porcelain(staged.repositoryPath)).toBe('D  old.ts\n')
      } finally {
        staged.repository.dispose()
        await rm(staged.repositoryPath, { recursive: true, force: true })
      }

      const discarded = await openRenameFixture('kodi-rename-rd-discard-', 'deleted')
      try {
        await discarded.repository.discardPaths(['new.ts'])
        expect(await porcelain(discarded.repositoryPath)).toBe('R  old.ts -> new.ts\n')
        expect(await readFile(join(discarded.repositoryPath, 'new.ts'), 'utf8')).toBe(original)
      } finally {
        discarded.repository.dispose()
        await rm(discarded.repositoryPath, { recursive: true, force: true })
      }
    })

    it('treats stage and discard of a fully staged R. entry as nothing to do, and unstages it', async () => {
      const { repositoryPath, repository } = await openRenameFixture('kodi-rename-clean-', 'unchanged')
      try {
        await repository.stagePaths(['new.ts'])
        await repository.discardPaths(['new.ts'])
        expect(await porcelain(repositoryPath)).toBe('R  old.ts -> new.ts\n')
        await repository.unstagePaths(['new.ts'])
        expect(await porcelain(repositoryPath)).toBe(' D old.ts\n?? new.ts\n')
      } finally {
        repository.dispose()
        await rm(repositoryPath, { recursive: true, force: true })
      }
    })

    it('leaves an untracked file at the original path alone when the rename is discarded', async () => {
      const { repositoryPath, repository } = await openRenameFixture('kodi-rename-reused-', 'modified')
      try {
        await writeFile(join(repositoryPath, 'old.ts'), 'a new file under the old name\n', 'utf8')
        await repository.refresh()
        await repository.discardPaths(['new.ts'])
        // Looking the original path up again classified it as untracked and deleted it.
        expect(await readFile(join(repositoryPath, 'old.ts'), 'utf8')).toBe('a new file under the old name\n')
        expect(await readFile(join(repositoryPath, 'new.ts'), 'utf8')).toBe(original)
      } finally {
        repository.dispose()
        await rm(repositoryPath, { recursive: true, force: true })
      }
    })
  })

  describe('an unstaged rename', () => {
    const original = Array.from({ length: 20 }, (_unused, index) => `line ${index}\n`).join('')

    // `git add -N` on the new name with the old one deleted: git pairs the two
    // into a working-tree rename, which porcelain v2 reports as `.R`.
    async function openIntentToAddRename(prefix: string): Promise<{ repositoryPath: string; repository: RepositoryService }> {
      const fixture = await openCommitFixture(prefix)
      const { repositoryPath, repository } = fixture
      await writeFile(join(repositoryPath, 'old.ts'), original, 'utf8')
      await commitAll(repositoryPath, 'Add old')
      await rm(join(repositoryPath, 'old.ts'))
      await writeFile(join(repositoryPath, 'new.ts'), `${original}edited\n`, 'utf8')
      await runGit(repositoryPath, 'add', '-N', 'new.ts')
      await repository.refresh()
      return fixture
    }

    async function porcelain(repositoryPath: string): Promise<string> {
      return runGitAllowingDifferences(repositoryPath, 'status', '--porcelain')
    }

    it('parses as a rename with nothing staged', async () => {
      const { repositoryPath, repository } = await openIntentToAddRename('kodi-ita-parse-')
      try {
        expect(repository.getSessionSnapshot()?.statuses).toEqual([
          { path: 'new.ts', previousPath: 'old.ts', status: 'renamed' }
        ])
        expect(await porcelain(repositoryPath)).toBe(' R old.ts -> new.ts\n')
      } finally {
        repository.dispose()
        await rm(repositoryPath, { recursive: true, force: true })
      }
    })

    it('stages both halves into a staged rename', async () => {
      const { repositoryPath, repository } = await openIntentToAddRename('kodi-ita-stage-')
      try {
        const snapshot = await repository.stagePaths(['new.ts'])
        expect(snapshot.statuses).toEqual([{ path: 'new.ts', previousPath: 'old.ts', status: 'renamed', staged: 'all' }])
        expect(await porcelain(repositoryPath)).toBe('R  old.ts -> new.ts\n')
      } finally {
        repository.dispose()
        await rm(repositoryPath, { recursive: true, force: true })
      }
    })

    it('unstages the placeholder, leaving the new file untracked', async () => {
      const { repositoryPath, repository } = await openIntentToAddRename('kodi-ita-unstage-')
      try {
        await repository.unstagePaths(['new.ts'])
        expect(await porcelain(repositoryPath)).toBe(' D old.ts\n?? new.ts\n')
        expect(await readFile(join(repositoryPath, 'new.ts'), 'utf8')).toBe(`${original}edited\n`)
      } finally {
        repository.dispose()
        await rm(repositoryPath, { recursive: true, force: true })
      }
    })

    it('discards back to the original file, with no empty new file left listed as added', async () => {
      const { repositoryPath, repository } = await openIntentToAddRename('kodi-ita-discard-')
      try {
        // `restore --worktree new.ts old.ts` exited 0, but it restored the
        // placeholder too: new.ts was emptied and stayed listed as ` A`.
        const snapshot = await repository.discardPaths(['new.ts'])
        expect(snapshot.statuses).toEqual([])
        expect(await porcelain(repositoryPath)).toBe('')
        expect(await readFile(join(repositoryPath, 'old.ts'), 'utf8')).toBe(original)
        expect(existsSync(join(repositoryPath, 'new.ts'))).toBe(false)
      } finally {
        repository.dispose()
        await rm(repositoryPath, { recursive: true, force: true })
      }
    })

    it('discards a plain intent-to-add file the same way', async () => {
      const { repositoryPath, repository } = await openCommitFixture('kodi-ita-added-')
      try {
        await writeFile(join(repositoryPath, 'fresh.ts'), 'fresh\n', 'utf8')
        await runGit(repositoryPath, 'add', '-N', 'fresh.ts')
        await repository.refresh()
        expect(repository.getSessionSnapshot()?.statuses).toEqual([{ path: 'fresh.ts', status: 'added' }])

        const snapshot = await repository.discardPaths(['fresh.ts'])
        expect(snapshot.statuses).toEqual([])
        expect(existsSync(join(repositoryPath, 'fresh.ts'))).toBe(false)
      } finally {
        repository.dispose()
        await rm(repositoryPath, { recursive: true, force: true })
      }
    })
  })

  it('keeps the self-write window open for the whole of a slow branch switch', async () => {
    const { repositoryPath, repository } = await openCommitFixture('kodi-switch-window-')
    const hooks = await mkdtemp(join(tmpdir(), 'kodi-switch-hooks-'))
    try {
      await runGit(repositoryPath, 'branch', 'other')
      // Longer than the watcher's one-second window.
      await writeFile(join(hooks, 'post-checkout'), '#!/bin/sh\nsleep 1.6\n', { mode: 0o755 })
      await runGit(repositoryPath, 'config', 'core.hooksPath', hooks)
      await repository.refresh()

      const armedAt: number[] = []
      repository.setSelfWriteObserver((path) => { if (path === '.git/index') armedAt.push(Date.now()) })
      let refreshedAt = 0
      const snapshot = repository.getSessionSnapshot()!
      // The refresh arms the window on its own; only the switch is measured.
      const refreshSpy = spyOn(repository, 'refresh').mockImplementation(async () => {
        refreshedAt = Date.now()
        return snapshot
      })
      const startedAt = Date.now()
      try {
        await repository.switchBranch('other')
      } finally {
        refreshSpy.mockRestore()
      }

      expect(refreshedAt - startedAt).toBeGreaterThan(1_500)
      // The switch was never armed at all; arming it only on either side would
      // leave a gap as long as the hook.
      expect(armedAt[0]! - startedAt).toBeLessThan(200)
      const gaps = armedAt.slice(1).map((at, index) => at - armedAt[index]!)
      expect(Math.max(...gaps)).toBeLessThan(1_000)
      expect(refreshedAt - armedAt.at(-1)!).toBeLessThan(200)
      expect(await runGitAllowingDifferences(repositoryPath, 'branch', '--show-current')).toBe('other\n')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
      await rm(hooks, { recursive: true, force: true })
    }
  })

  it('refuses to discard a nested repository before touching anything', async () => {
    const { repositoryPath, repository } = await openCommitFixture('kodi-discard-nested-')
    try {
      await writeFile(join(repositoryPath, 'kept.ts'), 'edited\n', 'utf8')
      const nested = join(repositoryPath, 'nested')
      await mkdir(nested)
      await initRepository(nested)
      await writeFile(join(nested, 'inner.ts'), 'inner\n', 'utf8')
      await commitAll(nested, 'Inner')
      const snapshot = await repository.refresh()
      expect(snapshot.statuses.map((entry) => entry.path)).toEqual(['kept.ts', 'nested/'])

      // `unlink` on the folder used to throw a bare EPERM after `kept.ts` was
      // already restored.
      await expect(repository.discardPaths(['kept.ts', 'nested/'])).rejects.toThrow('nested/ is a separate Git repository.')
      expect(await readFile(join(repositoryPath, 'kept.ts'), 'utf8')).toBe('edited\n')
      expect(await readFile(join(nested, 'inner.ts'), 'utf8')).toBe('inner\n')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('removes an untracked folder entry whole without following a symlink out of it', async () => {
    const { repositoryPath, repository } = await openCommitFixture('kodi-discard-folder-')
    const outside = await mkdtemp(join(tmpdir(), 'kodi-discard-outside-'))
    try {
      await writeFile(join(outside, 'precious.ts'), 'keep me\n', 'utf8')
      const folder = join(repositoryPath, 'folder')
      await mkdir(join(folder, 'deep'), { recursive: true })
      await writeFile(join(folder, 'deep', 'file.ts'), 'temp\n', 'utf8')
      await symlink(outside, join(folder, 'escape'))
      const live = await repository.refresh()
      // The status walk only reports a folder as a whole when it will not
      // descend into it; the entry is planted directly to reach that branch.
      repository.hydrate({ ...live, statuses: [...live.statuses, { path: 'folder/', status: 'untracked' }] })

      await repository.discardPaths(['folder/'])
      await expect(stat(folder)).rejects.toThrow()
      expect(await readFile(join(outside, 'precious.ts'), 'utf8')).toBe('keep me\n')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('keeps the self-write window armed after a commit, not only before it', async () => {
    const { repositoryPath, repository } = await openCommitFixture('kodi-commit-window-')
    const hooks = await mkdtemp(join(tmpdir(), 'kodi-commit-hooks-'))
    try {
      const committed = join(hooks, 'committed')
      await writeFile(join(hooks, 'post-commit'), `#!/bin/sh\ntouch '${committed}'\n`, { mode: 0o755 })
      await runGit(repositoryPath, 'config', 'core.hooksPath', hooks)
      await writeFile(join(repositoryPath, 'kept.ts'), 'two\n', 'utf8')
      await repository.refresh()

      const log: string[] = []
      repository.setSelfWriteObserver(() => { log.push(existsSync(committed) ? 'armed after commit' : 'armed') })
      const refresh = repository.refresh.bind(repository)
      const refreshSpy = spyOn(repository, 'refresh').mockImplementation(() => {
        log.push('refresh')
        return refresh()
      })
      try {
        await repository.commitChanges({ message: 'Update', all: true })
      } finally {
        refreshSpy.mockRestore()
      }

      // A hook that outlasts the one-second window let the index write land
      // unannounced; the refresh re-arming it is too late when it queues.
      expect(log.indexOf('armed after commit')).toBeGreaterThan(-1)
      expect(log.indexOf('armed after commit')).toBeLessThan(log.indexOf('refresh'))
      // `add -A` is armed on both sides too, ahead of the commit's own arming.
      // A slow machine can add heartbeats in between; they only arm it again.
      const beforeCommit = log.slice(0, log.indexOf('armed after commit'))
      expect(beforeCommit.length).toBeGreaterThanOrEqual(3)
      expect(new Set(beforeCommit)).toEqual(new Set(['armed']))
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
      await rm(hooks, { recursive: true, force: true })
    }
  })

  it('treats an empty content search as cancellation before a folder is open', async () => {
    const repository = new RepositoryService()
    expect(await repository.searchContent('')).toEqual([])
  })

  it('trims caches and fully releases repository state on dispose', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-dispose-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'value.ts'), 'export const value = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'value.ts'), 'export const value = 2\n', 'utf8')

      await repository.open(repositoryPath)
      await repository.refresh()
      await repository.getComparison('value.ts')
      expect(repository.getHeadCacheStatsForTests()).toMatchObject({
        entries: 1,
        workingEntries: 1,
        objectReaderSpawns: 1
      })

      repository.trimCaches(0)
      expect(repository.getHeadCacheStatsForTests()).toMatchObject({
        entries: 0,
        bytes: 0,
        workingEntries: 0,
        workingBytes: 0,
        objectReaderSpawns: 1
      })

      await repository.getComparison('value.ts')
      repository.dispose()
      expect(repository.getSessionSnapshot()).toBeNull()
      expect(repository.getHeadCacheStatsForTests()).toEqual({
        entries: 0,
        bytes: 0,
        workingEntries: 0,
        workingBytes: 0,
        objectReaderSpawns: 0
      })

      expect((await repository.open(repositoryPath)).root).toBe(await realpath(repositoryPath))
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('deduplicates overlapping working-tree patches regardless of path order', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-patch-dedupe-'))
    const repository = new RepositoryService()
    const tracePath = join(repositoryPath, 'git-trace.json')
    const previousTrace = process.env.GIT_TRACE2_EVENT
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 1\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 2\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 2\n', 'utf8')
      await repository.open(repositoryPath)
      await repository.refresh()

      process.env.GIT_TRACE2_EVENT = tracePath
      const [first, second] = await Promise.all([
        repository.getWorkingTreePatch(['a.ts', 'b.ts']),
        repository.getWorkingTreePatch(['b.ts', 'a.ts'])
      ])
      expect(second).toEqual(first)

      const events = (await readFile(tracePath, 'utf8')).trim().split('\n')
        .map((line) => JSON.parse(line) as { event?: string; argv?: string[] })
      const diffStarts = events.filter((event) =>
        event.event === 'start' && event.argv?.includes('diff') === true
      )
      expect(diffStarts).toHaveLength(4)
    } finally {
      if (previousTrace == null) delete process.env.GIT_TRACE2_EVENT
      else process.env.GIT_TRACE2_EVENT = previousTrace
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('aborts a working-tree patch superseded by a different path set', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-patch-abort-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 1\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 2\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 2\n', 'utf8')
      await repository.open(repositoryPath)

      const superseded = repository.getWorkingTreePatch(['a.ts'])
      const current = repository.getWorkingTreePatch(['b.ts'])
      await expect(superseded).rejects.toThrow(COMMAND_ABORTED_MESSAGE)
      expect((await current).patch).toContain('export const b = 2')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('emits the first working-tree file before the joined patch resolves', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-patch-first-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 1\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 2\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 2\n', 'utf8')
      await repository.open(repositoryPath)
      await repository.refresh()

      const pages: Array<{ patch: string; omittedFiles: { path: string }[] }> = []
      let resolved = false
      const result = await repository.getWorkingTreePatch(['a.ts', 'b.ts'], (page) => {
        expect(resolved).toBe(false)
        pages.push(page)
      })
      resolved = true

      expect(pages.length).toBeGreaterThanOrEqual(1)
      expect(filesFromPatch(pages[0]!.patch).map((file) => file.path)).toEqual(['a.ts'])
      // The pages carried the whole diff, so the reply does not clone it again.
      expect(result).toEqual({ patch: '', omittedFiles: [] })
      const streamed = pages.map((page) => page.patch).join('\n')
      expect(filesFromPatch(streamed).map((file) => file.path)).toEqual(['a.ts', 'b.ts'])
      expect(streamed).toContain('export const a = 2')
      expect(streamed).toContain('export const b = 2')

      // A caller that did not listen still gets the joined patch.
      const unstreamed = await repository.getWorkingTreePatch(['a.ts', 'b.ts'])
      expect(unstreamed.patch).toBe(streamed)
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('emits an empty untracked first file, then the remaining tracked patch', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-patch-empty-first-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'kept.ts'), 'kept\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'empty-new.ts'), '', 'utf8')
      await writeFile(join(repositoryPath, 'kept.ts'), 'changed\n', 'utf8')
      await repository.open(repositoryPath)
      await repository.refresh()

      const pages: Array<{ patch: string; omittedFiles: { path: string }[] }> = []
      const result = await repository.getWorkingTreePatch(['empty-new.ts', 'kept.ts'], (page) => {
        pages.push(page)
      })
      expect(pages[0]?.patch).toBe(createNewFilePatch('empty-new.ts', ''))
      expect(result.patch).toBe('')
      const streamed = pages.map((page) => page.patch).join('\n')
      expect(streamed).toContain('empty-new.ts')
      expect(streamed).toContain('+changed')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('replays streamed working-tree pages to a second caller of the same path set', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-patch-join-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 1\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 2\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 2\n', 'utf8')
      await repository.open(repositoryPath)
      await repository.refresh()

      const firstPages: Array<{ patch: string }> = []
      const secondPages: Array<{ patch: string }> = []
      const first = repository.getWorkingTreePatch(['a.ts', 'b.ts'], (page) => {
        firstPages.push(page)
      })
      const second = repository.getWorkingTreePatch(['b.ts', 'a.ts'], (page) => {
        secondPages.push(page)
      })
      const [left, right] = await Promise.all([first, second])
      expect(secondPages.length).toBeGreaterThanOrEqual(1)
      expect(filesFromPatch(secondPages[0]!.patch).map((file) => file.path)).toEqual(['a.ts'])
      expect(left).toEqual(right)
      expect(secondPages).toEqual(firstPages)
      expect(left.patch).toBe('')
      expect(filesFromPatch(secondPages.map((page) => page.patch).join('\n')).map((file) => file.path))
        .toEqual(['a.ts', 'b.ts'])
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('diffs a glob-looking working-tree filename as a literal pathspec', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-desk-glob-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, '[test].txt'), 'base\n', 'utf8')
      await commitAll(repositoryPath, 'Base')
      await writeFile(join(repositoryPath, '[test].txt'), 'base\ndesk\n', 'utf8')
      await repository.open(repositoryPath)
      await repository.refresh()

      const patch = await repository.getWorkingTreePatch(['[test].txt'])
      expect(filesFromPatch(patch.patch).map((file) => file.path)).toEqual(['[test].txt'])
      expect(patch.patch).toContain('+desk')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('keeps a working-tree rename as a rename hunk instead of a full-file add', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-desk-rename-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'old.txt'), 'same\n', 'utf8')
      await writeFile(join(repositoryPath, 'kept.txt'), 'kept\n', 'utf8')
      await commitAll(repositoryPath, 'Base')
      await runGit(repositoryPath, 'mv', 'old.txt', 'new.txt')
      await writeFile(join(repositoryPath, 'kept.txt'), 'kept\nchanged\n', 'utf8')
      await repository.open(repositoryPath)
      await repository.refresh()

      const patch = await repository.getWorkingTreePatch(['new.txt', 'kept.txt'])
      expect(patch.patch).toContain('rename from old.txt')
      expect(patch.patch).toContain('rename to new.txt')
      expect(patch.patch).not.toMatch(/^new file mode/m)
      expect(patch.patch).toContain('+changed')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('shares one remotes request for the life of an open repository', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-remotes-cache-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await runGit(repositoryPath, 'remote', 'add', 'origin', 'git@github.com:acme/example.git')
      await repository.open(repositoryPath)

      const [first, second] = await Promise.all([repository.getRemotes(), repository.getRemotes()])
      expect(second).toBe(first)
      expect(first).toEqual([{
        name: 'origin',
        fetchUrl: 'git@github.com:acme/example.git',
        pushUrl: 'git@github.com:acme/example.git'
      }])
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('opens a folder from a shallow listing without waiting on git status', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-open-instant-'))
    const repository = new RepositoryService()
    const refresh = spyOn(repository, 'refresh')
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'readme.md'), 'hello\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'readme.md'), 'hello\nworld\n', 'utf8')

      const snapshot = await repository.open(repositoryPath)

      expect(refresh).not.toHaveBeenCalled()
      expect(snapshot.kind).toBe('git')
      expect(snapshot.paths).toContain('readme.md')
      expect(snapshot.statuses).toEqual([])
    } finally {
      refresh.mockRestore()
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('loads status, file comparisons, and ripgrep content results', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-test-'))

    try {
      await runGit(repositoryPath, 'init', '--quiet')
      await writeFile(join(repositoryPath, 'tracked.txt'), 'original value\n', 'utf8')
      await writeFile(join(repositoryPath, '.gitignore'), '.env\nnode_modules\n', 'utf8')
      await runGit(repositoryPath, 'add', 'tracked.txt', '.gitignore')
      await runGit(
        repositoryPath,
        '-c',
        'user.name=Kodi Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'Initial commit'
      )
      await writeFile(join(repositoryPath, 'tracked.txt'), 'updated searchable value\n', 'utf8')
      await writeFile(join(repositoryPath, 'untracked.txt'), 'another searchable value\n', 'utf8')
      await writeFile(join(repositoryPath, '.env'), 'SECRET=searchable-ignored\n', 'utf8')
      await mkdir(join(repositoryPath, 'node_modules', 'pkg'), { recursive: true })
      await writeFile(join(repositoryPath, 'node_modules', 'pkg', 'index.js'), 'ignored searchable\n', 'utf8')
      await mkdir(join(repositoryPath, '.next'))
      await writeFile(join(repositoryPath, '.next', 'generated.js'), 'generated searchable value\n', 'utf8')

      const repository = new RepositoryService()
      const snapshot = await repository.open(repositoryPath)
      expect(snapshot.kind).toBe('git')
      expect(snapshot.paths).toContain('tracked.txt')
      expect(snapshot.paths).toContain('untracked.txt')
      expect(snapshot.statuses).toEqual([])

      const refreshed = await repository.refresh()
      const comparison = await repository.getComparison('tracked.txt')
      const workingTreePatch = await repository.getWorkingTreePatch(['tracked.txt', 'untracked.txt'])
      const searchResults = await repository.searchContent('searchable')

      expect(refreshed.paths).toEqual(['.env', '.gitignore', 'tracked.txt', 'untracked.txt'])
      expect(refreshed.statuses).toEqual([
        { path: 'tracked.txt', status: 'modified' },
        { path: 'untracked.txt', status: 'untracked' }
      ])
      expect(snapshot.paths).not.toContain('node_modules/pkg/index.js')
      expect(comparison.oldFile?.contents).toBe('original value\n')
      expect(comparison.newFile?.contents).toBe('updated searchable value\n')
      expect(comparison.mode).toBe('diff')
      expect(workingTreePatch.patch).toContain('-original value')
      expect(workingTreePatch.patch).toContain('+updated searchable value')
      expect(workingTreePatch.omittedFiles).toEqual([])
      expect(workingTreePatch.patch).toContain(createNewFilePatch('untracked.txt', 'another searchable value\n'))
      expect(searchResults.map((result) => result.path).sort()).toEqual([
        '.env',
        'tracked.txt',
        'untracked.txt'
      ])
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('renders a submodule as absent instead of a deleted commit object', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-submodule-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'tracked.txt'), 'value\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      const head = (await runGitAllowingDifferences(repositoryPath, 'rev-parse', 'HEAD')).trim()
      await runGit(repositoryPath, 'update-index', '--add', '--cacheinfo', `160000,${head},sub`)
      await commitIndex(repositoryPath, 'Add gitlink')

      const snapshot = await repository.open(repositoryPath)
      expect(snapshot.kind).toBe('git')
      const refreshed = await repository.refresh()
      expect(refreshed.paths).toContain('sub')
      const comparison = await repository.getComparison('sub')
      expect(comparison.oldFile).toBeNull()
      expect(comparison.newFile).toBeNull()
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('opens an unchanged tracked file as a file preview', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-clean-preview-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'README.md'), 'clean repository\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')

      const snapshot = await repository.open(repositoryPath)
      const comparison = await repository.getComparison('README.md')

      expect(snapshot.statuses).toEqual([])
      expect(comparison.mode).toBe('file')
      expect(comparison.status).toBe('unchanged')
      expect(comparison.newFile?.contents).toBe('clean repository\n')

      await repository.refresh()
      const beforeSpawns = repository.getHeadCacheStatsForTests().objectReaderSpawns
      const afterRefresh = await repository.getComparison('README.md')
      expect(afterRefresh.mode).toBe('file')
      expect(afterRefresh.newFile?.contents).toBe('clean repository\n')
      expect(repository.getHeadCacheStatsForTests().objectReaderSpawns).toBe(beforeSpawns)
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('attaches a png preview instead of an empty binary comparison', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-image-preview-'))
    const repository = new RepositoryService()
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'icon.png'), png)
      await repository.open(repositoryPath)
      const comparison = await repository.getComparison('icon.png')

      expect(comparison.binary).toBe(true)
      expect(comparison.newFile).toBeNull()
      expect(comparison.image?.new?.mimeType).toBe('image/png')
      expect(comparison.image?.new?.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
      expect(comparison.image?.old).toBeNull()
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('keeps tracked build output visible and consistent between a commit review files and patch', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-tracked-dist-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'seed.txt'), 'seed\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await mkdir(join(repositoryPath, 'dist'))
      await writeFile(join(repositoryPath, 'dist', 'app.js'), 'console.log(1)\n', 'utf8')
      await commitAll(repositoryPath, 'Ship build output')
      const head = (await runGitAllowingDifferences(repositoryPath, 'rev-parse', 'HEAD')).trim()

      const snapshot = await repository.open(repositoryPath)
      expect(snapshot.kind).toBe('git')
      const refreshed = await repository.refresh()
      expect(refreshed.paths).toContain('dist/app.js')
      const review = await repository.getCommitReview(head)
      expect(review.files.map((file) => file.path)).toEqual(['dist/app.js'])
      expect(review.patch).toContain('dist/app.js')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('keeps a cache key stable across an unrelated commit and a byte-identical rewrite', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-cachekey-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'stable.ts'), 'export const value = 1\n', 'utf8')
      await writeFile(join(repositoryPath, 'other.ts'), 'export const other = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')

      await repository.open(repositoryPath)
      await repository.refresh()
      const before = await repository.getComparison('stable.ts')
      expect(before.mode).toBe('file')
      expect(before.oldFile).toBeNull()

      await writeFile(join(repositoryPath, 'other.ts'), 'export const other = 2\n', 'utf8')
      await commitAll(repositoryPath, 'Touch an unrelated file')
      await repository.refresh()
      const afterCommit = await repository.getComparison('stable.ts')
      expect(afterCommit.oldFile).toBeNull()
      expect(afterCommit.newFile?.cacheKey).toBe(before.newFile?.cacheKey ?? '')

      // A formatter that rewrites identical bytes must not invalidate a draft.
      await writeFile(join(repositoryPath, 'stable.ts'), 'export const value = 1\n', 'utf8')
      await repository.refresh()
      const afterTouch = await repository.getComparison('stable.ts')
      expect(afterTouch.newFile?.cacheKey).toBe(before.newFile?.cacheKey ?? '')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('saves an already-modified file without rebuilding the whole snapshot', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-save-refresh-'))
    const repository = new RepositoryService()
    const selfWrites: string[] = []
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'value.ts'), 'export const value = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'value.ts'), 'export const value = 2\n', 'utf8')

      await repository.open(repositoryPath)
      await repository.refresh()
      repository.setSelfWriteObserver((path) => selfWrites.push(path))
      const before = repository.getSessionSnapshot()
      const comparison = await repository.getComparison('value.ts')

      const saved = await repository.saveWorkingFile({
        path: 'value.ts',
        contents: 'export const value = 3\n',
        expectedCacheKey: comparison.newFile?.cacheKey ?? ''
      })

      expect(saved.newFile?.contents).toBe('export const value = 3\n')
      expect(selfWrites).toEqual(['value.ts'])
      // The file was already modified, so the status did not move and no
      // whole-tree refresh was needed: the snapshot is the very same object.
      expect(repository.getSessionSnapshot()).toBe(before)
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('reads a text file at a commit for review hydration', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-revision-file-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'value.ts'), 'export const value = 1\n', 'utf8')
      await writeFile(join(repositoryPath, 'icon.bin'), Buffer.from([0, 1, 2, 3]))
      await commitAll(repositoryPath, 'Initial commit')
      const head = (await runGitAllowingDifferences(repositoryPath, 'rev-parse', 'HEAD')).trim()
      await writeFile(join(repositoryPath, 'value.ts'), 'export const value = 2\n', 'utf8')

      await repository.open(repositoryPath)
      await repository.refresh()

      expect((await repository.getRevisionFile(head, 'value.ts'))?.contents).toBe('export const value = 1\n')
      expect(await repository.getRevisionFile(head, 'missing.ts')).toBeNull()
      expect(await repository.getRevisionFile(head, 'icon.bin')).toBeNull()
      await expect(repository.getRevisionFile('HEAD', 'value.ts')).rejects.toThrow('revision')
      await expect(repository.getRevisionFile(head, '/etc/passwd')).rejects.toThrow('path')
      expect(await repository.hasRevision(head)).toBe(true)
      expect(await repository.hasRevision('0'.repeat(40))).toBe(false)
      expect(await repository.hasRevision('HEAD')).toBe(false)
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('fetches a pull request head the clone has never seen', async () => {
    const upstreamPath = await mkdtemp(join(tmpdir(), 'kodi-pr-upstream-'))
    const clonePath = await mkdtemp(join(tmpdir(), 'kodi-pr-clone-'))
    const repository = new RepositoryService()
    const url = 'https://github.com/acme/repo/pull/7'
    try {
      await initRepository(upstreamPath)
      await writeFile(join(upstreamPath, 'value.py'), '"""\nDocs.\n"""\nvalue = 1\n', 'utf8')
      await commitAll(upstreamPath, 'Base')
      const base = (await runGitAllowingDifferences(upstreamPath, 'rev-parse', 'HEAD')).trim()
      const branch = (await runGitAllowingDifferences(upstreamPath, 'rev-parse', '--abbrev-ref', 'HEAD')).trim()
      await runGitAllowingDifferences(upstreamPath, 'clone', '--quiet', '--single-branch', '--branch', branch, upstreamPath, clonePath)
      // Pushed after the clone, reachable only from the pull request's ref.
      await writeFile(join(upstreamPath, 'value.py'), '"""\nDocs.\n"""\nvalue = 2\n', 'utf8')
      await commitAll(upstreamPath, 'Head')
      const head = (await runGitAllowingDifferences(upstreamPath, 'rev-parse', 'HEAD')).trim()
      await runGitAllowingDifferences(upstreamPath, 'update-ref', 'refs/pull/7/head', head)
      await runGitAllowingDifferences(upstreamPath, 'reset', '--quiet', '--hard', base)
      // Fetches go to the local upstream; the push URL names the GitHub repository.
      await runGitAllowingDifferences(clonePath, 'remote', 'set-url', '--push', 'origin', 'https://github.com/acme/repo.git')

      await repository.open(clonePath)
      await repository.refresh()
      expect(await repository.hasRevision(head)).toBe(false)

      expect(await repository.ensurePullRequestRevisions(url, base, head)).toBe(true)
      expect((await repository.getRevisionFile(head, 'value.py'))?.contents).toBe('"""\nDocs.\n"""\nvalue = 2\n')
      // Objects only: no branch, no FETCH_HEAD.
      expect(await runGitAllowingDifferences(clonePath, 'for-each-ref', '--format=%(refname)', 'refs/pull')).toBe('')
      expect(existsSync(join(clonePath, '.git', 'FETCH_HEAD'))).toBe(false)
      expect(await repository.ensurePullRequestRevisions('https://github.com/other/repo/pull/7', base, '0'.repeat(40))).toBe(false)
      expect(await repository.ensurePullRequestRevisions(url, base, 'HEAD')).toBe(false)
    } finally {
      repository.dispose()
      await rm(upstreamPath, { recursive: true, force: true })
      await rm(clonePath, { recursive: true, force: true })
    }
  })

  it('updates the status in place when a clean file becomes modified', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-save-status-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 1\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'b.ts'), 'export const b = 2\n', 'utf8')

      await repository.open(repositoryPath)
      const snapshot = await repository.refresh()
      expect(snapshot.statuses).toEqual([{ path: 'b.ts', status: 'modified' }])
      const comparison = await repository.getComparison('a.ts')
      await repository.saveWorkingFile({
        path: 'a.ts',
        contents: 'export const a = 2\n',
        expectedCacheKey: comparison.newFile?.cacheKey ?? ''
      })

      expect(repository.getSessionSnapshot()?.statuses).toEqual([
        { path: 'a.ts', status: 'modified' },
        { path: 'b.ts', status: 'modified' }
      ])
      expect(repository.getSessionSnapshot()?.paths).toEqual(['a.ts', 'b.ts'])
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('saves an editable file and rejects a stale draft without overwriting disk changes', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'kodi-save-test-'))
    const filePath = join(folderPath, 'value.ts')

    try {
      await writeFile(filePath, 'export const value = 1\n', 'utf8')
      const repository = new RepositoryService()
      await repository.open(folderPath)
      const firstComparison = await repository.getComparison('value.ts')

      const savedComparison = await repository.saveWorkingFile({
        path: 'value.ts',
        contents: 'export const value = 2\n',
        expectedCacheKey: firstComparison.newFile!.cacheKey
      })

      expect(await readFile(filePath, 'utf8')).toBe('export const value = 2\n')
      expect(savedComparison.newFile?.contents).toBe('export const value = 2\n')
      expect(savedComparison.newFile?.cacheKey).not.toBe(firstComparison.newFile?.cacheKey)

      await writeFile(filePath, 'export const value = 3\n', 'utf8')
      await expect(repository.saveWorkingFile({
        path: 'value.ts',
        contents: 'export const value = 4\n',
        expectedCacheKey: savedComparison.newFile!.cacheKey
      })).rejects.toThrow('The file changed on disk')
      expect(await readFile(filePath, 'utf8')).toBe('export const value = 3\n')
    } finally {
      await rm(folderPath, { recursive: true, force: true })
    }
  })

  it('omits oversized files from the working tree patch and matches Git for new files', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-cap-test-'))

    try {
      await runGit(repositoryPath, 'init', '--quiet')
      await writeFile(join(repositoryPath, 'generated.txt'), 'first\n', 'utf8')
      await runGit(repositoryPath, 'add', 'generated.txt')
      await runGit(repositoryPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Base')
      await writeFile(
        join(repositoryPath, 'generated.txt'),
        `${Array.from({ length: 25_000 }, (_, index) => `line ${index}`).join('\n')}\n`,
        'utf8'
      )
      await writeFile(join(repositoryPath, 'huge.txt'), 'x'.repeat(3 * 1024 * 1024), 'utf8')
      await writeFile(join(repositoryPath, 'new.txt'), 'added line\n', 'utf8')

      const repository = new RepositoryService()
      await repository.open(repositoryPath)
      await repository.refresh()
      const pages: Array<{ patch: string; omittedFiles: { path: string }[] }> = []
      const workingTreePatch = await repository.getWorkingTreePatch(
        ['generated.txt', 'huge.txt', 'new.txt'],
        (page) => pages.push(page)
      )
      expect(pages[0]?.omittedFiles.map((file) => file.path)).toEqual(['generated.txt'])
      expect(pages[0]?.patch).toBe('')
      const gitNewFilePatch = await runGitAllowingDifferences(
        repositoryPath,
        'diff', '--no-index', '--no-color', '--unified=3', '--', '/dev/null', 'new.txt'
      )

      expect(workingTreePatch.omittedFiles).toEqual([
        { path: 'generated.txt', reason: 'too-large', additions: 25_000, deletions: 1 },
        { path: 'huge.txt', reason: 'too-large', additions: 0, deletions: 0 }
      ])
      expect(workingTreePatch.patch).toBe('')
      const streamed = pages.map((page) => page.patch).join('\n')
      expect(streamed).not.toContain('generated.txt')
      expect(streamed).not.toContain('huge.txt')
      expect(createNewFilePatch('new.txt', 'added line\n')).toBe(
        gitNewFilePatch.split('\n').filter((line) => !line.startsWith('index ')).join('\n')
      )
      expect(streamed).toContain(createNewFilePatch('new.txt', 'added line\n'))
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('opens and searches an ordinary folder without Git metadata', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'kodi-folder-test-'))

    try {
      await mkdir(join(folderPath, 'src'))
      await mkdir(join(folderPath, 'node_modules'))
      await mkdir(join(folderPath, 'dist'))
      await writeFile(join(folderPath, 'README.md'), 'ordinary folder\n', 'utf8')
      await writeFile(join(folderPath, 'src', 'value.ts'), 'export const searchable = true\n', 'utf8')
      await writeFile(join(folderPath, '.gitignore'), '.env\n', 'utf8')
      await writeFile(join(folderPath, '.env'), 'SECRET=searchable-ignored\n', 'utf8')
      await writeFile(join(folderPath, 'node_modules', 'dependency.js'), 'dependency searchable\n', 'utf8')
      await writeFile(join(folderPath, 'dist', 'bundle.js'), 'bundle searchable\n', 'utf8')

      const repository = new RepositoryService()
      const snapshot = await repository.open(folderPath)
      expect(snapshot.kind).toBe('folder')
      expect(snapshot.branch).toBeNull()
      expect(snapshot.paths).toContain('README.md')
      expect(snapshot.paths).toContain('src/value.ts')
      // The listing shows the dotfiles the live snapshot shows, so opening a
      // folder does not have to re-derive the tree once git answers.
      expect(snapshot.paths).toContain('.env')
      expect(snapshot.paths).not.toContain('node_modules/dependency.js')
      expect(snapshot.statuses).toEqual([])

      const refreshed = await repository.refresh()
      const comparison = await repository.getComparison('src/value.ts')
      const searchResults = await repository.searchContent('searchable')

      expect(refreshed.paths).toEqual(['.env', '.gitignore', 'README.md', 'src/value.ts'])
      expect(refreshed.statuses).toEqual([])
      expect(comparison.mode).toBe('file')
      expect(comparison.oldFile).toBeNull()
      expect(comparison.newFile?.contents).toBe('export const searchable = true\n')
      expect(searchResults.map((result) => result.path).sort()).toEqual(['.env', 'src/value.ts'])

      repository.resetContentSearchMetricsForTests()
      const interrupted = repository.searchContent('searchable')
      const replacement = repository.searchContent('ordinary')
      await Promise.allSettled([interrupted, replacement])
      const metrics = repository.getContentSearchMetricsForTests()
      expect(metrics.spawned).toBe(2)
      expect(metrics.cancelled).toBe(1)
      expect(metrics.completed).toBe(2)
      expect(metrics.durationsMs).toHaveLength(1)
    } finally {
      await rm(folderPath, { recursive: true, force: true })
    }
  })

  it('loads local Git history and compares branches without checkout', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-branch-test-'))

    try {
      await runGit(repositoryPath, 'init', '--quiet')
      await runGit(repositoryPath, 'branch', '-M', 'main')
      await writeFile(join(repositoryPath, 'value.txt'), 'base\n', 'utf8')
      await runGit(repositoryPath, 'add', 'value.txt')
      await runGit(repositoryPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Base')
      await runGit(repositoryPath, 'switch', '--quiet', '-c', 'feature')
      await writeFile(join(repositoryPath, 'value.txt'), 'base\nfeature\n', 'utf8')
      await runGit(repositoryPath, 'add', 'value.txt')
      await runGit(repositoryPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'Feature')

      const repository = new RepositoryService()
      await repository.open(repositoryPath)
      const integration = await repository.getGitIntegration()
      const review = await repository.getLocalBranchReview('main', 'feature')
      const commitReview = await repository.getCommitReview(integration.commits[0]!.oid)
      const rootCommitReview = await repository.getCommitReview(integration.commits[1]!.oid)

      expect(integration.defaultBranch).toBe('main')
      expect(integration.commits.map((commit) => commit.subject)).toEqual(['Feature', 'Base'])
      expect(review.kind).toBe('local')
      expect(review.baseOid).toBe(integration.commits[1]!.oid)
      expect(review.headOid).toBe(integration.commits[0]!.oid)
      expect(review.files).toHaveLength(1)
      expect(review.files[0]).toMatchObject({ path: 'value.txt', additions: 1, deletions: 0 })
      expect(review.files[0]?.baseBlobOid).toMatch(/^[0-9a-f]{40}$/)
      expect(review.files[0]?.headBlobOid).toMatch(/^[0-9a-f]{40}$/)
      expect(review.omittedFiles).toEqual([])
      expect(review.patch).toContain('+feature')
      expect(commitReview.title).toContain('Feature')
      expect(commitReview.baseOid).toBe(integration.commits[1]!.oid)
      expect(commitReview.headOid).toBe(integration.commits[0]!.oid)
      expect(commitReview.patch).toContain('+feature')
      expect(rootCommitReview.baseRefName).toBe('Empty tree')
      expect(rootCommitReview.baseOid).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904')
      expect(rootCommitReview.headOid).toBe(integration.commits[1]!.oid)
      expect(rootCommitReview.files).toHaveLength(1)
      expect(rootCommitReview.files[0]).toMatchObject({ path: 'value.txt', additions: 1, deletions: 0 })
      expect(rootCommitReview.files[0]?.headBlobOid).toMatch(/^[0-9a-f]{40}$/)
      expect(rootCommitReview.patch).toContain('+base')
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('emits the first local-branch file before the review promise settles', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-branch-first-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await runGit(repositoryPath, 'branch', '-M', 'main')
      await writeFile(join(repositoryPath, 'a.txt'), 'base-a\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.txt'), 'base-b\n', 'utf8')
      await commitAll(repositoryPath, 'Base')
      await runGit(repositoryPath, 'switch', '--quiet', '-c', 'feature')
      await writeFile(join(repositoryPath, 'a.txt'), 'base-a\nfeature-a\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.txt'), 'base-b\nfeature-b\n', 'utf8')
      await commitAll(repositoryPath, 'Feature')
      await repository.open(repositoryPath)

      const pages: Array<{ kind: string; review?: { files: { path: string }[]; patch: string } }> = []
      let resolved = false
      const review = await repository.getLocalBranchReview('main', 'feature', (progress) => {
        expect(resolved).toBe(false)
        pages.push(progress)
      })
      resolved = true

      expect(pages[0]?.kind).toBe('metadata')
      expect(pages[0]?.review?.files.map((file) => file.path)).toEqual(['a.txt'])
      expect(pages[0]?.review?.patch).toContain('+feature-a')
      expect(pages[0]?.review?.patch).not.toContain('+feature-b')
      expect(review.patch).toBe('')
      expect(review.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt'])
      expect(review.expectedFileCount).toBe(2)
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('emits the first commit file and aborts a superseded local review', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-commit-first-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await runGit(repositoryPath, 'branch', '-M', 'main')
      await writeFile(join(repositoryPath, 'a.txt'), 'base-a\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.txt'), 'base-b\n', 'utf8')
      await commitAll(repositoryPath, 'Base')
      await runGit(repositoryPath, 'switch', '--quiet', '-c', 'feature')
      await writeFile(join(repositoryPath, 'a.txt'), 'base-a\nfeature-a\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.txt'), 'base-b\nfeature-b\n', 'utf8')
      await commitAll(repositoryPath, 'Feature')
      await runGit(repositoryPath, 'switch', '--quiet', '-c', 'other')
      await writeFile(join(repositoryPath, 'a.txt'), 'base-a\nother-a\n', 'utf8')
      await commitAll(repositoryPath, 'Other')
      await repository.open(repositoryPath)
      const integration = await repository.getGitIntegration()
      const featureOid = integration.commits.find((commit) => commit.subject === 'Feature')?.oid
      expect(featureOid).toBeString()

      const superseded = repository.getLocalBranchReview('main', 'feature')
      const pages: Array<{ kind: string }> = []
      const current = repository.getCommitReview(featureOid!, (progress) => {
        pages.push(progress)
      })
      await expect(superseded).rejects.toThrow(COMMAND_ABORTED_MESSAGE)
      const review = await current
      expect(pages[0]?.kind).toBe('metadata')
      expect(review.patch).toBe('')
      expect(review.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt'])
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('keeps a branch rename as a rename hunk instead of a full-file add', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-branch-rename-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await runGit(repositoryPath, 'branch', '-M', 'main')
      await writeFile(join(repositoryPath, 'old.txt'), 'same\n', 'utf8')
      await writeFile(join(repositoryPath, 'kept.txt'), 'kept\n', 'utf8')
      await commitAll(repositoryPath, 'Base')
      await runGit(repositoryPath, 'switch', '--quiet', '-c', 'feature')
      await runGit(repositoryPath, 'mv', 'old.txt', 'new.txt')
      await writeFile(join(repositoryPath, 'kept.txt'), 'kept\nchanged\n', 'utf8')
      await commitAll(repositoryPath, 'Rename')
      await repository.open(repositoryPath)

      const review = await repository.getLocalBranchReview('main', 'feature')
      const renamed = review.files.find((file) => file.path === 'new.txt')
      expect(renamed?.previousPath).toBe('old.txt')
      expect(review.patch).toContain('rename from old.txt')
      expect(review.patch).toContain('rename to new.txt')
      expect(review.patch).not.toMatch(/^new file mode/m)
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('replays streamed pages to a second caller of the same local review', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-branch-join-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await runGit(repositoryPath, 'branch', '-M', 'main')
      await writeFile(join(repositoryPath, 'a.txt'), 'base-a\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.txt'), 'base-b\n', 'utf8')
      await commitAll(repositoryPath, 'Base')
      await runGit(repositoryPath, 'switch', '--quiet', '-c', 'feature')
      await writeFile(join(repositoryPath, 'a.txt'), 'base-a\nfeature-a\n', 'utf8')
      await writeFile(join(repositoryPath, 'b.txt'), 'base-b\nfeature-b\n', 'utf8')
      await commitAll(repositoryPath, 'Feature')
      await repository.open(repositoryPath)

      const firstPages: Array<{ kind: string }> = []
      const secondPages: Array<{ kind: string }> = []
      const first = repository.getLocalBranchReview('main', 'feature', (progress) => {
        firstPages.push(progress)
      })
      const second = repository.getLocalBranchReview('main', 'feature', (progress) => {
        secondPages.push(progress)
      })
      const [left, right] = await Promise.all([first, second])
      expect(secondPages.some((page) => page.kind === 'metadata')).toBe(true)
      expect(left.patch).toBe('')
      expect(right.patch).toBe('')
      expect(left.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt'])
      expect(right.files.map((file) => file.path)).toEqual(['a.txt', 'b.txt'])
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('counts omitted files in expectedFileCount so streamed reviews can finish', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-branch-omit-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await runGit(repositoryPath, 'branch', '-M', 'main')
      await writeFile(join(repositoryPath, 'small.txt'), 'base\n', 'utf8')
      await writeFile(join(repositoryPath, 'huge.txt'), 'base\n', 'utf8')
      await commitAll(repositoryPath, 'Base')
      await runGit(repositoryPath, 'switch', '--quiet', '-c', 'feature')
      await writeFile(join(repositoryPath, 'small.txt'), 'base\nsmall\n', 'utf8')
      await writeFile(
        join(repositoryPath, 'huge.txt'),
        `${'base\n'}${Array.from({ length: 20_001 }, (_unused, index) => `line ${index}`).join('\n')}\n`,
        'utf8'
      )
      await commitAll(repositoryPath, 'Huge')
      await repository.open(repositoryPath)

      let metadataFiles: string[] = []
      const review = await repository.getLocalBranchReview('main', 'feature', (progress) => {
        if (progress.kind === 'metadata') {
          metadataFiles = progress.review.files.map((file) => file.path)
        }
      })
      expect(review.expectedFileCount).toBe(2)
      expect(review.omittedFiles.map((file) => file.path)).toEqual(['huge.txt'])
      expect(metadataFiles).toContain('huge.txt')
      expect(metadataFiles).toContain('small.txt')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('diffs a glob-looking filename as a literal pathspec', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-branch-glob-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await runGit(repositoryPath, 'branch', '-M', 'main')
      await writeFile(join(repositoryPath, '[test].txt'), 'base\n', 'utf8')
      await commitAll(repositoryPath, 'Base')
      await runGit(repositoryPath, 'switch', '--quiet', '-c', 'feature')
      await writeFile(join(repositoryPath, '[test].txt'), 'base\nfeature\n', 'utf8')
      await commitAll(repositoryPath, 'Glob')
      await repository.open(repositoryPath)

      const review = await repository.getLocalBranchReview('main', 'feature')
      expect(review.files.map((file) => file.path)).toEqual(['[test].txt'])
      expect(review.patch).toContain('+feature')
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('shares one git cycle between callers asking for the same state', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-refresh-dedupe-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'tracked.txt'), 'tracked\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await repository.open(repositoryPath)

      const first = repository.refresh()
      const second = repository.refresh()
      expect(second).toBe(first)

      const [left, right] = await Promise.all([first, second])
      expect(left).toBe(right)
      expect(left.statuses).toEqual([])

      // A settled run is not reused, not even by the caller that just awaited it.
      const settled = await repository.refresh()
      const next = repository.refresh()
      expect(next).not.toBe(first)
      expect(await next).not.toBe(settled)
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('does not hand a refresh that started before a write to a caller asking after it', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-refresh-mutation-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'a.ts'), 'export const a = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await repository.open(repositoryPath)
      await repository.refresh()
      const comparison = await repository.getComparison('a.ts')

      const settled: string[] = []
      const started = repository.refresh().then((snapshot) => {
        settled.push('started')
        return snapshot
      })
      await repository.saveWorkingFile({
        path: 'a.ts',
        contents: 'export const a = 2\n',
        expectedCacheKey: comparison.newFile?.cacheKey ?? ''
      })
      const afterWrite = repository.refresh().then((snapshot) => {
        settled.push('after-write')
        return snapshot
      })

      const [before, after] = await Promise.all([started, afterWrite])
      // Chained, not raced: two `git status` runs against one index answer the
      // same thing and cost twice as much.
      expect(settled).toEqual(['started', 'after-write'])
      expect(after).not.toBe(before)
      expect(after.statuses).toEqual([{ path: 'a.ts', status: 'modified' }])
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('runs a fresh cycle for the external change a watcher tick reports', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-refresh-external-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'watched.ts'), 'export const watched = 1\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await repository.open(repositoryPath)
      await repository.refresh()

      const started = repository.refresh()
      // The write the tick is about to report. Nothing here bumps the mutation
      // counter, so without `refreshAfterExternalChange` the call below would
      // join the run above, which read the tree before this line.
      await writeFile(join(repositoryPath, 'watched.ts'), 'export const watched = 2\n', 'utf8')
      const afterTick = repository.refreshAfterExternalChange()
      expect(afterTick).not.toBe(started)

      const settled: string[] = []
      const [before, after] = await Promise.all([
        started.then((snapshot) => {
          settled.push('started')
          return snapshot
        }),
        afterTick.then((snapshot) => {
          settled.push('after-tick')
          return snapshot
        })
      ])

      expect(settled).toEqual(['started', 'after-tick'])
      expect(after).not.toBe(before)
      expect(after.statuses).toEqual([{ path: 'watched.ts', status: 'modified' }])
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('refreshes without rewriting the index, and announces the write it might still make', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-refresh-locks-'))
    const repository = new RepositoryService()
    const selfWrites: string[] = []
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'tracked.txt'), 'tracked\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, 'tracked.txt'), 'edited\n', 'utf8')
      await repository.open(repositoryPath)
      repository.setSelfWriteObserver((path) => selfWrites.push(path))

      const indexPath = join(repositoryPath, '.git', 'index')
      const before = await stat(indexPath)
      const refreshed = await repository.refresh()
      const after = await stat(indexPath)

      expect(refreshed.statuses).toEqual([{ path: 'tracked.txt', status: 'modified' }])
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(selfWrites).toEqual(['.git/index', '.git/index'])
    } finally {
      repository.setSelfWriteObserver(null)
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('lists gitignored files without walking excluded directories, and re-lists them on the next refresh', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-ignored-refresh-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, '.gitignore'), '.env\nnode_modules/\nlogs/\n*.pyc\n', 'utf8')
      await writeFile(join(repositoryPath, 'tracked.txt'), 'tracked\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(repositoryPath, '.env'), 'SECRET=1\n', 'utf8')
      await mkdir(join(repositoryPath, 'logs'), { recursive: true })
      await writeFile(join(repositoryPath, 'logs', 'today.log'), 'entry\n', 'utf8')
      await writeFile(join(repositoryPath, 'logs', 'stale.pyc'), 'bytecode\n', 'utf8')
      await mkdir(join(repositoryPath, 'node_modules', 'pkg'), { recursive: true })
      await writeFile(join(repositoryPath, 'node_modules', 'pkg', 'index.js'), 'pkg\n', 'utf8')

      await repository.open(repositoryPath)
      const first = await repository.refresh()
      expect(first.paths).toEqual(['.env', '.gitignore', 'logs/today.log', 'tracked.txt'])

      await writeFile(join(repositoryPath, 'logs', 'yesterday.log'), 'entry\n', 'utf8')
      const second = await repository.refresh()

      expect(second.paths).toEqual([
        '.env', '.gitignore', 'logs/today.log', 'logs/yesterday.log', 'tracked.txt'
      ])
    } finally {
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('drops a gitignored set that lands after a newer refresh replaced its run', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-ignored-stale-'))
    const repository = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, '.gitignore'), 'logs/\n', 'utf8')
      await writeFile(join(repositoryPath, 'tracked.txt'), 'tracked\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await mkdir(join(repositoryPath, 'logs'), { recursive: true })
      await writeFile(join(repositoryPath, 'logs', 'today.log'), 'entry\n', 'utf8')

      await repository.open(repositoryPath)
      const published: string[][] = []
      repository.setSnapshotObserver((snapshot) => published.push(snapshot.paths))
      const refreshed = await repository.refresh()
      expect(refreshed.paths).toContain('logs/today.log')

      // Cancelling a walk only takes effect on its next directory, so the run a
      // newer refresh replaced can still resolve with paths that are already out
      // of date.
      repository.mergeIgnoredPathsForTests(['logs/superseded.log'], 'superseded')

      expect(published).toEqual([])
      expect(repository.getSessionSnapshot()?.paths).toBe(refreshed.paths)

      repository.mergeIgnoredPathsForTests(['logs/late.log'], 'current')

      expect(published).toEqual([['.gitignore', 'logs/late.log', 'tracked.txt']])
      expect(repository.getSessionSnapshot()?.paths).toEqual(['.gitignore', 'logs/late.log', 'tracked.txt'])
    } finally {
      repository.setSnapshotObserver(null)
      repository.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('marks the opening listing as a skeleton and every refreshed snapshot as live', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-snapshot-stage-'))
    const folderPath = await mkdtemp(join(tmpdir(), 'kodi-snapshot-stage-folder-'))
    const repository = new RepositoryService()
    const folder = new RepositoryService()
    try {
      await initRepository(repositoryPath)
      await writeFile(join(repositoryPath, 'tracked.txt'), 'tracked\n', 'utf8')
      await commitAll(repositoryPath, 'Initial commit')
      await writeFile(join(folderPath, 'notes.md'), '# notes\n', 'utf8')

      // The renderer re-derives the workspace view when a snapshot goes from the
      // bounded listing to the git answer, so the two have to be distinguishable.
      expect((await repository.open(repositoryPath)).stage).toBe('skeleton')
      expect((await repository.refresh()).stage).toBe('live')
      expect((await folder.open(folderPath)).stage).toBe('skeleton')
      expect((await folder.refresh()).stage).toBe('live')
    } finally {
      repository.dispose()
      folder.dispose()
      await rm(repositoryPath, { recursive: true, force: true })
      await rm(folderPath, { recursive: true, force: true })
    }
  })

  it('opens an empty ordinary folder', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'kodi-empty-folder-test-'))

    try {
      const repository = new RepositoryService()
      const snapshot = await repository.open(folderPath)

      expect(snapshot.kind).toBe('folder')
      expect(snapshot.paths).toEqual([])
    } finally {
      await rm(folderPath, { recursive: true, force: true })
    }
  })
})

describe('parsePullRequestConversation', () => {
  const payload = {
    data: {
      repository: {
        pullRequest: {
          body: 'Adds the review inbox.',
          headRefOid: 'f'.repeat(40),
          reviewThreads: {
            nodes: [
              {
                id: 'thread-1',
                isResolved: false,
                isOutdated: false,
                path: 'src/app.ts',
                line: 12,
                startLine: 10,
                originalLine: 12,
                originalStartLine: 10,
                diffSide: 'RIGHT',
                comments: {
                  nodes: [
                    { id: 'comment-1', body: 'Rename this.', diffHunk: '@@ -9,4 +9,5 @@\n const a = 1', author: { login: 'Reviewer', avatarUrl: 'https://avatars.example/r.png' }, createdAt: '2026-08-17T10:00:00Z' }
                  ]
                }
              },
              {
                id: 'thread-2',
                isResolved: true,
                isOutdated: true,
                path: 'src/old.ts',
                line: null,
                startLine: null,
                originalLine: 40,
                originalStartLine: null,
                diffSide: 'LEFT',
                comments: { nodes: [] }
              }
            ]
          },
          reviews: {
            nodes: [
              { id: 'review-1', state: 'CHANGES_REQUESTED', body: 'Almost.', author: { login: 'Reviewer', avatarUrl: 'https://avatars.example/r.png' }, submittedAt: '2026-08-17T10:05:00Z' }
            ]
          }
        }
      }
    }
  }

  it('reads the description, threads, and submitted reviews', () => {
    const conversation = parsePullRequestConversation(payload)
    expect(conversation.body).toBe('Adds the review inbox.')
    expect(conversation.headOid).toBe('f'.repeat(40))
    expect(conversation.threads).toEqual([
      {
        id: 'thread-1',
        path: 'src/app.ts',
        line: 12,
        startLine: 10,
        originalLine: 12,
        originalStartLine: 10,
        diffHunk: '@@ -9,4 +9,5 @@\n const a = 1',
        side: 'RIGHT',
        resolved: false,
        outdated: false,
        comments: [
          { id: 'comment-1', body: 'Rename this.', authorLogin: 'Reviewer', authorAvatarUrl: 'https://avatars.example/r.png', createdAt: '2026-08-17T10:00:00Z' }
        ]
      },
      {
        // An outdated thread has no position on the current diff; where it was
        // written is the only address it still has.
        id: 'thread-2',
        path: 'src/old.ts',
        line: null,
        startLine: null,
        originalLine: 40,
        originalStartLine: null,
        diffHunk: '',
        side: 'LEFT',
        resolved: true,
        outdated: true,
        comments: []
      }
    ])
    expect(conversation.reviews).toEqual([
      { id: 'review-1', state: 'CHANGES_REQUESTED', body: 'Almost.', authorLogin: 'Reviewer', authorAvatarUrl: 'https://avatars.example/r.png', submittedAt: '2026-08-17T10:05:00Z' }
    ])
  })

  it('returns empty results for absent or malformed payloads', () => {
    expect(parsePullRequestConversation(null)).toEqual({ body: '', headOid: '', threads: [], reviews: [] })
    expect(parsePullRequestConversation({ data: {} })).toEqual({ body: '', headOid: '', threads: [], reviews: [] })
    expect(parsePullRequestConversation({ data: { repository: { pullRequest: {} } } }))
      .toEqual({ body: '', headOid: '', threads: [], reviews: [] })
  })

  it('drops threads and comments that cannot be addressed', () => {
    const conversation = parsePullRequestConversation({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                { id: '', path: 'src/a.ts', comments: { nodes: [] } },
                { id: 'thread-3', path: '', comments: { nodes: [] } },
                null,
                {
                  id: 'thread-4',
                  path: 'src/a.ts',
                  diffSide: 'UNKNOWN',
                  comments: { nodes: [{ id: '', body: 'dropped' }, { id: 'comment-2', body: 'kept' }] }
                }
              ]
            }
          }
        }
      }
    })
    expect(conversation.threads).toHaveLength(1)
    expect(conversation.threads[0]?.id).toBe('thread-4')
    expect(conversation.threads[0]?.side).toBe('RIGHT')
    expect(conversation.threads[0]?.comments.map((comment) => comment.id)).toEqual(['comment-2'])
  })
})

describe('readGitObject', () => {
  async function commitFile(repositoryPath: string, name: string, contents: string | Buffer): Promise<void> {
    await writeFile(join(repositoryPath, name), contents)
    await runGit(repositoryPath, 'add', name)
    await runGit(
      repositoryPath,
      '-c', 'user.name=Kodi Test',
      '-c', 'user.email=test@example.invalid',
      'commit', '--quiet', '-m', `add ${name}`
    )
  }

  it('returns a committed blob in a single git invocation', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-catfile-'))
    try {
      await runGit(repositoryPath, 'init', '--quiet')
      await commitFile(repositoryPath, 'tracked.txt', 'first line\nsecond line\n')

      const read = await readGitObject(repositoryPath, 'HEAD:tracked.txt')
      expect(read.missing).toBe(false)
      expect(read.oversized).toBe(false)
      expect(read.contents?.toString('utf8')).toBe('first line\nsecond line\n')
      expect(read.size).toBe(23)
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('reports a path that is absent from the commit as missing', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-catfile-'))
    try {
      await runGit(repositoryPath, 'init', '--quiet')
      await commitFile(repositoryPath, 'tracked.txt', 'value\n')

      const read = await readGitObject(repositoryPath, 'HEAD:absent.txt')
      expect(read.missing).toBe(true)
      expect(read.contents).toBeNull()
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('abandons a blob larger than the diff cap without reading its contents', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-catfile-'))
    try {
      await runGit(repositoryPath, 'init', '--quiet')
      // Comfortably past the 2 MB cap, and incompressible enough that git stores it as is.
      await commitFile(repositoryPath, 'big.bin', Buffer.alloc(3 * 1024 * 1024, 'abcdefgh'))

      const read = await readGitObject(repositoryPath, 'HEAD:big.bin')
      expect(read.oversized).toBe(true)
      expect(read.missing).toBe(false)
      expect(read.contents).toBeNull()
      expect(read.size).toBe(3 * 1024 * 1024)
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('reads an empty blob as empty rather than missing', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-catfile-'))
    try {
      await runGit(repositoryPath, 'init', '--quiet')
      await commitFile(repositoryPath, 'empty.txt', '')

      const read = await readGitObject(repositoryPath, 'HEAD:empty.txt')
      expect(read.missing).toBe(false)
      expect(read.size).toBe(0)
      expect(read.contents?.length).toBe(0)
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })
})

describe('parsePorcelainV2Status against real git output', () => {
  it('reads every status kind, the branch, and the untracked set from one call', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-v2-'))
    try {
      await runGit(repositoryPath, 'init', '--quiet')
      const commit = (message: string): Promise<void> => runGit(
        repositoryPath,
        '-c', 'user.name=Kodi Test',
        '-c', 'user.email=test@example.invalid',
        'commit', '--quiet', '-m', message
      )
      await writeFile(join(repositoryPath, 'mod.ts'), 'first\n', 'utf8')
      await writeFile(join(repositoryPath, 'del.ts'), 'gone\n', 'utf8')
      await writeFile(join(repositoryPath, 'ren-old.ts'), 'moved\n', 'utf8')
      await writeFile(join(repositoryPath, 'with space.ts'), 'kept\n', 'utf8')
      await runGit(repositoryPath, 'add', '-A')
      await commit('init')

      await writeFile(join(repositoryPath, 'mod.ts'), 'second\n', 'utf8')
      await rm(join(repositoryPath, 'del.ts'))
      await runGit(repositoryPath, 'mv', 'ren-old.ts', 'ren-new.ts')
      await writeFile(join(repositoryPath, 'untracked.ts'), 'new\n', 'utf8')
      await writeFile(join(repositoryPath, 'staged.ts'), 'staged\n', 'utf8')
      await runGit(repositoryPath, 'add', 'staged.ts')

      const raw = (await executeFile(
        'git',
        ['-C', repositoryPath, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
        { encoding: 'buffer' }
      )).stdout as unknown as Buffer
      const status = parsePorcelainV2Status(raw)

      expect(status.branch).not.toBeNull()
      expect(status.head).toMatch(/^[0-9a-f]{40}$/)
      expect(status.untrackedPaths).toEqual(['untracked.ts'])

      const byPath = new Map(status.statuses.map((entry) => [entry.path, entry]))
      expect(byPath.get('mod.ts')?.status).toBe('modified')
      expect(byPath.get('del.ts')?.status).toBe('deleted')
      expect(byPath.get('staged.ts')?.status).toBe('added')
      expect(byPath.get('untracked.ts')?.status).toBe('untracked')
      expect(byPath.get('ren-new.ts')).toEqual({
        path: 'ren-new.ts',
        previousPath: 'ren-old.ts',
        status: 'renamed',
        staged: 'all'
      })
      expect(byPath.get('mod.ts')?.staged).toBeUndefined()
      expect(byPath.get('staged.ts')?.staged).toBe('all')
      // An unchanged tracked file must not be reported at all.
      expect(byPath.has('with space.ts')).toBe(false)
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })

  it('reports a conflicted file as conflicted', async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), 'kodi-v2-conflict-'))
    try {
      const git = (...args: string[]): Promise<void> => runGit(
        repositoryPath,
        '-c', 'user.name=Kodi Test',
        '-c', 'user.email=test@example.invalid',
        ...args
      )
      await runGit(repositoryPath, 'init', '--quiet')
      await writeFile(join(repositoryPath, 'both.ts'), 'base\n', 'utf8')
      await runGit(repositoryPath, 'add', 'both.ts')
      await git('commit', '--quiet', '-m', 'base')

      await runGit(repositoryPath, 'checkout', '--quiet', '-b', 'other')
      await writeFile(join(repositoryPath, 'both.ts'), 'other side\n', 'utf8')
      await runGit(repositoryPath, 'add', 'both.ts')
      await git('commit', '--quiet', '-m', 'other')

      await runGitAllowingDifferences(repositoryPath, 'checkout', '--quiet', '-')
      await writeFile(join(repositoryPath, 'both.ts'), 'first side\n', 'utf8')
      await runGit(repositoryPath, 'add', 'both.ts')
      await git('commit', '--quiet', '-m', 'first')
      await runGitAllowingDifferences(repositoryPath, 'merge', 'other')

      const raw = (await executeFile(
        'git',
        ['-C', repositoryPath, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
        { encoding: 'buffer' }
      )).stdout as unknown as Buffer
      const status = parsePorcelainV2Status(raw)
      expect(status.statuses.find((entry) => entry.path === 'both.ts')?.status).toBe('conflicted')
    } finally {
      await rm(repositoryPath, { recursive: true, force: true })
    }
  })
})

describe('parsePullRequestInboxResponse', () => {
  const node = (number: number, login = 'octocat'): Record<string, unknown> => ({
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    updatedAt: '2026-08-18T00:00:00Z',
    author: { login }
  })

  it('reads every aliased search into its section', () => {
    const entries = parsePullRequestInboxResponse({
      data: {
        reviewRequested: { nodes: [node(1)] },
        assigned: { nodes: [node(2)] },
        mentioned: { nodes: [node(3)] },
        authored: { nodes: [node(4)] }
      }
    })
    expect(entries.map((entry) => entry.key)).toEqual([
      'review-requested', 'assigned', 'mentioned', 'authored'
    ])
  })

  // GraphQL returns the enum spelling; the renderer contract is lowercase.
  it('lowercases the state so the contract matches the old search output', () => {
    const [entry] = parsePullRequestInboxResponse({ data: { assigned: { nodes: [node(7)] } } })
    expect((entry?.pullRequest as { state?: unknown } | undefined)?.state).toBe('open')
  })

  it('survives missing sections, non-array nodes, and non-object entries', () => {
    expect(parsePullRequestInboxResponse({ data: { assigned: { nodes: 'nope' } } })).toEqual([])
    expect(parsePullRequestInboxResponse({ data: { assigned: { nodes: [null, 3] } } })).toEqual([])
    expect(parsePullRequestInboxResponse({})).toEqual([])
    expect(parsePullRequestInboxResponse(null)).toEqual([])
  })

  it('feeds sectionPullRequestInbox so a pull request lands in one section only', () => {
    const sections = sectionPullRequestInbox(parsePullRequestInboxResponse({
      data: {
        reviewRequested: { nodes: [node(9)] },
        assigned: { nodes: [node(9)] }
      }
    }))
    expect(sections.find((section) => section.key === 'review-requested')?.pullRequests).toHaveLength(1)
    expect(sections.find((section) => section.key === 'assigned')?.pullRequests).toHaveLength(0)
  })
})

describe('pullRequestInboxVariables', () => {
  it('shares one base across every section query', () => {
    expect(pullRequestInboxVariables('is:pr is:open repo:acme/core repo:zeta/app', 'octocat')).toEqual({
      reviewRequested: 'is:pr is:open repo:acme/core repo:zeta/app review-requested:octocat',
      assigned: 'is:pr is:open repo:acme/core repo:zeta/app assignee:octocat',
      mentioned: 'is:pr is:open repo:acme/core repo:zeta/app mentions:octocat',
      authored: 'is:pr is:open repo:acme/core repo:zeta/app author:octocat'
    })
  })
})

describe('RepositoryService.hydrate', () => {
  it('opens a cached file from disk without waiting on git', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'kodi-hydrate-')))
    const repository = new RepositoryService()
    try {
      await writeFile(join(root, 'readme.md'), 'hello from cache\n', 'utf8')
      const snapshot = {
        root,
        name: 'cached',
        kind: 'folder' as const,
        branch: null,
        head: null,
        paths: ['readme.md'],
        statuses: []
      }
      expect(repository.hydrate(snapshot)).toEqual(snapshot)
      expect(repository.getSessionSnapshot()).toEqual(snapshot)
      const comparison = await repository.getComparison('readme.md')
      expect(comparison.newFile?.contents).toBe('hello from cache\n')
      expect(comparison.mode).toBe('file')
    } finally {
      repository.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('opens a vanished cached path as an empty file and names a path that was never listed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-hydrate-missing-'))
    const repository = new RepositoryService()
    try {
      repository.hydrate({
        root,
        name: 'cached',
        kind: 'folder',
        branch: null,
        head: null,
        paths: ['gone.ts'],
        statuses: []
      })
      const vanished = await repository.getComparison('gone.ts')
      expect(vanished.newFile).toBeNull()
      await expect(repository.getComparison('never.ts')).rejects.toThrow('never.ts')
    } finally {
      repository.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('RepositoryService.open', () => {
  it('resolves the path once when the caller has already resolved it', async () => {
    const folderPath = await mkdtemp(join(tmpdir(), 'kodi-open-resolved-'))
    const resolvedPath = await realpath(folderPath)
    // macOS hands out symlinked temp roots, so an unresolved path is a different
    // string from its realpath and the two cases are distinguishable.
    expect(resolvedPath).not.toBe(folderPath)
    const resolving = new RepositoryService()
    const preResolved = new RepositoryService()
    try {
      expect((await resolving.open(folderPath)).root).toBe(resolvedPath)
      expect((await preResolved.open(folderPath, true)).root).toBe(folderPath)
    } finally {
      resolving.dispose()
      preResolved.dispose()
      await rm(folderPath, { recursive: true, force: true })
    }
  })
})

describe('pull request command lane', () => {
  it('sends warmup hops to the background lane and reader hops to the interactive one', () => {
    expect(pullRequestReviewLane('warmup')).toBe('background')
    expect(pullRequestReviewLane('foreground')).toBe('interactive')
  })

  // The retry loop around every `gh` read is the one place a lane can be dropped
  // on the floor, so it is checked against the real semaphore rather than a stub.
  it('queues a background gh read behind a saturated background lane', async () => {
    const releases: Array<() => void> = []
    for (let slot = 0; slot < MAX_BACKGROUND_COMMANDS; slot += 1) {
      releases.push(await commandSemaphore.acquire('background'))
    }
    try {
      let backgroundDone = false
      const background = runGitHubReadCommand('/bin/echo', ['warm'], process.cwd(), undefined, 'background')
        .then((result) => {
          backgroundDone = true
          return result
        })
      // An interactive read still has slots, so it overtakes the queued one.
      const interactive = await runGitHubReadCommand('/bin/echo', ['read'], process.cwd())
      expect(interactive.stdout.toString('utf8').trim()).toBe('read')
      expect(backgroundDone).toBe(false)
      expect(commandSemaphore.waiting).toBe(1)

      for (const release of releases.splice(0)) release()
      expect((await background).stdout.toString('utf8').trim()).toBe('warm')
    } finally {
      for (const release of releases) release()
    }
  })
})
