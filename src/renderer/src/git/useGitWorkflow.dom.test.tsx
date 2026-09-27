import { afterEach, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'

import {
  COMMAND_ABORTED_MESSAGE,
  type GitIntegrationSnapshot,
  type LocalBranchReview,
  type LocalReviewProgress,
  type PullRequestReview,
  type PullRequestReviewProgress,
  type RepositoryApi,
  type RepositoryPullRequests,
  type RepositorySnapshot
} from '../../../shared/contracts'
import { useGitWorkflow } from './useGitWorkflow'

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete window.repository
})

function deferred<Value>(): {
  promise: Promise<Value>
  resolve(value: Value): void
  reject(error: unknown): void
} {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

function review(number: number): PullRequestReview {
  return {
    kind: 'github',
    selector: String(number),
    baseOid: 'b'.repeat(40),
    headOid: String(number).repeat(40),
    commitId: String(number).repeat(40),
    viewerCanSubmitDecision: true,
    pullRequest: {
      number,
      title: `Review ${number}`,
      state: 'OPEN',
      isDraft: false,
      reviewDecision: null,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      author: { login: 'reviewer' },
      baseRefName: 'main',
      headRefName: `feature-${number}`,
      updatedAt: '2026-08-26T00:00:00Z',
      url: `https://github.com/example/repo/pull/${number}`
    },
    files: [{ path: `file-${number}.ts`, additions: 1, deletions: 0 }],
    patch: '',
    omittedFiles: [],
    expectedFileCount: 1
  }
}

const repositorySnapshot: RepositorySnapshot = {
  root: '/repo',
  name: 'repo',
  kind: 'git',
  branch: 'main',
  head: 'desk-head',
  paths: ['desk.ts'],
  statuses: []
}

function workflowOptions() {
  return {
    snapshot: repositorySnapshot,
    selectedPath: 'desk.ts',
    workspaceView: 'multi' as const,
    applySnapshot: () => {},
    activateSnapshot: () => {},
    onError: () => {},
    onSelectPath: () => {},
    onWorkspaceViewChange: () => {},
    confirm: async () => true
  }
}

test('simultaneous pull-request requests keep independent tabs', async () => {
  const first = deferred<PullRequestReview>()
  const second = deferred<PullRequestReview>()
  const getPullRequestReview = mock((_root: string, selector: number | string) =>
    selector === 1 ? first.promise : second.promise)
  window.repository = {
    getPullRequestReview,
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  let firstRequest!: Promise<boolean>
  let secondRequest!: Promise<boolean>
  act(() => {
    firstRequest = result.current.openPullRequestReview(1)
    secondRequest = result.current.openPullRequestReview(2)
  })
  await waitFor(() => expect(result.current.actionKey).toBe('review:2'))
  first.resolve(review(1))
  await act(() => firstRequest)
  expect(result.current.repositoryReview?.kind === 'github'
    ? result.current.repositoryReview.pullRequest.number
    : null).toBe(1)
  expect(result.current.actionKey).toBe('review:2')

  second.resolve(review(2))
  await act(() => secondRequest)
  expect(result.current.repositoryReview?.kind).toBe('github')
  expect(result.current.repositoryReview?.kind === 'github'
    ? result.current.repositoryReview.pullRequest.number
    : null).toBe(1)
  expect(result.current.worlds.filter((world) => world.source === 'patch')).toHaveLength(2)
  expect(result.current.worlds.some((world) => world.source === 'patch'
    && world.review.kind === 'github'
    && world.review.pullRequest.number === 2)).toBe(true)
  expect(result.current.actionKey).toBeNull()
})

test('a rejected load for a background world does not raise the global error', async () => {
  const pending = deferred<PullRequestReview>()
  const errors: Array<string | null> = []
  const onError = (message: string | null): void => { errors.push(message) }
  let progressListener: ((progress: PullRequestReviewProgress) => void) | null = null
  let requestId = ''
  window.repository = {
    getPullRequestReview: (_root: string, _selector: number | string, nextRequestId: string) => {
      requestId = nextRequestId
      return pending.promise
    },
    activateRepository: async () => repositorySnapshot,
    releaseRepository: async () => {},
    onPullRequestReviewProgress: (listener: (progress: PullRequestReviewProgress) => void) => {
      progressListener = listener
      return () => { progressListener = null }
    }
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow({ ...workflowOptions(), onError }))
  const metadataReview = { ...review(9), files: [], patch: '' }

  let request!: Promise<boolean>
  act(() => { request = result.current.openPullRequestReview(9) })
  act(() => progressListener?.({
    kind: 'metadata', selector: '9', review: metadataReview, root: '/repo', requestId
  }))
  await waitFor(() => expect(result.current.activeWorld?.source).toBe('patch'))
  const patchWorldId = result.current.activeWorld?.worldId
  const deskWorldId = result.current.worlds.find((world) => world.source === 'desk')?.worldId
  await act(() => result.current.focusWorld(deskWorldId!))

  pending.reject(new Error('boom'))
  await act(() => request)

  expect(errors.some((message) => message != null)).toBe(false)
  const patchWorld = result.current.worlds.find((world) => world.worldId === patchWorldId)
  expect(patchWorld?.source === 'patch' ? patchWorld.loadStatus : null).toBe('error')
  expect(patchWorld?.source === 'patch' ? patchWorld.errorMessage : null).toBe('boom')
})

test('a PR stream keeps updating its world after the user returns to Desk', async () => {
  const pending = deferred<PullRequestReview>()
  let progressListener: ((progress: PullRequestReviewProgress) => void) | null = null
  let requestId = ''
  window.repository = {
    getPullRequestReview: (_root: string, _selector: number | string, nextRequestId: string) => {
      requestId = nextRequestId
      return pending.promise
    },
    activateRepository: async () => repositorySnapshot,
    releaseRepository: async () => {},
    onPullRequestReviewProgress: (listener: (progress: PullRequestReviewProgress) => void) => {
      progressListener = listener
      return () => { progressListener = null }
    }
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))
  const finalReview = review(3)
  const metadataReview = { ...finalReview, files: [], patch: '' }

  let request!: Promise<boolean>
  act(() => { request = result.current.openPullRequestReview(3) })
  act(() => progressListener?.({
    kind: 'metadata', selector: '3', review: metadataReview, root: '/repo', requestId
  }))
  await waitFor(() => expect(result.current.worlds).toHaveLength(2))
  const patchWorldId = result.current.activeWorld?.worldId
  const deskWorldId = result.current.worlds.find((world) => world.source === 'desk')?.worldId
  expect(patchWorldId).toBeTruthy()
  expect(deskWorldId).toBeTruthy()

  await act(() => result.current.focusWorld(deskWorldId!))
  act(() => progressListener?.({
    kind: 'files',
    selector: '3',
    files: finalReview.files,
    patch: finalReview.patch,
    omittedFiles: [],
    root: '/repo',
    requestId
  }))
  pending.resolve(finalReview)
  await act(() => request)

  expect(result.current.activeWorld?.source).toBe('desk')
  const patchWorld = result.current.worlds.find((world) => world.worldId === patchWorldId)
  expect(patchWorld?.source === 'patch' ? patchWorld.review.files : []).toEqual(finalReview.files)
  expect(patchWorld?.source === 'patch' ? patchWorld.loadStatus : null).toBe('ready')
})

test('closing a loading New tab cancels its request and releases its unused checkout', async () => {
  const pending = deferred<PullRequestReview>()
  const otherSnapshot = { ...repositorySnapshot, root: '/other-repo', name: 'other-repo' }
  const cancelPullRequestReview = mock(() => {})
  const releaseRepository = mock(async () => {})
  window.repository = {
    resolvePullRequestRepository: async () => otherSnapshot,
    getPullRequestReview: () => pending.promise,
    cancelPullRequestReview,
    activateRepository: async (root: string) => root === otherSnapshot.root ? otherSnapshot : repositorySnapshot,
    releaseRepository,
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  act(() => { result.current.openNewWorld() })
  let request!: Promise<boolean>
  act(() => { request = result.current.openPullRequestFromLocator(review(6).pullRequest.url) })
  await waitFor(() => expect(result.current.activeWorld?.source).toBe('new'))
  await waitFor(() => expect(result.current.activeWorld?.source === 'new'
    ? result.current.activeWorld.pending
    : false).toBe(true))

  act(() => { result.current.closeReview() })
  await waitFor(() => expect(result.current.activeWorld?.source).toBe('desk'))
  pending.resolve({
    ...review(6),
    pullRequest: { ...review(6).pullRequest, url: 'https://github.com/other/repo/pull/6' }
  })
  await act(() => request)

  expect(cancelPullRequestReview).toHaveBeenCalledTimes(1)
  expect(releaseRepository).toHaveBeenCalledWith('/other-repo')
  expect(result.current.worlds.some((world) => world.source === 'patch')).toBe(false)
})

test('opening a pull request from a New tab uses the chosen project folder', async () => {
  const resolvePullRequestRepository = mock(async (
    _url: string,
    _preferredRoot?: string | null
  ) => repositorySnapshot)
  window.repository = {
    resolvePullRequestRepository,
    getPullRequestReview: async () => review(9),
    activateRepository: async () => repositorySnapshot,
    releaseRepository: async () => {},
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  act(() => { result.current.openNewWorld() })
  act(() => { result.current.updateNewWorldRepositoryRoot('/Users/me/Developer/app') })
  await act(() => result.current.openPullRequestFromLocator(review(9).pullRequest.url))

  expect(resolvePullRequestRepository).toHaveBeenCalledWith(
    review(9).pullRequest.url,
    '/Users/me/Developer/app'
  )
})

test('reopening a pull request whose head moved keeps one tab', async () => {
  const moved: PullRequestReview = {
    ...review(5),
    baseOid: 'b2'.repeat(20),
    headOid: 'h2'.repeat(20),
    commitId: 'h2'.repeat(20)
  }
  let next = review(5)
  window.repository = {
    getPullRequestReview: async () => next,
    activateRepository: async () => repositorySnapshot,
    releaseRepository: async () => {},
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  await act(() => result.current.openPullRequestReview(5))
  const originalWorldId = result.current.activeWorld?.worldId
  expect(result.current.worlds.filter((world) => world.source === 'patch')).toHaveLength(1)

  next = moved
  await act(() => result.current.openPullRequestReview(5))

  const patchWorlds = result.current.worlds.filter((world) => world.source === 'patch')
  expect(patchWorlds).toHaveLength(1)
  expect(patchWorlds[0]?.worldId).not.toBe(originalWorldId)
  expect(result.current.activeWorld?.worldId).toBe(patchWorlds[0]?.worldId)
})

test('the git snapshot behind a skeleton open re-derives the desk view and file', async () => {
  const selected: (string | null)[] = []
  const views: string[] = []
  window.repository = { onPullRequestReviewProgress: () => () => {} } as unknown as RepositoryApi
  const skeleton: RepositorySnapshot = {
    ...repositorySnapshot,
    branch: null,
    paths: ['desk.ts', 'src/changed.ts'],
    statuses: [],
    stage: 'skeleton'
  }
  const { result } = renderHook(() => useGitWorkflow({
    ...workflowOptions(),
    snapshot: skeleton,
    selectedPath: null,
    workspaceView: 'file' as const,
    onSelectPath: (path) => selected.push(path),
    onWorkspaceViewChange: (view) => views.push(view)
  }))
  await waitFor(() => expect(result.current.activeWorld?.source).toBe('desk'))

  const live: RepositorySnapshot = {
    ...skeleton,
    branch: 'main',
    statuses: [{ path: 'src/changed.ts', status: 'modified' }],
    stage: 'live'
  }
  act(() => { result.current.resyncDeskNavigation(live) })

  expect(selected.at(-1)).toBe('src/changed.ts')
  expect(views.at(-1)).toBe('multi')
})

test('a resync while another tab is in front leaves the reader where they are', async () => {
  const selected: (string | null)[] = []
  window.repository = {
    getPullRequestReview: async () => review(3),
    activateRepository: async () => repositorySnapshot,
    releaseRepository: async () => {},
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow({
    ...workflowOptions(),
    onSelectPath: (path) => selected.push(path)
  }))

  await act(() => result.current.openPullRequestReview(3))
  expect(result.current.activeWorld?.source).toBe('patch')
  const before = selected.length

  act(() => {
    result.current.resyncDeskNavigation({
      ...repositorySnapshot,
      statuses: [{ path: 'desk.ts', status: 'modified' }],
      stage: 'live'
    })
  })

  expect(selected.length).toBe(before)
  expect(result.current.activeWorld?.source).toBe('patch')
})

test('a root resolved by main wins over the New tab folder as the preferred root', async () => {
  const resolvePullRequestRepository = mock(async (
    _url: string,
    _preferredRoot?: string | null
  ) => repositorySnapshot)
  window.repository = {
    resolvePullRequestRepository,
    getPullRequestReview: async () => review(9),
    activateRepository: async () => repositorySnapshot,
    releaseRepository: async () => {},
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  act(() => { result.current.openNewWorld() })
  act(() => { result.current.updateNewWorldRepositoryRoot('/Users/me/Developer/app') })
  await act(() => result.current.openPullRequestFromLocator(review(9).pullRequest.url, '/repo'))

  expect(resolvePullRequestRepository).toHaveBeenCalledWith(review(9).pullRequest.url, '/repo')
})

test('a deep-linked pull request pops a New tab before the repository resolve returns', async () => {
  const pending = deferred<RepositorySnapshot | null>()
  const resolvePullRequestRepository = mock(() => pending.promise)
  window.repository = {
    resolvePullRequestRepository,
    getPullRequestReview: async () => review(8),
    activateRepository: async () => repositorySnapshot,
    releaseRepository: async () => {},
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  expect(result.current.activeWorld?.source).toBe('desk')
  let request!: Promise<boolean>
  act(() => {
    request = result.current.openPullRequestFromLocator(review(8).pullRequest.url)
  })

  expect(result.current.activeWorld?.source).toBe('new')
  expect(result.current.activeWorld?.source === 'new' ? result.current.activeWorld.pending : false)
    .toBe(true)
  expect(result.current.activeWorld?.source === 'new' ? result.current.activeWorld.locator : '')
    .toBe(review(8).pullRequest.url)
  expect(result.current.actionKey).toBe('resolve:pull-request')
  expect(result.current.worlds.some((world) => world.source === 'desk')).toBe(true)

  pending.resolve(repositorySnapshot)
  await act(() => request)
  expect(result.current.worlds.some((world) => world.source === 'patch')).toBe(true)
})

test('navigating between the desk and a patch keeps the patch tab loaded', async () => {
  window.repository = {
    getPullRequestReview: async () => review(4),
    activateRepository: async () => repositorySnapshot,
    releaseRepository: async () => {},
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  await act(() => result.current.openPullRequestReview(4))
  const deskWorldId = result.current.worlds.find((world) => world.source === 'desk')?.worldId
  const patchWorldId = result.current.worlds.find((world) => world.source === 'patch')?.worldId
  act(() => result.current.rememberReviewScroll(640))
  await act(() => result.current.focusWorld(deskWorldId!))
  await act(() => result.current.focusWorld(patchWorldId!))

  expect(result.current.activeWorld?.worldId).toBe(patchWorldId)
  expect(result.current.activeWorld?.source === 'patch'
    ? result.current.activeWorld.loadStatus
    : null).toBe('ready')
  expect(result.current.initialReviewScrollTop).toBe(640)
})

test('a successful submitted review reports back from GitHub', async () => {
  const submitPullRequestReview = mock(async () => {})
  window.repository = {
    getPullRequestReview: async () => review(5),
    activateRepository: async () => repositorySnapshot,
    releaseRepository: async () => {},
    onPullRequestReviewProgress: () => () => {},
    submitPullRequestReview
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  await act(() => result.current.openPullRequestReview(5))
  let submitted = false
  await act(async () => {
    submitted = await result.current.submitReview('comment', 'Looks good.', [])
  })

  expect(submitted).toBe(true)
  expect(submitPullRequestReview).toHaveBeenCalledTimes(1)
  expect(submitPullRequestReview).toHaveBeenCalledWith(
    repositorySnapshot.root,
    '5',
    '5'.repeat(40),
    'comment',
    'Looks good.',
    []
  )
  expect(result.current.submissionMessage).toBe('Review submitted to GitHub.')
})

test('a superseded local review does not raise a cancelled error banner', async () => {
  const errors: Array<string | null> = []
  const onError = (message: string | null): void => { errors.push(message) }
  window.repository = {
    getCommitReview: () => Promise.reject(new Error(COMMAND_ABORTED_MESSAGE)),
    onLocalReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow({ ...workflowOptions(), onError }))

  await act(() => result.current.reviewCommit('abc1234'))

  expect(errors.filter((message) => message != null)).toEqual([])
  expect(result.current.worlds.filter((world) => world.source === 'patch')).toHaveLength(0)
})

// Electron does not order an invoke's reply against the progress events sent
// before it. A streamed reply carries no files, so a load that trusted it opened
// an empty pull request, or kept a local review at the pages that had arrived.
test('a pull request whose reply overtakes its metadata and pages still opens whole', async () => {
  let progressListener: ((progress: PullRequestReviewProgress) => void) | null = null
  const finalReview = review(6)
  window.repository = {
    getPullRequestReview: async (_root: string, _selector: number | string, requestId: string) => {
      setTimeout(() => {
        progressListener?.({ kind: 'metadata', selector: '6', review: { ...finalReview, files: [] }, root: '/repo', requestId })
        progressListener?.({ kind: 'files', selector: '6', files: finalReview.files, patch: '', omittedFiles: [], root: '/repo', requestId })
        progressListener?.({ kind: 'done', selector: '6', fileCount: 1, root: '/repo', requestId })
      }, 20)
      return { ...finalReview, files: [], patch: '', omittedFiles: [] }
    },
    activateRepository: async () => repositorySnapshot,
    releaseRepository: async () => {},
    onPullRequestReviewProgress: (listener: (progress: PullRequestReviewProgress) => void) => {
      progressListener = listener
      return () => { progressListener = null }
    }
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  await act(() => result.current.openPullRequestReview(6))

  const patchWorld = result.current.worlds.find((world) => world.source === 'patch')
  expect(patchWorld?.source === 'patch' ? patchWorld.review.files.map((file) => file.path) : []).toEqual(['file-6.ts'])
  expect(patchWorld?.source === 'patch' ? patchWorld.loadStatus : null).toBe('ready')
})

test('a local review keeps the pages that land after its reply', async () => {
  let progressListener: ((progress: LocalReviewProgress) => void) | null = null
  const localReview = (files: string[]): LocalBranchReview => ({
    kind: 'local',
    id: 'commit:abc1234',
    title: 'Commit abc1234',
    baseRefName: 'abc1234^',
    headRefName: 'abc1234',
    baseOid: 'a'.repeat(40),
    headOid: 'c'.repeat(40),
    files: files.map((path) => ({ path, additions: 1, deletions: 0 })),
    patch: '',
    omittedFiles: [],
    expectedFileCount: 3
  })
  window.repository = {
    getCommitReview: async (_oid: string, requestId: string) => {
      progressListener?.({ kind: 'metadata', review: localReview(['one.ts']), requestId })
      setTimeout(() => {
        progressListener?.({
          kind: 'files', selector: 'commit:abc1234', patch: '',
          files: [{ path: 'two.ts', additions: 1, deletions: 0 }, { path: 'three.ts', additions: 1, deletions: 0 }],
          omittedFiles: [], requestId
        })
        progressListener?.({ kind: 'done', selector: 'commit:abc1234', fileCount: 3, requestId })
      }, 20)
      return localReview(['one.ts', 'two.ts', 'three.ts'])
    },
    onLocalReviewProgress: (listener: (progress: LocalReviewProgress) => void) => {
      progressListener = listener
      return () => { progressListener = null }
    }
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  await act(() => result.current.reviewCommit('abc1234'))

  const patchWorld = result.current.worlds.find((world) => world.source === 'patch')
  expect(patchWorld?.source === 'patch' ? patchWorld.review.files.map((file) => file.path) : [])
    .toEqual(['one.ts', 'two.ts', 'three.ts'])
})

const integrationSnapshot: GitIntegrationSnapshot = {
  branches: [{ name: 'main', current: true, upstream: 'origin/main' }],
  remoteBranches: [],
  remotes: [],
  commits: [],
  defaultBranch: 'main',
  ahead: 0,
  behind: 0,
  pullRequests: [],
  githubAvailable: true,
  githubMessage: null
}

// The hook reads its snapshot back from props, so the tests below route
// `applySnapshot` into state the way App does.
function useLiveWorkflow(overrides: Partial<ReturnType<typeof workflowOptions>> = {}) {
  const [snapshot, setSnapshot] = useState<RepositorySnapshot>(repositorySnapshot)
  return useGitWorkflow({ ...workflowOptions(), snapshot, applySnapshot: setSnapshot, ...overrides })
}

test('a stage clicked while a commit is running waits for the commit', async () => {
  const commit = deferred<RepositorySnapshot>()
  const calls: string[] = []
  window.repository = {
    commitChanges: (root: string) => {
      calls.push(`commit:${root}`)
      return commit.promise
    },
    stagePaths: async (root: string, paths: readonly string[]) => {
      calls.push(`stage:${root}:${paths.join(',')}`)
      return repositorySnapshot
    },
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  let committing!: Promise<boolean>
  let staging!: Promise<boolean>
  act(() => { committing = result.current.commitChanges({ message: 'Ship it' }) })
  await waitFor(() => expect(calls).toEqual(['commit:/repo']))
  act(() => { staging = result.current.stagePaths(['late.ts']) })
  await new Promise((settle) => setTimeout(settle, 10))
  expect(calls).toEqual(['commit:/repo'])

  await act(async () => {
    commit.resolve({ ...repositorySnapshot, head: 'after-commit' })
    await committing
  })
  await act(() => staging)
  expect(calls).toEqual(['commit:/repo', 'stage:/repo:late.ts'])
})

test('a discard confirmed after a tab switch acts on the repository it asked about', async () => {
  const answer = deferred<boolean>()
  const applied: string[] = []
  const discardPaths = mock(async (root: string) => ({ ...repositorySnapshot, root }))
  window.repository = { discardPaths, onPullRequestReviewProgress: () => () => {} } as unknown as RepositoryApi
  const other: RepositorySnapshot = { ...repositorySnapshot, root: '/other', name: 'other' }
  const { result, rerender } = renderHook(({ snapshot }) => useGitWorkflow({
    ...workflowOptions(),
    snapshot,
    applySnapshot: (next) => applied.push(next.root),
    confirm: () => answer.promise
  }), { initialProps: { snapshot: repositorySnapshot } })

  let discarding!: Promise<boolean>
  act(() => { discarding = result.current.discardPaths(['desk.ts'], 0) })
  rerender({ snapshot: other })
  await act(async () => {
    answer.resolve(true)
    await discarding
  })

  expect(discardPaths).toHaveBeenCalledWith('/repo', ['desk.ts'])
  // Painting /repo's answer would drag the reader back out of /other.
  expect(applied).toEqual([])
})

test('a pull request list that fails to load reads as GitHub unavailable, not as empty', async () => {
  window.repository = {
    getGitIntegration: async () => integrationSnapshot,
    getRepositoryPullRequests: async () => { throw new Error('gh: not logged in') },
    getPullRequestInbox: async () => ({ available: true, message: null, sections: [] }),
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  await act(() => result.current.loadIntegration(true))

  expect(result.current.integration?.githubAvailable).toBe(false)
  expect(result.current.integration?.githubMessage).toBe('gh: not logged in')
})

test('a fetch keeps the GitHub availability it had and does not reload local git twice', async () => {
  const getGitIntegration = mock(async () => integrationSnapshot)
  let pullRequestAnswer: Promise<RepositoryPullRequests> = Promise.resolve({
    pullRequests: [], githubAvailable: false, githubMessage: 'offline'
  })
  window.repository = {
    getGitIntegration,
    getRepositoryPullRequests: () => pullRequestAnswer,
    fetchRemote: async (root: string) => root === '/repo' ? integrationSnapshot : Promise.reject(new Error(root)),
    getPullRequestInbox: async () => ({ available: true, message: null, sections: [] }),
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))
  await act(() => result.current.loadIntegration(true))
  expect(getGitIntegration).toHaveBeenCalledTimes(1)

  const later = deferred<RepositoryPullRequests>()
  pullRequestAnswer = later.promise
  await act(() => result.current.fetchRemote())
  // Local git answered with `githubAvailable: true`; that is a placeholder.
  expect(result.current.integration?.githubAvailable).toBe(false)
  await act(async () => {
    later.resolve({ pullRequests: [], githubAvailable: true, githubMessage: null })
    await later.promise
  })
  expect(result.current.integration?.githubAvailable).toBe(true)
  expect(getGitIntegration).toHaveBeenCalledTimes(1)
})

test('commit and push records the head the commit made, so the panel is not stale after', async () => {
  const getGitIntegration = mock(async () => integrationSnapshot)
  const pushCurrentBranch = mock(async (_root: string) => integrationSnapshot)
  window.repository = {
    getGitIntegration,
    getRepositoryPullRequests: async () => ({ pullRequests: [], githubAvailable: true, githubMessage: null }),
    getPullRequestInbox: async () => ({ available: true, message: null, sections: [] }),
    commitChanges: async () => ({ ...repositorySnapshot, head: 'after-commit' }),
    pushCurrentBranch,
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useLiveWorkflow())
  await act(() => result.current.loadIntegration(true))

  let committed = false
  await act(async () => { committed = await result.current.commitChanges({ message: 'Ship it', push: true }) })

  expect(committed).toBe(true)
  expect(pushCurrentBranch).toHaveBeenCalledWith('/repo')
  await act(() => result.current.loadIntegration())
  expect(getGitIntegration).toHaveBeenCalledTimes(1)
})

// A stage takes no `actionKey`, so Switch, Pull and Checkout stay enabled while
// its `git add` runs; main holds no lock, and the two raced into `index.lock`.
test('a branch switch, pull or checkout clicked while a stage is running waits for it', async () => {
  const stage = deferred<RepositorySnapshot>()
  const calls: string[] = []
  window.repository = {
    stagePaths: (root: string) => {
      calls.push(`stage:${root}`)
      return stage.promise
    },
    switchBranch: async (root: string, name: string) => {
      calls.push(`switch:${root}:${name}`)
      return repositorySnapshot
    },
    pullCurrentBranch: async (root: string) => {
      calls.push(`pull:${root}`)
      return repositorySnapshot
    },
    checkoutPullRequest: async (root: string, number: number) => {
      calls.push(`checkout:${root}:${number}`)
      return repositorySnapshot
    },
    getGitIntegration: async () => integrationSnapshot,
    getRepositoryPullRequests: async () => ({ pullRequests: [], githubAvailable: true, githubMessage: null }),
    getPullRequestInbox: async () => ({ available: true, message: null, sections: [] }),
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  let staging!: Promise<boolean>
  let switching!: Promise<void>
  let pulling!: Promise<void>
  let checkingOut!: Promise<void>
  act(() => { staging = result.current.stagePaths(['desk.ts']) })
  await waitFor(() => expect(calls).toEqual(['stage:/repo']))
  act(() => {
    switching = result.current.switchBranch('feature')
    pulling = result.current.pullCurrentBranch()
    checkingOut = result.current.checkoutPullRequest(review(4).pullRequest)
  })
  await new Promise((settle) => setTimeout(settle, 10))
  expect(calls).toEqual(['stage:/repo'])

  await act(async () => {
    stage.resolve(repositorySnapshot)
    await staging
  })
  await act(() => Promise.all([switching, pulling, checkingOut]))
  expect(calls).toEqual(['stage:/repo', 'switch:/repo:feature', 'pull:/repo', 'checkout:/repo:4'])
})

test('a cancelled pull request list keeps the answer the panel already had', async () => {
  const listed = review(7).pullRequest
  let answer: () => Promise<RepositoryPullRequests> = async () => ({
    pullRequests: [listed], githubAvailable: true, githubMessage: null
  })
  window.repository = {
    getGitIntegration: async () => integrationSnapshot,
    getRepositoryPullRequests: () => answer(),
    getPullRequestInbox: async () => ({ available: true, message: null, sections: [] }),
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))
  await act(() => result.current.loadIntegration(true))
  expect(result.current.integration?.pullRequests).toEqual([listed])

  // How Electron hands a rejected invoke to the renderer.
  answer = async () => {
    throw new Error(`Error invoking remote method 'repository:get-pull-requests': Error: ${COMMAND_ABORTED_MESSAGE}`)
  }
  await act(() => result.current.loadIntegration(true))

  expect(result.current.integration?.githubAvailable).toBe(true)
  expect(result.current.integration?.githubMessage).toBeNull()
  expect(result.current.integration?.pullRequests).toEqual([listed])
})
