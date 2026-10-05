import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, renderHook, waitFor } from '@testing-library/react'

import type { LocalReviewProgress, PullRequestReview, RepositoryApi } from '../../../shared/contracts'
import { reviewItemId } from './reviewItems'
import { useReviewLoadState } from './useReviewLoadState'
import { worldViewCache } from './worldViewCache'

afterEach(() => {
  cleanup()
  worldViewCache.clear()
})

const patch = `diff --git a/a.ts b/a.ts
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/a.ts
+++ b/a.ts
@@ -0,0 +1,2 @@
+one
+two
`

const review = (number: number, updatedAt: string): PullRequestReview => ({
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
    updatedAt,
    additions: 2,
    deletions: 0,
    changedFiles: 1
  },
  files: [{ path: 'a.ts', additions: 2, deletions: 0 }],
  patch,
  omittedFiles: [],
  expectedFileCount: 1
})

test('parsed items are charged on the world cache and reused after a world switch', () => {
  const first = review(1, '2026-09-01T00:00:00Z')
  const second = review(2, '2026-09-01T00:00:00Z')
  const paths = ['a.ts']
  const { result, rerender } = renderHook(
    ({ worldId, repositoryReview }: { worldId: string; repositoryReview: PullRequestReview }) =>
      useReviewLoadState({
        pathsKey: 'a.ts',
        stablePaths: paths,
        repositoryReview,
        repositoryChange: null,
        worldId
      }),
    { initialProps: { worldId: 'patch:1', repositoryReview: first } }
  )

  expect(result.current.loadState.items.length).toBeGreaterThan(0)
  const firstItems = result.current.loadState.items
  const firstItem = firstItems[0]
  expect(worldViewCache.graphBytes('patch:1')).toBeGreaterThan(0)
  const firstParsed = worldViewCache.get('patch:1')?.parsed
  expect(firstParsed?.kind === 'string' ? firstParsed.parseKey : null).toContain('pr-1')

  rerender({ worldId: 'patch:2', repositoryReview: second })
  const secondParsed = worldViewCache.get('patch:2')?.parsed
  expect(secondParsed?.kind === 'string' ? secondParsed.parseKey : null).toContain('pr-2')
  expect(result.current.loadState.items).not.toBe(firstItems)
  expect(result.current.loadState.items[0]).not.toBe(firstItem)

  rerender({ worldId: 'patch:1', repositoryReview: first })
  expect(result.current.loadState.items).toBe(firstItems)
  expect(result.current.loadState.items[0]).toBe(firstItem)
})

test('a review rebuilt around the same patch keeps the same load state', () => {
  const first = review(1, '2026-09-01T00:00:00Z')
  const paths = ['a.ts']
  const { result, rerender } = renderHook(
    ({ repositoryReview }: { repositoryReview: PullRequestReview }) =>
      useReviewLoadState({
        pathsKey: 'a.ts',
        stablePaths: paths,
        repositoryReview,
        repositoryChange: null,
        worldId: 'patch:1'
      }),
    { initialProps: { repositoryReview: first } }
  )
  const loadState = result.current.loadState
  // What a checks poll does to the review: a new object, the same patch.
  rerender({ repositoryReview: { ...first, pullRequest: { ...first.pullRequest, mergeable: 'MERGEABLE' } } })
  expect(result.current.loadState).toBe(loadState)
})

const filePatch = (path: string) => `diff --git a/${path} b/${path}
index 1111111111111111111111111111111111111111..2222222222222222222222222222222222222222 100644
--- a/${path}
+++ b/${path}
@@ -1,1 +1,1 @@
-old
+new
`

type ProgressListener = (progress: LocalReviewProgress) => void

/**
 * A repository whose working-tree reply overtakes its own pages, the way
 * Electron delivers them when the reply and the progress events race: the
 * reply lands first, the pages after it, then `done`.
 */
function racingRepository(pagesBeforeReply: string[], pagesAfterReply: string[]) {
  const listeners = new Set<ProgressListener>()
  const getComparison = mock(async () => {
    throw new Error('a streamed review must not page files one by one')
  })
  const emit = (requestId: string, progress: LocalReviewProgress) => {
    for (const listener of listeners) listener({ ...progress, requestId })
  }
  const page = (requestId: string, patch: string) => emit(requestId, {
    kind: 'files', selector: 'working-tree', patch, files: [], omittedFiles: []
  })
  window.repository = {
    getComparison,
    onLocalReviewProgress: (listener: ProgressListener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getWorkingTreePatch: async (_paths: string[], requestId: string) => {
      for (const patch of pagesBeforeReply) page(requestId, patch)
      setTimeout(() => {
        for (const patch of pagesAfterReply) page(requestId, patch)
        emit(requestId, { kind: 'done', selector: 'working-tree', fileCount: 0 })
      }, 20)
      return { patch: '', omittedFiles: [] }
    }
  } as unknown as RepositoryApi
  return { getComparison }
}

const folderPaths = ['a.ts', 'b.ts', 'c.ts']

for (const [label, before, after] of [
  ['before any page', [], [filePatch('a.ts'), `${filePatch('b.ts')}${filePatch('c.ts')}`]],
  ['after the first page', [filePatch('a.ts')], [`${filePatch('b.ts')}${filePatch('c.ts')}`]]
] as const) {
  test(`a folder review keeps every streamed page when the reply lands ${label}`, async () => {
    const { getComparison } = racingRepository([...before], [...after])
    const { result } = renderHook(() => useReviewLoadState({
      pathsKey: folderPaths.join('\0'),
      stablePaths: folderPaths,
      repositoryReview: null,
      repositoryChange: null,
      worldId: 'desk:/repo'
    }))
    await waitFor(() => expect(result.current.loadState.loadedPaths.size).toBe(folderPaths.length))
    expect(result.current.loadState.items.map((item) => item.id)).toEqual(
      folderPaths.map((path) => reviewItemId(path))
    )
    expect(result.current.loadState.paged).toBe(false)
    expect(getComparison).not.toHaveBeenCalled()
  })
}

test('a reload cut short by a newer change still lands with the next one', async () => {
  const versions: Record<string, string> = { 'a.ts': 'v1', 'b.ts': 'v1' }
  let slowNextPatch = false
  const changePatch = (path: string) => `diff --git a/${path} b/${path}
index 1111111..${versions[path] === 'v1' ? '2222222' : '3333333'} 100644
--- a/${path}
+++ b/${path}
@@ -1,1 +1,1 @@
-old
+${path} ${versions[path]}
`
  window.repository = {
    getWorkingTreePatch: async (paths: string[]) => {
      if (slowNextPatch) {
        slowNextPatch = false
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      return { patch: paths.map(changePatch).join(''), omittedFiles: [] }
    }
  } as unknown as RepositoryApi
  const paths = ['a.ts', 'b.ts']
  type Props = { repositoryChange: Parameters<typeof useReviewLoadState>[0]['repositoryChange'] }
  const { result, rerender } = renderHook(({ repositoryChange }: Props) => useReviewLoadState({
    pathsKey: paths.join('\0'), stablePaths: paths, repositoryReview: null, repositoryChange, worldId: null, root: '/repo'
  }), { initialProps: { repositoryChange: null } as Props })
  await waitFor(() => expect(result.current.loadState.items).toHaveLength(2))
  const shown = (path: string): string => {
    const item = result.current.loadState.items.find((candidate) => candidate.id === reviewItemId(path))
    return item?.type === 'diff' ? item.fileDiff.additionLines.join('') : ''
  }

  // a.ts's reload is still waiting for its patch when b.ts changes.
  versions['a.ts'] = 'v2'
  slowNextPatch = true
  rerender({ repositoryChange: { changedPaths: ['a.ts'], revision: 1 } as unknown as Props['repositoryChange'] })
  await new Promise((resolve) => setTimeout(resolve, 30))
  versions['b.ts'] = 'v2'
  rerender({ repositoryChange: { changedPaths: ['b.ts'], revision: 2 } as unknown as Props['repositoryChange'] })

  await waitFor(() => expect(shown('b.ts')).toContain('b.ts v2'))
  expect(shown('a.ts')).toContain('a.ts v2')
})
