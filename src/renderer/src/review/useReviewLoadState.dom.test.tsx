import { afterEach, expect, test } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'

import type { PullRequestReview } from '../../../shared/contracts'
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
