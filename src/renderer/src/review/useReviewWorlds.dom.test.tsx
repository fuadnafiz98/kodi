import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'

import type { PullRequestReview, RepositorySnapshot } from '../../../shared/contracts'
import type { WorkspaceView } from '../app/AppView'
import { useReviewWorlds } from './useReviewWorlds'
import { worldViewCache } from './worldViewCache'

afterEach(() => {
  cleanup()
  worldViewCache.clear()
})

const snapshot: RepositorySnapshot = {
  root: '/repo',
  name: 'repo',
  kind: 'git',
  branch: 'main',
  head: 'desk-head',
  paths: ['desk.ts', 'patch.ts'],
  statuses: []
}

const review: PullRequestReview = {
  kind: 'github',
  selector: '9',
  baseOid: 'base-9',
  headOid: 'head-9',
  commitId: 'head-9',
  viewerCanSubmitDecision: true,
  pullRequest: {
    number: 9,
    title: 'Patch navigation',
    url: 'https://github.com/acme/repo/pull/9',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'author' },
    headRefName: 'feature',
    baseRefName: 'main',
    reviewDecision: null,
    updatedAt: '2026-08-28T00:00:00Z',
    additions: 1,
    deletions: 0,
    changedFiles: 1
  },
  files: [{ path: 'patch.ts', additions: 1, deletions: 0 }],
  patch: '',
  omittedFiles: [],
  expectedFileCount: 1
}

test('same-root world switches do not reactivate the repository session', async () => {
  const activations: string[] = []
  const { result } = renderHook(() => {
    const [selectedPath, setSelectedPath] = useState<string | null>(null)
    const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('multi')
    const worlds = useReviewWorlds({
      snapshot,
      selectedPath,
      workspaceView,
      onActivateSnapshot: () => {},
      onActivateRepository: async (root) => {
        activations.push(root)
        return snapshot
      },
      onReleaseRepository: async () => {},
      onActivationError: () => {},
      onSelectPath: setSelectedPath,
      onWorkspaceViewChange: setWorkspaceView
    })
    return { worlds }
  })

  await waitFor(() => expect(result.current.worlds.worlds).toHaveLength(1))
  let firstPatch!: string
  let secondPatch!: string
  act(() => {
    firstPatch = result.current.worlds.openPatchWorld(snapshot, review, 1, false)!
  })
  act(() => {
    secondPatch = result.current.worlds.openPatchWorld(snapshot, {
      ...review,
      selector: '10',
      pullRequest: { ...review.pullRequest, number: 10, url: 'https://github.com/acme/repo/pull/10' }
    }, 2, false)!
  })
  activations.length = 0
  await act(() => result.current.worlds.focusWorld(firstPatch))
  await act(() => result.current.worlds.focusWorld(secondPatch))
  expect(activations).toEqual([])
})

test('same-root focus does not rewrite an already-matching path and view', async () => {
  const pathWrites: Array<string | null> = []
  const viewWrites: WorkspaceView[] = []
  const { result } = renderHook(() => {
    const [selectedPath, setSelectedPath] = useState<string | null>('patch.ts')
    const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('multi')
    const worlds = useReviewWorlds({
      snapshot,
      selectedPath,
      workspaceView,
      onActivateSnapshot: () => {},
      onActivateRepository: async () => snapshot,
      onReleaseRepository: async () => {},
      onActivationError: () => {},
      onSelectPath: (path) => {
        pathWrites.push(path)
        setSelectedPath(path)
      },
      onWorkspaceViewChange: (view) => {
        viewWrites.push(view)
        setWorkspaceView(view)
      }
    })
    return { worlds }
  })

  await waitFor(() => expect(result.current.worlds.worlds).toHaveLength(1))
  let firstPatch!: string
  let secondPatch!: string
  act(() => {
    firstPatch = result.current.worlds.openPatchWorld(snapshot, review, 1, false)!
  })
  act(() => {
    secondPatch = result.current.worlds.openPatchWorld(snapshot, {
      ...review,
      selector: '10',
      pullRequest: { ...review.pullRequest, number: 10, url: 'https://github.com/acme/repo/pull/10' }
    }, 2, false)!
  })
  pathWrites.length = 0
  viewWrites.length = 0
  await act(() => result.current.worlds.focusWorld(firstPatch))
  await act(() => result.current.worlds.focusWorld(secondPatch))
  expect(pathWrites).toEqual([])
  expect(viewWrites).toEqual([])
})

test('switching worlds restores path, view, and review scroll from the world cache', async () => {
  const { result } = renderHook(() => {
    const [selectedPath, setSelectedPath] = useState<string | null>('desk.ts')
    const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('file')
    const worlds = useReviewWorlds({
      snapshot,
      selectedPath,
      workspaceView,
      onActivateSnapshot: () => {},
      onActivateRepository: async () => snapshot,
      onReleaseRepository: async () => {},
      onActivationError: () => {},
      onSelectPath: setSelectedPath,
      onWorkspaceViewChange: setWorkspaceView
    })
    return { selectedPath, setSelectedPath, workspaceView, worlds }
  })

  await waitFor(() => expect(result.current.worlds.worlds).toHaveLength(1))
  let patchWorldId!: string
  act(() => {
    patchWorldId = result.current.worlds.openPatchWorld(snapshot, review, 1, false)!
  })
  expect(result.current.selectedPath).toBe('patch.ts')
  expect(result.current.workspaceView).toBe('multi')

  act(() => {
    result.current.setSelectedPath('patch-notes.ts')
    result.current.worlds.rememberReviewScroll(420)
  })
  const deskWorldId = result.current.worlds.worlds.find((world) => world.source === 'desk')!.worldId
  await act(() => result.current.worlds.focusWorld(deskWorldId))
  expect(result.current.selectedPath).toBe('desk.ts')
  expect(result.current.workspaceView).toBe('file')

  await act(() => result.current.worlds.focusWorld(patchWorldId))
  expect(result.current.selectedPath).toBe('patch-notes.ts')
  expect(result.current.workspaceView).toBe('multi')
  expect(result.current.worlds.initialReviewScrollTop).toBe(420)
})

test('closing the final tab for a root releases its repository session', async () => {
  const releasedRoots: string[] = []
  const { result } = renderHook(() => useReviewWorlds({
    snapshot,
    selectedPath: null,
    workspaceView: 'multi',
    onActivateSnapshot: () => {},
    onActivateRepository: async () => snapshot,
    onReleaseRepository: async (root) => { releasedRoots.push(root) },
    onActivationError: () => {},
    onSelectPath: () => {},
    onWorkspaceViewChange: () => {}
  }))

  await waitFor(() => expect(result.current.worlds).toHaveLength(1))
  expect(result.current.worlds[0]?.label).toBe('repo')
  let patchWorldId!: string
  act(() => {
    patchWorldId = result.current.openPatchWorld(snapshot, review, 1, false)
  })
  await act(() => result.current.closeWorld(patchWorldId))
  expect(releasedRoots).toEqual([])

  const deskWorld = result.current.worlds.find((world) => world.source === 'desk')
  if (deskWorld == null) throw new Error('Expected a working-tree tab.')
  await act(() => result.current.closeWorld(deskWorld.worldId))

  expect(releasedRoots).toEqual(['/repo'])
  expect(result.current.worlds).toHaveLength(1)
  expect(result.current.worlds[0]?.source).toBe('new')
})

test('refreshes working-tree tab state when status changes without a new commit', async () => {
  const { result } = renderHook(() => {
    const [liveSnapshot, setLiveSnapshot] = useState(snapshot)
    const worlds = useReviewWorlds({
      snapshot: liveSnapshot,
      selectedPath: null,
      workspaceView: 'multi',
      onActivateSnapshot: () => {},
      onActivateRepository: async () => liveSnapshot,
      onReleaseRepository: async () => {},
      onActivationError: () => {},
      onSelectPath: () => {},
      onWorkspaceViewChange: () => {}
    })
    return { worlds, setLiveSnapshot }
  })

  await waitFor(() => expect(result.current.worlds.worlds).toHaveLength(1))
  act(() => {
    result.current.setLiveSnapshot({
      ...snapshot,
      statuses: [{ path: 'desk.ts', status: 'modified' }]
    })
  })

  await waitFor(() => {
    const world = result.current.worlds.worlds[0]
    expect(world?.source === 'desk' ? world.snapshot.statuses : []).toEqual([
      { path: 'desk.ts', status: 'modified' }
    ])
  })
})

test('opening a plain folder starts in the file browser', async () => {
  const folder: RepositorySnapshot = {
    root: '/plain',
    name: 'plain',
    kind: 'folder',
    branch: null,
    head: null,
    paths: ['readme.md', 'src/app.ts'],
    statuses: []
  }
  const { result } = renderHook(() => {
    const [selectedPath, setSelectedPath] = useState<string | null>(null)
    const [workspaceView, setWorkspaceView] = useState<WorkspaceView>('multi')
    const worlds = useReviewWorlds({
      snapshot: folder,
      selectedPath,
      workspaceView,
      onActivateSnapshot: () => {},
      onActivateRepository: async () => folder,
      onReleaseRepository: async () => {},
      onActivationError: () => {},
      onSelectPath: setSelectedPath,
      onWorkspaceViewChange: setWorkspaceView
    })
    return { selectedPath, workspaceView, worlds }
  })

  await waitFor(() => expect(result.current.worlds.worlds).toHaveLength(1))
  act(() => {
    result.current.worlds.openDeskWorld(folder)
  })
  expect(result.current.workspaceView).toBe('file')
  expect(result.current.selectedPath).toBe('src/app.ts')
})

test('the active review keeps its identity when the world is rebuilt around it', async () => {
  const { result } = renderHook(() => useReviewWorlds({
    snapshot,
    selectedPath: null,
    workspaceView: 'multi',
    onActivateSnapshot: () => {},
    onActivateRepository: async () => snapshot,
    onReleaseRepository: async () => {},
    onActivationError: () => {},
    onSelectPath: () => {},
    onWorkspaceViewChange: () => {}
  }))
  await waitFor(() => expect(result.current.worlds).toHaveLength(1))
  let patchWorldId!: string
  act(() => {
    patchWorldId = result.current.openPatchWorld(snapshot, { ...review, patch: 'diff' }, 1, false)
  })
  const activeReview = result.current.activeReview
  expect(activeReview?.patchLength).toBe(4)

  act(() => result.current.syncRepositorySnapshot({ ...snapshot, head: 'moved' }))
  act(() => result.current.setPatchLoadStatus(patchWorldId, 1, 'ready'))
  expect(result.current.activeWorld).not.toBeNull()
  expect(result.current.activeReview).toBe(activeReview)
})
