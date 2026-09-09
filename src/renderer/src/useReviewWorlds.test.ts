import { expect, test } from 'bun:test'

import type { LocalBranchReview, PullRequestReview, RepositorySnapshot } from '../../shared/contracts'
import {
  actionMayChangeInactivePatchBudget,
  boundInactivePatchPayloads,
  createNewWorld,
  createPatchWorld,
  createSinceWorld,
  findCollisionPaths,
  initialWorldRegistry,
  newWorldHoldsReview,
  reduceWorldRegistry,
  reviewPayloadBytes,
  worldHasActiveRepositorySession
} from './useReviewWorlds'
import { estimateParsedGraphBytes } from './worldViewCache'

const snapshot = (head = 'desk-1'): RepositorySnapshot => ({
  root: '/repo',
  name: 'repo',
  kind: 'git',
  branch: 'main',
  head,
  paths: ['src/a.ts', 'src/b.ts'],
  statuses: [{ path: 'src/a.ts', status: 'modified' }]
})

const review = (number = 7): PullRequestReview => ({
  kind: 'github',
  selector: String(number),
  baseOid: `base-${number}`,
  headOid: `head-${number}`,
  commitId: `head-${number}`,
  viewerCanSubmitDecision: true,
  pullRequest: {
    number,
    title: `Review ${number}`,
    url: `https://github.com/acme/repo/pull/${number}`,
    state: 'OPEN',
    isDraft: false,
    author: { login: 'author' },
    headRefName: `feature-${number}`,
    baseRefName: 'main',
    reviewDecision: null,
    updatedAt: '2026-08-28T00:00:00Z',
    additions: 2,
    deletions: 1,
    changedFiles: 2
  },
  files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
  patch: '',
  omittedFiles: [],
  expectedFileCount: 2
})

test('a working-tree tab stays live while an immutable Patch tab remains open', () => {
  const deskState = reduceWorldRegistry(
    { worlds: [], activeWorldId: null },
    { type: 'open-desk', snapshot: snapshot() }
  )
  const patch = createPatchWorld(snapshot(), review(), 1, 'ready')
  const patchState = reduceWorldRegistry(deskState, {
    type: 'open-patch', world: patch, originWorldId: deskState.activeWorldId
  })
  const refreshed = reduceWorldRegistry(patchState, { type: 'sync-repository', snapshot: snapshot('desk-2') })

  expect(refreshed.worlds).toHaveLength(2)
  expect(refreshed.activeWorldId).toBe(patch.worldId)
  expect(refreshed.worlds[0]?.source === 'desk' ? refreshed.worlds[0].baselineOid : null).toBe('desk-2')
  expect(refreshed.worlds[1]?.source === 'patch' ? refreshed.worlds[1].review : null).toEqual(patch.review)
  expect(refreshed.worlds[1]?.source === 'patch' ? refreshed.worlds[1].snapshot.head : null).toBe('desk-2')
})

test('a patch page only updates its matching world generation', () => {
  const patch = createPatchWorld(snapshot(), { ...review(), files: [] }, 2, 'loading')
  const state = { worlds: [patch], activeWorldId: patch.worldId }
  const progress = {
    kind: 'files' as const,
    selector: '7',
    files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
    patch: 'page',
    omittedFiles: []
  }
  const stale = reduceWorldRegistry(state, {
    type: 'append-patch-page',
    worldId: patch.worldId,
    generation: 1,
    progress
  })
  const current = reduceWorldRegistry(state, {
    type: 'append-patch-page',
    worldId: patch.worldId,
    generation: 2,
    progress
  })

  expect(stale).toBe(state)
  expect(current.worlds[0]?.source === 'patch' ? current.worlds[0].review.files : []).toHaveLength(1)
  expect(current.worlds[0]?.source === 'patch' ? current.worlds[0].patchPages : []).toEqual(['page'])
  expect(current.worlds[0]?.source === 'patch' ? current.worlds[0].patchLength : 0).toBe(4)
  expect(current.worlds[0]?.source === 'patch' ? current.worlds[0].review.patch : null).toBe('')
})

test('a local review appends file pages the same way a streamed pull request does', () => {
  const localReview: LocalBranchReview = {
    kind: 'local',
    id: 'main...feature:base:head',
    title: 'feature compared with main',
    baseRefName: 'main',
    headRefName: 'feature',
    baseOid: 'base',
    headOid: 'head',
    files: [{ path: 'a.txt', additions: 1, deletions: 0 }],
    patch: 'first-page',
    expectedFileCount: 2,
    omittedFiles: []
  }
  const patch = createPatchWorld(snapshot(), localReview, 2, 'loading')
  const current = reduceWorldRegistry(
    { worlds: [patch], activeWorldId: patch.worldId },
    {
      type: 'append-patch-page',
      worldId: patch.worldId,
      generation: 2,
      progress: {
        kind: 'files',
        selector: localReview.id,
        files: [{ path: 'b.txt', additions: 1, deletions: 0 }],
        patch: 'second-page',
        omittedFiles: []
      }
    }
  )
  const world = current.worlds[0]
  expect(world?.source === 'patch' ? world.review.kind : null).toBe('local')
  expect(world?.source === 'patch' ? world.patchPages : []).toEqual(['first-page', 'second-page'])
  expect(world?.source === 'patch' ? world.review.files.map((file) => file.path) : []).toEqual(['a.txt', 'b.txt'])
  expect(world?.source === 'patch' ? world.review.patch : null).toBe('first-page')
})

test('the terminal stream count updates metadata without replacing patch pages', () => {
  const patch = createPatchWorld(snapshot(), { ...review(), files: [] }, 2, 'loading')
  const state = reduceWorldRegistry(
    { worlds: [patch], activeWorldId: patch.worldId },
    {
      type: 'append-patch-page',
      worldId: patch.worldId,
      generation: 2,
      progress: {
        kind: 'files',
        selector: '7',
        files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
        patch: 'page',
        omittedFiles: []
      }
    }
  )
  const done = reduceWorldRegistry(state, {
    type: 'set-patch-expected-file-count',
    worldId: patch.worldId,
    generation: 2,
    fileCount: 1
  })
  const world = done.worlds[0]

  expect(world?.source === 'patch' && world.review.kind === 'github'
    ? world.review.expectedFileCount
    : null).toBe(1)
  expect(world?.source === 'patch' ? world.patchPages : null).toEqual(['page'])
  expect(world?.source === 'patch' ? world.patchLength : null).toBe(4)
})

test('collision radar reports exact dirty-path intersections only', () => {
  const collisions = findCollisionPaths([
    { path: 'src/a.ts', status: 'modified' },
    { path: 'src/other.ts', status: 'untracked' }
  ], {
    ...review(),
    files: [
      { path: 'src/a.ts', additions: 1, deletions: 0 },
      { path: 'src/b.ts', additions: 1, deletions: 0 }
    ]
  })

  expect([...collisions]).toEqual(['src/a.ts'])
})

test('Since opens as a child tab without replacing its Patch snapshot', () => {
  const patch = createPatchWorld(snapshot(), review(), 1, 'ready')
  const checkpoint = {
    version: 1 as const,
    pullRequestUrl: review().pullRequest.url,
    baseOid: '1'.repeat(40),
    headOid: '2'.repeat(40),
    createdAt: '2026-08-28T10:00:00Z',
    manifest: []
  }
  const since = createSinceWorld(snapshot(), patch.worldId, {
    review: { ...review(), files: [{ path: 'src/b.ts', additions: 1, deletions: 0 }] },
    removedPaths: ['src/old.ts'],
    uncertainPaths: []
  }, checkpoint)
  const state = reduceWorldRegistry(
    { worlds: [patch], activeWorldId: patch.worldId },
    { type: 'open-since', world: since }
  )

  expect(state.worlds).toEqual([patch, since])
  expect(state.activeWorldId).toBe(since.worldId)
  expect(since.parentWorldId).toBe(patch.worldId)
})

test('a background cross-project load replaces its New tab without stealing focus', () => {
  const firstSnapshot = snapshot()
  const secondSnapshot = {
    ...snapshot('desk-b'),
    root: '/other/repo-b',
    name: 'repo-b'
  }
  const firstPatch = createPatchWorld(firstSnapshot, review(221), 1, 'ready')
  const secondPatch = createPatchWorld(secondSnapshot, {
    ...review(42),
    pullRequest: {
      ...review(42).pullRequest,
      url: 'https://github.com/other/repo-b/pull/42'
    }
  }, 2, 'ready')
  const newWorld = createNewWorld()
  const loadingState = {
    worlds: [firstPatch, newWorld],
    activeWorldId: firstPatch.worldId
  }
  const completedState = reduceWorldRegistry(loadingState, {
    type: 'open-patch',
    world: secondPatch,
    originWorldId: newWorld.worldId
  })

  expect(completedState.activeWorldId).toBe(firstPatch.worldId)
  expect(completedState.worlds).toEqual([firstPatch, secondPatch])
  expect(completedState.worlds.map((world) => world.source === 'new' ? null : world.root))
    .toEqual(['/repo', '/other/repo-b'])
})

test('inactive GitHub patch payloads are released when they exceed the memory budget', () => {
  const first = createPatchWorld(snapshot(), { ...review(1), patch: 'a'.repeat(100) }, 1, 'ready')
  const second = createPatchWorld(snapshot(), { ...review(2), patch: 'b'.repeat(100) }, 2, 'ready')
  const state = boundInactivePatchPayloads({
    worlds: [first, second],
    activeWorldId: second.worldId
  }, 100)

  expect(state.worlds[0]?.source === 'patch' ? state.worlds[0].loadStatus : null).toBe('released')
  expect(state.worlds[0]?.source === 'patch' ? state.worlds[0].review.patch : null).toBe('')
  expect(state.worlds[0]?.source === 'patch' ? state.worlds[0].patchPages : null).toEqual([])
  expect(state.worlds[0]?.source === 'patch' ? state.worlds[0].patchLength : null).toBe(0)
  expect(state.worlds[1]).toBe(second)
})

test('inactive Since worlds are released and can restore their filtered pages', () => {
  const parent = createPatchWorld(snapshot(), review(), 1, 'ready')
  const checkpoint = {
    version: 1 as const,
    pullRequestUrl: review().pullRequest.url,
    baseOid: '1'.repeat(40),
    headOid: '2'.repeat(40),
    createdAt: '2026-08-28T10:00:00Z',
    manifest: []
  }
  const since = createSinceWorld(snapshot(), parent.worldId, {
    review: { ...review(), patch: 'line one\nline two\n' },
    patchPages: ['line one\n', 'line two\n'],
    removedPaths: [],
    uncertainPaths: []
  }, checkpoint)
  const released = boundInactivePatchPayloads({
    worlds: [since, parent],
    activeWorldId: parent.worldId
  }, 1)
  const releasedSince = released.worlds[0]

  expect(releasedSince?.source === 'since' ? releasedSince.loadStatus : null).toBe('released')
  expect(releasedSince?.source === 'since' ? releasedSince.patchPages : null).toEqual([])
  expect(releasedSince?.source === 'since' ? releasedSince.review.files : null).toEqual([])
  expect(releasedSince?.source === 'since' ? releasedSince.changedPaths : null).toEqual(['src/a.ts'])

  const restored = reduceWorldRegistry(released, {
    type: 'restore-since-patch',
    worldId: since.worldId,
    patchPages: ['line two\n'],
    files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
    omittedFiles: []
  })
  expect(restored.worlds[0]?.source === 'since' ? restored.worlds[0].loadStatus : null).toBe('ready')
  expect(restored.worlds[0]?.source === 'since' ? restored.worlds[0].patchLength : null).toBe(9)
  expect(restored.worlds[0]?.source === 'since' ? restored.worlds[0].review.files : null).toHaveLength(1)
})

test('locator typing skips the inactive patch payload scan', () => {
  expect(actionMayChangeInactivePatchBudget('update-locator')).toBe(false)
  expect(actionMayChangeInactivePatchBudget('sync-repository')).toBe(false)
  expect(actionMayChangeInactivePatchBudget('append-patch-page')).toBe(true)
  expect(actionMayChangeInactivePatchBudget('set-patch-status')).toBe(true)
  expect(actionMayChangeInactivePatchBudget('focus')).toBe(true)
})

test('inactive GitHub worlds are released once retained payload exceeds the 64 MB budget', () => {
  const patch = (number: number, bytes: number) => createPatchWorld(
    snapshot(),
    { ...review(number), patch: 'x'.repeat(bytes) },
    number,
    'ready'
  )
  const active = patch(4, 1)
  const state = boundInactivePatchPayloads({
    worlds: [patch(1, 30 * 1024 * 1024), patch(2, 30 * 1024 * 1024), patch(3, 20 * 1024 * 1024), active],
    activeWorldId: active.worldId
  })

  expect(state.worlds.filter((world) => world.source === 'patch' && world.loadStatus === 'released'))
    .toHaveLength(1)
  expect(state.worlds[0]?.source === 'patch' ? state.worlds[0].loadStatus : null).toBe('released')
  expect(state.worlds[1]?.source === 'patch' ? state.worlds[1].loadStatus : null).toBe('ready')
  expect(state.worlds[2]?.source === 'patch' ? state.worlds[2].loadStatus : null).toBe('ready')
  expect(state.worlds[3]).toBe(active)
})

test('same-root tab switches reuse the live repository session', () => {
  const desk = reduceWorldRegistry(
    { worlds: [], activeWorldId: null },
    { type: 'open-desk', snapshot: snapshot() }
  )
  const first = createPatchWorld(snapshot(), review(1), 1, 'ready')
  const second = createPatchWorld(snapshot(), review(2), 2, 'ready')
  const focused = reduceWorldRegistry(
    reduceWorldRegistry(desk, { type: 'open-patch', world: first, originWorldId: desk.activeWorldId }),
    { type: 'open-patch', world: second, originWorldId: first.worldId }
  )
  const firstWorld = focused.worlds.find((world) => world.worldId === first.worldId)!
  const secondWorld = focused.worlds.find((world) => world.worldId === second.worldId)!
  expect(worldHasActiveRepositorySession(firstWorld, focused)).toBe(true)
  expect(worldHasActiveRepositorySession(secondWorld, focused)).toBe(true)
  expect(worldHasActiveRepositorySession(createNewWorld(), focused)).toBe(false)
})

test('sync-repository keeps world identity when the snapshot object is unchanged', () => {
  const current = snapshot()
  const desk = reduceWorldRegistry(
    { worlds: [], activeWorldId: null },
    { type: 'open-desk', snapshot: current }
  )
  expect(reduceWorldRegistry(desk, { type: 'sync-repository', snapshot: current })).toBe(desk)
})

test('review payload bytes charge a retained parsed graph on top of patch text', () => {
  const world = createPatchWorld(snapshot(), { ...review(1), patch: 'abcd' }, 1, 'ready')
  const graphBytes = estimateParsedGraphBytes([{ id: 'review:src/a.ts' }])
  expect(reviewPayloadBytes(world)).toBeLessThan(reviewPayloadBytes(world, graphBytes))
  expect(reviewPayloadBytes(world, graphBytes) - reviewPayloadBytes(world)).toBe(graphBytes)
})

test('a retained parsed graph can evict an inactive world the patch text alone would keep', () => {
  const first = createPatchWorld(snapshot(), { ...review(1), patch: 'aa' }, 1, 'ready')
  const second = createPatchWorld(snapshot(), { ...review(2), patch: 'bb' }, 2, 'ready')
  const graphBytes = new Map<string, number>([[first.worldId, 80]])
  const state = boundInactivePatchPayloads({
    worlds: [first, second],
    activeWorldId: second.worldId
  }, 50, (worldId) => graphBytes.get(worldId) ?? 0)

  expect(state.worlds[0]?.source === 'patch' ? state.worlds[0].loadStatus : null).toBe('released')
  expect(state.worlds[1]).toBe(second)
})

test('local branch-compare and loading GitHub worlds stay outside the budget', () => {
  const localReview: LocalBranchReview = {
    kind: 'local',
    id: 'main...feature',
    title: 'feature',
    baseRefName: 'main',
    headRefName: 'feature',
    baseOid: 'base',
    headOid: 'head',
    files: [{ path: 'src/a.ts', additions: 1, deletions: 0 }],
    patch: 'y'.repeat(80 * 1024 * 1024),
    expectedFileCount: 1,
    omittedFiles: []
  }
  const local = createPatchWorld(snapshot(), localReview, 1, 'ready')
  const loading = createPatchWorld(snapshot(), { ...review(2), patch: 'z'.repeat(80 * 1024 * 1024) }, 2, 'loading')
  const active = createPatchWorld(snapshot(), review(3), 3, 'ready')
  const state = boundInactivePatchPayloads({
    worlds: [local, loading, active],
    activeWorldId: active.worldId
  }, 1)

  expect(state.worlds[0]).toBe(local)
  expect(state.worlds[1]).toBe(loading)
  expect(state.worlds[2]).toBe(active)
})

test('a cached snapshot starts on the desk world, not a New tab', () => {
  const restored = snapshot()
  const state = initialWorldRegistry(restored)
  expect(state.worlds).toHaveLength(1)
  expect(state.worlds[0]).toMatchObject({
    source: 'desk',
    worldId: 'desk:/repo',
    label: 'repo',
    root: '/repo'
  })
  expect(state.activeWorldId).toBe('desk:/repo')
})

test('no cache still starts on a New tab', () => {
  const state = initialWorldRegistry(null)
  expect(state.worlds).toHaveLength(1)
  expect(state.worlds[0]?.source).toBe('new')
})

test('open-desk does not replace a pending pull-request New tab', () => {
  const pending = { ...createNewWorld(), pending: true, label: '#9 · acme/app' }
  const state = { worlds: [pending], activeWorldId: pending.worldId }
  const next = reduceWorldRegistry(state, { type: 'open-desk', snapshot: snapshot() })

  expect(newWorldHoldsReview(pending)).toBe(true)
  expect(next.activeWorldId).toBe(pending.worldId)
  expect(next.worlds.map((world) => world.source)).toEqual(['desk', 'new'])
  expect(next.worlds[1]).toEqual(pending)
})

test('open-desk still replaces an empty Welcome New tab', () => {
  const empty = createNewWorld()
  const state = { worlds: [empty], activeWorldId: empty.worldId }
  const next = reduceWorldRegistry(state, { type: 'open-desk', snapshot: snapshot() })

  expect(newWorldHoldsReview(empty)).toBe(false)
  expect(next.worlds).toHaveLength(1)
  expect(next.worlds[0]?.source).toBe('desk')
  expect(next.activeWorldId).toBe('desk:/repo')
})

test('a New tab keeps a chosen folder until the pull-request repository changes', () => {
  const world = { ...createNewWorld(), repositoryRoot: '/Users/me/Developer/app' }
  const state = { worlds: [world], activeWorldId: world.worldId }
  const sameRepo = reduceWorldRegistry(state, {
    type: 'update-locator',
    worldId: world.worldId,
    locator: 'https://github.com/acme/app/pull/9'
  })
  expect(sameRepo.worlds[0]?.source === 'new' ? sameRepo.worlds[0].repositoryRoot : null)
    .toBe('/Users/me/Developer/app')

  const otherPr = reduceWorldRegistry(sameRepo, {
    type: 'update-locator',
    worldId: world.worldId,
    locator: 'https://github.com/acme/app/pull/10'
  })
  expect(otherPr.worlds[0]?.source === 'new' ? otherPr.worlds[0].repositoryRoot : null)
    .toBe('/Users/me/Developer/app')

  const otherRepo = reduceWorldRegistry(otherPr, {
    type: 'update-locator',
    worldId: world.worldId,
    locator: 'https://github.com/acme/other/pull/10'
  })
  expect(otherRepo.worlds[0]?.source === 'new' ? otherRepo.worlds[0].repositoryRoot : null)
    .toBeNull()

  const chosen = reduceWorldRegistry(otherRepo, {
    type: 'update-repository-root',
    worldId: world.worldId,
    root: '/Users/me/Developer/other'
  })
  expect(chosen.worlds[0]?.source === 'new' ? chosen.worlds[0].repositoryRoot : null)
    .toBe('/Users/me/Developer/other')
})

test('a force-pushed review replaces the tab it was opened in, oids and all', () => {
  const opened = createPatchWorld(snapshot(), { ...review(), patch: 'stale patch\n' }, 1, 'loading')
  const state = reduceWorldRegistry(
    { worlds: [], activeWorldId: null },
    { type: 'open-patch', world: opened, originWorldId: null }
  )
  const moved: PullRequestReview = {
    ...review(),
    baseOid: 'base-7b',
    headOid: 'head-7b',
    commitId: 'head-7b',
    patch: 'fresh patch\n',
    files: [{ path: 'src/b.ts', additions: 2, deletions: 0 }]
  }

  const replaced = reduceWorldRegistry(state, {
    type: 'replace-patch-head', worldId: opened.worldId, generation: 1, review: moved
  })
  const world = replaced.worlds[0]
  // The tab keeps its id — the loader still holds it — and takes the new commits.
  expect(world?.worldId).toBe(opened.worldId)
  expect(world?.source === 'patch' ? world.headOid : null).toBe('head-7b')
  expect(world?.source === 'patch' ? world.baseOid : null).toBe('base-7b')
  expect(world?.source === 'patch' ? world.patchPages : null).toEqual(['fresh patch\n'])
  expect(world?.source === 'patch' ? world.patchLength : null).toBe('fresh patch\n'.length)

  const otherPullRequest = reduceWorldRegistry(replaced, {
    type: 'replace-patch-head', worldId: opened.worldId, generation: 1, review: review(9)
  })
  expect(otherPullRequest.worlds[0]?.source === 'patch' ? otherPullRequest.worlds[0].headOid : null)
    .toBe('head-7b')
})

test('reopening a force-pushed pull request takes over its tab instead of adding one', () => {
  const opened = createPatchWorld(snapshot(), review(), 1, 'ready')
  const state = reduceWorldRegistry(
    { worlds: [], activeWorldId: null },
    { type: 'open-patch', world: opened, originWorldId: null }
  )
  const moved = createPatchWorld(
    snapshot(),
    { ...review(), baseOid: 'base-7b', headOid: 'head-7b', commitId: 'head-7b' },
    2,
    'loading'
  )
  expect(moved.worldId).not.toBe(opened.worldId)

  const reopened = reduceWorldRegistry(state, {
    type: 'open-patch',
    world: moved,
    originWorldId: 'somewhere-else',
    supersedesWorldId: opened.worldId
  })

  expect(reopened.worlds).toHaveLength(1)
  expect(reopened.worlds[0]?.worldId).toBe(moved.worldId)
  // The superseded tab was the one in front, so the reader stays on it.
  expect(reopened.activeWorldId).toBe(moved.worldId)
})

test('a background open with no active world does not steal focus', () => {
  const state = reduceWorldRegistry(
    { worlds: [createNewWorld()], activeWorldId: null },
    { type: 'open-patch', world: createPatchWorld(snapshot(), review(), 1, 'ready'), originWorldId: 'elsewhere' }
  )

  expect(state.activeWorldId).toBeNull()
})

test('checks land on the review header without disturbing the patch', () => {
  const opened = createPatchWorld(snapshot(), { ...review(), patch: 'patch\n' }, 1, 'loading')
  const state = reduceWorldRegistry(
    { worlds: [], activeWorldId: null },
    { type: 'open-patch', world: opened, originWorldId: null }
  )

  const patched = reduceWorldRegistry(state, {
    type: 'set-patch-checks',
    worldId: opened.worldId,
    generation: 1,
    checks: { passing: 3, failing: 1, pending: 0 },
    mergeable: 'CONFLICTING'
  })
  const world = patched.worlds[0]
  expect(world?.source === 'patch' && world.review.kind === 'github'
    ? world.review.pullRequest.checks
    : null).toEqual({ passing: 3, failing: 1, pending: 0 })
  expect(world?.source === 'patch' && world.review.kind === 'github'
    ? world.review.pullRequest.mergeable
    : null).toBe('CONFLICTING')
  expect(world?.source === 'patch' ? world.patchPages : null).toEqual(['patch\n'])
})
