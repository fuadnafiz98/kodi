import { afterEach, describe, expect, mock, test } from 'bun:test'

import type { AgentRequestSubject, RepositoryApi, RepositoryChangeEvent } from '../../../shared/contracts'
import type { ReviewGuideProgressEvent, ReviewGuideReply, ReviewGuideRequest } from '../../../shared/reviewGuide'
import { reviewGuideHost } from '../review/reviewGuideView'
import { reviewGuideStore } from './reviewGuideStore'
import { testGuide } from './testGuide'

const agent = { provider: 'codex', model: 'gpt-test', effort: 'default' } as const
let nextTab = 0
const subject = (): AgentRequestSubject =>
  ({ tabId: `desk:/repo-${++nextTab}`, repositoryRoot: `/repo-${nextTab}`, source: 'workingTree' }) as AgentRequestSubject

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

// The review creates the host before the Guide chunk loads; so do the tests.
reviewGuideHost()

afterEach(() => {
  delete window.repository
})

describe('reviewGuideStore', () => {
  test('a request shows loading, then the guide, and the switch dot follows', async () => {
    const reply = deferred<ReviewGuideReply>()
    const getReviewGuide = mock((_request: ReviewGuideRequest) => reply.promise)
    window.repository = { getReviewGuide } as unknown as RepositoryApi
    const target = subject()
    const pending = reviewGuideStore.request(target.tabId, target, agent)
    expect(reviewGuideStore.get(target.tabId).status).toBe('loading')
    expect(reviewGuideHost().status(target.tabId)).toBe('loading')
    reply.resolve({ status: 'ready', guide: testGuide(), cached: false })
    await pending
    expect(reviewGuideStore.get(target.tabId).status).toBe('ready')
    expect(reviewGuideStore.get(target.tabId).guide?.title).toBe('Teach the parser comments')
    expect(reviewGuideHost().status(target.tabId)).toBe('ready')
    expect(getReviewGuide.mock.calls[0]![0]).toEqual({ subject: target, ...agent })
  })

  test('cachedOnly asks the disk once and stays idle when nothing is stored', async () => {
    const getReviewGuide = mock(async (_request: ReviewGuideRequest): Promise<ReviewGuideReply> =>
      ({ status: 'unavailable', reason: 'none', code: 'not-cached' }))
    window.repository = { getReviewGuide } as unknown as RepositoryApi
    const target = subject()
    await reviewGuideStore.request(target.tabId, target, agent, { cachedOnly: true })
    await reviewGuideStore.request(target.tabId, target, agent, { cachedOnly: true })
    expect(getReviewGuide).toHaveBeenCalledTimes(1)
    expect(getReviewGuide.mock.calls[0]![0]).toMatchObject({ cachedOnly: true })
    expect(reviewGuideStore.get(target.tabId).status).toBe('idle')
  })

  test('a failure carries its reason and code', async () => {
    window.repository = {
      getReviewGuide: async (): Promise<ReviewGuideReply> => ({ status: 'unavailable', reason: 'Sign in first.', code: 'not-connected' })
    } as unknown as RepositoryApi
    const target = subject()
    await reviewGuideStore.request(target.tabId, target, agent)
    expect(reviewGuideStore.get(target.tabId)).toMatchObject({ status: 'unavailable', reason: 'Sign in first.', code: 'not-connected' })
  })

  test('cancel tells main, keeps the last guide, and drops the late reply', async () => {
    const first = deferred<ReviewGuideReply>()
    const second = deferred<ReviewGuideReply>()
    const replies = [
      Promise.resolve<ReviewGuideReply>({ status: 'ready', guide: testGuide(), cached: false }),
      first.promise,
      second.promise
    ]
    const cancelReviewGuide = mock(async () => {})
    window.repository = { getReviewGuide: () => replies.shift()!, cancelReviewGuide } as unknown as RepositoryApi
    const target = subject()
    await reviewGuideStore.request(target.tabId, target, agent)
    const regenerating = reviewGuideStore.request(target.tabId, target, agent, { force: true })
    expect(reviewGuideStore.get(target.tabId).status).toBe('loading')
    reviewGuideStore.cancel(target.tabId)
    expect(cancelReviewGuide).toHaveBeenCalledWith(target.tabId)
    expect(reviewGuideStore.get(target.tabId).status).toBe('ready')
    first.resolve({ status: 'unavailable', reason: 'cancelled', code: 'cancelled' })
    await regenerating
    expect(reviewGuideStore.get(target.tabId).status).toBe('ready')
    expect(reviewGuideStore.get(target.tabId).guide?.title).toBe('Teach the parser comments')
  })

  test('progress names the phase; a file change marks a working-tree guide stale', async () => {
    let onProgress: ((event: ReviewGuideProgressEvent) => void) | null = null
    let onChange: ((event: RepositoryChangeEvent) => void) | null = null
    const reply = deferred<ReviewGuideReply>()
    window.repository = {
      getReviewGuide: () => reply.promise,
      onReviewGuideProgress: (listener: typeof onProgress) => { onProgress = listener; return () => {} },
      onDidChange: (listener: typeof onChange) => { onChange = listener; return () => {} }
    } as unknown as RepositoryApi
    reviewGuideStore.connect(reviewGuideHost())
    const target = { tabId: 'desk:/stale', repositoryRoot: '/stale', source: 'workingTree' } as AgentRequestSubject
    const pending = reviewGuideStore.request(target.tabId, target, agent)
    onProgress!({ tabId: target.tabId, phase: 'writing' })
    expect(reviewGuideStore.get(target.tabId).phase).toBe('writing')
    reply.resolve({ status: 'ready', guide: testGuide(), cached: false })
    await pending
    onChange!({ snapshot: { root: '/stale' }, changedPaths: ['README.md'] } as unknown as RepositoryChangeEvent)
    expect(reviewGuideStore.get(target.tabId).stale).toBe(false)
    onChange!({ snapshot: { root: '/stale' }, changedPaths: ['src/c.ts'] } as unknown as RepositoryChangeEvent)
    expect(reviewGuideStore.get(target.tabId).stale).toBe(true)
    expect([...reviewGuideStore.get(target.tabId).stalePaths]).toEqual(['src/c.ts'])
    reviewGuideHost().forget(target.tabId)
    expect(reviewGuideStore.get(target.tabId).status).toBe('idle')
  })
})
