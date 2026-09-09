import { afterEach, expect, mock, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

import {
  COMMAND_ABORTED_MESSAGE,
  type PullRequestReview,
  type PullRequestReviewProgress,
  type RepositoryApi,
  type RepositorySnapshot
} from '../../shared/contracts'
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

  let firstRequest!: Promise<void>
  let secondRequest!: Promise<void>
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

  let request!: Promise<void>
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

  let request!: Promise<void>
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

test('opening and navigating a patch does not advance the checkpoint', async () => {
  window.repository = {
    getPullRequestReview: async () => review(4),
    activateRepository: async () => repositorySnapshot,
    releaseRepository: async () => {},
    onPullRequestReviewProgress: () => () => {}
  } as unknown as RepositoryApi
  const { result } = renderHook(() => useGitWorkflow(workflowOptions()))

  await act(() => result.current.openPullRequestReview(4))
  expect(result.current.reviewCheckpoint).toBeNull()

  const deskWorldId = result.current.worlds.find((world) => world.source === 'desk')?.worldId
  const patchWorldId = result.current.worlds.find((world) => world.source === 'patch')?.worldId
  act(() => result.current.rememberReviewScroll(640))
  await act(() => result.current.focusWorld(deskWorldId!))
  await act(() => result.current.focusWorld(patchWorldId!))
  expect(result.current.reviewCheckpoint).toBeNull()

  act(() => result.current.setReviewCheckpoint())
  expect(result.current.reviewCheckpoint?.headOid).toBe('4'.repeat(40))
})

test('a successful submitted review advances the checkpoint', async () => {
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
  expect(result.current.reviewCheckpoint?.headOid).toBe('5'.repeat(40))
  expect(result.current.submissionMessage).toBe('Review submitted to GitHub. Checkpoint advanced.')
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
