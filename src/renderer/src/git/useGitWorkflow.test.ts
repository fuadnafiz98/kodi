import { describe, expect, it } from 'bun:test'

import { GIT_PANEL_TTL_MS, isPanelDataStale, type PanelCacheEntry } from './useGitWorkflow'

const entry = (overrides: Partial<PanelCacheEntry<string>> = {}): PanelCacheEntry<string> => ({
  data: 'value',
  fetchedAt: 1_000,
  root: null,
  head: 'abc',
  branch: 'main',
  ...overrides
})

const at = (head: string | null, branch: string | null): { head: string | null; branch: string | null } =>
  ({ head, branch })

describe('isPanelDataStale', () => {
  it('treats an empty entry as stale', () => {
    expect(isPanelDataStale(entry({ data: null }), at('abc', 'main'), 1_000)).toBe(true)
  })

  it('serves a fresh entry inside the TTL', () => {
    expect(isPanelDataStale(entry(), at('abc', 'main'), 1_000 + GIT_PANEL_TTL_MS - 1)).toBe(false)
  })

  it('expires once the TTL has elapsed', () => {
    expect(isPanelDataStale(entry(), at('abc', 'main'), 1_000 + GIT_PANEL_TTL_MS)).toBe(true)
  })

  it('expires immediately when HEAD or the branch moved', () => {
    expect(isPanelDataStale(entry(), at('def', 'main'), 1_001)).toBe(true)
    expect(isPanelDataStale(entry(), at('abc', 'feature'), 1_001)).toBe(true)
  })

  it('never serves panel data from another repository with the same branch and HEAD', () => {
    expect(isPanelDataStale(
      entry({ root: '/repo-a' }),
      { root: '/repo-b', head: 'abc', branch: 'main' },
      1_001
    )).toBe(true)
  })

  it('ignores the snapshot before one is loaded', () => {
    expect(isPanelDataStale(entry(), null, 1_001)).toBe(false)
  })
})
