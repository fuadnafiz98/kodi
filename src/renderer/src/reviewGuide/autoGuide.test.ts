import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

import type { AgentRequestSubject, RepositoryApi } from '../../../shared/contracts'
import type { ReviewGuideReply, ReviewGuideRequest } from '../../../shared/reviewGuide'
import { reviewGuideHost } from '../review/reviewGuideView'
import { AUTO_GUIDE_MAX_FILES, autoGenerateGuide, autoGuideAllowed, resetAutoGuide, type AutoGuideCandidate } from './autoGuide'
import { reviewGuideStore } from './reviewGuideStore'
import { testGuide } from './testGuide'

reviewGuideHost()

const agent = { provider: 'codex', model: 'gpt-test', effort: 'default' } as const
let world = 0
function pullRequest(overrides: Partial<AutoGuideCandidate> = {}): { candidate: AutoGuideCandidate; subject: AgentRequestSubject } {
  const worldId = `patch:auto-${++world}`
  return {
    candidate: { worldId, kind: 'pull-request', headOid: 'abc', fileCount: 3, patchPages: ['diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n'], ...overrides },
    subject: { tabId: worldId, repositoryRoot: '/repo', source: 'pullRequest', headOid: 'abc' } as unknown as AgentRequestSubject
  }
}

let calls: ReviewGuideRequest[] = []
beforeEach(() => {
  calls = []
  resetAutoGuide()
  window.repository = {
    getReviewGuide: mock(async (request: ReviewGuideRequest): Promise<ReviewGuideReply> => {
      calls.push(request)
      return request.cachedOnly === true
        ? { status: 'unavailable', reason: 'none', code: 'not-cached' }
        : { status: 'ready', guide: testGuide(), cached: false }
    }),
    onReviewGuideProgress: () => () => {},
    onDidChange: () => () => {}
  } as unknown as RepositoryApi
})

afterEach(() => {
  delete window.repository
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('autoGenerateGuide', () => {
  test('a ready pull request asks the cache, then writes the guide once', async () => {
    const { candidate, subject } = pullRequest()
    expect(autoGenerateGuide('pull-requests', candidate, subject, agent)).toBe(true)
    await settle()
    await settle()
    expect(calls.map((call) => call.cachedOnly === true)).toEqual([true, false])
    expect(reviewGuideStore.get(candidate.worldId).status).toBe('ready')
    expect(autoGenerateGuide('pull-requests', candidate, subject, agent)).toBe(false)
  })

  test('a stored guide makes no model call', async () => {
    window.repository!.getReviewGuide = mock(async (request: ReviewGuideRequest): Promise<ReviewGuideReply> => {
      calls.push(request)
      return { status: 'ready', guide: testGuide(), cached: true }
    })
    const { candidate, subject } = pullRequest()
    autoGenerateGuide('pull-requests', candidate, subject, agent)
    await settle()
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]!.cachedOnly).toBe(true)
  })

  test('off, or a comparison under pull-requests, asks nothing', () => {
    const first = pullRequest()
    expect(autoGenerateGuide('off', first.candidate, first.subject, agent)).toBe(false)
    const second = pullRequest({ kind: 'comparison' })
    expect(autoGenerateGuide('pull-requests', second.candidate, second.subject, agent)).toBe(false)
    expect(calls).toHaveLength(0)
    expect(autoGenerateGuide('all-reviews', second.candidate, second.subject, agent)).toBe(true)
  })

  test('a new head of the same pull request starts again', () => {
    const { candidate, subject } = pullRequest()
    expect(autoGenerateGuide('pull-requests', candidate, subject, agent)).toBe(true)
    reviewGuideStore.forget(candidate.worldId)
    expect(autoGenerateGuide('pull-requests', { ...candidate, headOid: 'def' }, subject, agent)).toBe(true)
  })

  test('the size guard leaves a big review to the reader', () => {
    expect(autoGuideAllowed('pull-requests', pullRequest({ fileCount: AUTO_GUIDE_MAX_FILES + 1 }).candidate)).toBe(false)
    const hunks = `diff --git a/x b/x\n${'@@ -1 +1 @@\n-a\n+b\n'.repeat(401)}`
    expect(autoGuideAllowed('pull-requests', pullRequest({ patchPages: [hunks] }).candidate)).toBe(false)
    expect(autoGuideAllowed('pull-requests', pullRequest({ fileCount: 0 }).candidate)).toBe(false)
    expect(autoGuideAllowed('pull-requests', pullRequest().candidate)).toBe(true)
  })
})
