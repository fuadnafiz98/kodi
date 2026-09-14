import { afterEach, expect, test } from 'bun:test'
import { cleanup, renderHook, waitFor } from '@testing-library/react'

import type { PullRequestReview, RepositoryApi } from '../../../shared/contracts'
import { usePullRequestConversation } from './usePullRequestConversation'
import { worldViewCache } from '../review/worldViewCache'

afterEach(() => {
  cleanup()
  worldViewCache.clear()
})

const review = (number: number): PullRequestReview => ({
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
    updatedAt: '2026-09-01T00:00:00Z',
    additions: 1,
    deletions: 0,
    changedFiles: 1
  },
  files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
  patch: '',
  omittedFiles: [],
  expectedFileCount: 1
})

test('a cached conversation is restored without an immediate refetch', async () => {
  const fetches: string[] = []
  window.repository = {
    getPullRequestConversation: async (_root: string, selector: string) => {
      fetches.push(selector)
      return {
        available: true,
        message: null,
        body: `body-${selector}`,
        threads: [],
        reviews: []
      }
    }
  } as unknown as RepositoryApi

  const { result, rerender } = renderHook(
    ({ worldId, number }: { worldId: string; number: number }) =>
      usePullRequestConversation('/repo', review(number), () => {}, worldId),
    { initialProps: { worldId: 'patch:1', number: 1 } }
  )

  await waitFor(() => expect(result.current.conversation?.body).toBe('body-1'))
  expect(fetches).toEqual(['1'])

  rerender({ worldId: 'patch:2', number: 2 })
  await waitFor(() => expect(result.current.conversation?.body).toBe('body-2'))
  expect(fetches).toEqual(['1', '2'])

  rerender({ worldId: 'patch:1', number: 1 })
  expect(result.current.conversation?.body).toBe('body-1')
  await new Promise((resolve) => window.setTimeout(resolve, 30))
  expect(fetches).toEqual(['1', '2'])
})
