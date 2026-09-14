import { describe, expect, it } from 'bun:test'

import { formatUpdatedAgo } from './GitHubPanel'
import { parsePullRequestSelector } from './pullRequestSelector'

describe('formatUpdatedAgo', () => {
  it('reads as fresh below five seconds', () => {
    expect(formatUpdatedAgo(0)).toBe('just now')
    expect(formatUpdatedAgo(4_999)).toBe('just now')
  })

  it('counts seconds, then minutes, then hours', () => {
    expect(formatUpdatedAgo(12_000)).toBe('12s ago')
    expect(formatUpdatedAgo(90_000)).toBe('1m ago')
    expect(formatUpdatedAgo(3 * 3_600_000)).toBe('3h ago')
  })

  it('never reports a negative or unusable elapsed time', () => {
    expect(formatUpdatedAgo(-1)).toBe('just now')
    expect(formatUpdatedAgo(Number.NaN)).toBe('just now')
  })
})

describe('parsePullRequestSelector', () => {
  it('accepts a number and hash-prefixed number', () => {
    expect(parsePullRequestSelector('42')).toBe(42)
    expect(parsePullRequestSelector(' #42 ')).toBe(42)
  })

  it('accepts a GitHub pull request URL', () => {
    expect(parsePullRequestSelector('https://github.com/pierrecomputer/pierre/pull/123/files'))
      .toBe('https://github.com/pierrecomputer/pierre/pull/123')
  })

  it('removes copied GitHub navigation details from the selector', () => {
    expect(parsePullRequestSelector(
      'https://github.com/pierrecomputer/pierre/pull/123?notification_referrer_id=abc#discussion_r1'
    )).toBe('https://github.com/pierrecomputer/pierre/pull/123')
    expect(parsePullRequestSelector('https://www.github.com/pierrecomputer/pierre/pull/123/files?diff=split'))
      .toBe('https://github.com/pierrecomputer/pierre/pull/123')
    expect(parsePullRequestSelector('please review https://github.com/pierrecomputer/pierre/pull/123 thanks'))
      .toBe('https://github.com/pierrecomputer/pierre/pull/123')
  })

  it('rejects invalid and unsafe values', () => {
    expect(parsePullRequestSelector('pull request 42')).toBeNull()
    expect(parsePullRequestSelector('https://example.com/owner/repo/pull/42')).toBeNull()
    expect(parsePullRequestSelector('https://github.com/owner/repo/issues/42')).toBeNull()
    expect(parsePullRequestSelector('https://user@github.com/owner/repo/pull/42')).toBeNull()
    expect(parsePullRequestSelector('0')).toBeNull()
  })
})
