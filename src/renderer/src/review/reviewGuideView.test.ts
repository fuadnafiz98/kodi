import { describe, expect, test } from 'bun:test'

import type { RepositoryApi } from '../../../shared/contracts'
import type { GuideAgentContext } from '../reviewGuide/reviewGuideHost'
import { considerAutoGuide, orderReviewItems, reviewGuideHost, toggleReviewView } from './reviewGuideView'
import type { ReviewWorld } from './useReviewWorlds'

describe('review guide host', () => {
  test('toggles a world between Diff and Guide and remembers it across a reload', () => {
    const host = reviewGuideHost()
    expect(host.view('w1')).toBe('diff')
    toggleReviewView('w1')
    expect(host.view('w1')).toBe('guide')
    expect(JSON.parse(localStorage.getItem('kodi:review-guide-view:v1')!)).toContain('w1')
    toggleReviewView('w1')
    expect(host.view('w1')).toBe('diff')
    toggleReviewView(null)
  })

  test('forgetting a world drops its view, order and status', () => {
    const host = reviewGuideHost()
    let forgotten = ''
    host.onForget = (worldId) => { forgotten = worldId }
    host.setView('w2', 'guide')
    host.setOrder('w2', { rank: new Map(), pills: new Map() })
    host.setStatus('w2', 'ready')
    const revision = host.revision
    host.forget('w2')
    expect(forgotten as string).toBe('w2')
    expect(host.view('w2')).toBe('diff')
    expect(host.order('w2')).toBeNull()
    expect(host.status('w2')).toBe('idle')
    expect(host.revision).toBeGreaterThan(revision)
    host.onForget = null
  })

  test('orders items by rank, unknown ones last in load order, and passes through without an order', () => {
    const items = [{ id: 'c' }, { id: 'x' }, { id: 'a' }, { id: 'y' }]
    expect(orderReviewItems(items, null)).toBe(items)
    const order = { rank: new Map([['a', 0], ['c', 1]]), pills: new Map() }
    expect(orderReviewItems(items, order).map((item) => item.id)).toEqual(['a', 'c', 'x', 'y'])
  })
})

describe('considerAutoGuide', () => {
  const agentFor = (worldId: string): GuideAgentContext => ({
    subject: { tabId: worldId, repositoryRoot: '/repo', repositoryName: 'repo', source: 'patch', baseOid: 'a', headOid: 'b' },
    provider: 'codex', model: 'm', effort: 'default', models: [], login: () => {}, openAgent: () => {}
  })
  const pullRequestWorld = (worldId: string, loadStatus: 'loading' | 'ready'): ReviewWorld => ({
    source: 'patch', worldId, label: '#1', root: '/repo', snapshot: { head: 'a', statuses: [] }, baseOid: 'a', headOid: 'b',
    generation: 1, requestId: null, loadStatus, errorMessage: null,
    review: { kind: 'github', files: [{ path: 'x' }], pullRequest: { url: 'https://github.com/a/b/pull/1' } },
    patchPages: ['diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n'], patchLength: 10
  }) as unknown as ReviewWorld

  test('a pull request opening opens on its Guide when asked, once', () => {
    considerAutoGuide(pullRequestWorld('pr-1', 'loading'), agentFor('pr-1'), { guideAutoGenerate: 'off', guideOpensFirst: true })
    expect(reviewGuideHost().view('pr-1')).toBe('guide')
    reviewGuideHost().setView('pr-1', 'diff')
    considerAutoGuide(pullRequestWorld('pr-1', 'loading'), agentFor('pr-1'), { guideAutoGenerate: 'off', guideOpensFirst: true })
    expect(reviewGuideHost().view('pr-1')).toBe('diff')
    considerAutoGuide(pullRequestWorld('pr-2', 'loading'), agentFor('pr-2'), { guideAutoGenerate: 'off', guideOpensFirst: false })
    expect(reviewGuideHost().view('pr-2')).toBe('diff')
  })

  test('a ready pull request starts its guide only when visible or allowed hidden, and only once', async () => {
    const calls: unknown[] = []
    window.repository = {
      getReviewGuide: async (request: unknown) => { calls.push(request); return { status: 'unavailable', reason: 'x', code: 'not-cached' } },
      onReviewGuideProgress: () => () => {},
      onDidChange: () => () => {}
    } as unknown as RepositoryApi
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    try {
      considerAutoGuide(pullRequestWorld('pr-3', 'ready'), agentFor('pr-3'), { guideAutoGenerate: 'pull-requests', guideOpensFirst: false })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(calls).toHaveLength(0)
      localStorage.setItem('kodi:guide-auto-hidden', '1')
      considerAutoGuide(pullRequestWorld('pr-3', 'loading'), agentFor('pr-3'), { guideAutoGenerate: 'pull-requests', guideOpensFirst: false })
      considerAutoGuide(pullRequestWorld('pr-3', 'ready'), agentFor('pr-3'), { guideAutoGenerate: 'off', guideOpensFirst: false })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(calls).toHaveLength(0)
      considerAutoGuide(pullRequestWorld('pr-3', 'ready'), agentFor('pr-3'), { guideAutoGenerate: 'pull-requests', guideOpensFirst: false })
      considerAutoGuide(pullRequestWorld('pr-3', 'ready'), agentFor('pr-3'), { guideAutoGenerate: 'pull-requests', guideOpensFirst: false })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls[0]).toMatchObject({ cachedOnly: true })
      const first = calls.length
      considerAutoGuide(pullRequestWorld('pr-3', 'ready'), agentFor('pr-3'), { guideAutoGenerate: 'pull-requests', guideOpensFirst: false })
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(calls).toHaveLength(first)
    } finally {
      localStorage.removeItem('kodi:guide-auto-hidden')
      delete (document as { visibilityState?: unknown }).visibilityState
      delete window.repository
    }
  })
})
