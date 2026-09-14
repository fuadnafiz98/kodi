import { beforeEach, expect, test } from 'bun:test'

import type { InboxPullRequest, PullRequestInboxSectionKey, PullRequestInboxSnapshot } from '../../../shared/contracts'
import {
  readWelcomeInboxCache,
  readWelcomeInboxRepos,
  resetWelcomeInboxCacheForTests,
  touchWelcomeInboxCache,
  WELCOME_INBOX_ASSUMED_ROWS,
  WELCOME_INBOX_LIMIT,
  welcomeInboxExpectedRows,
  welcomeInboxIsStale,
  welcomeInboxRepos,
  welcomeInboxRows,
  writeWelcomeInboxCache
} from './welcomeInbox'

function pullRequest(overrides: Partial<InboxPullRequest> = {}): InboxPullRequest {
  return {
    number: 12,
    title: 'Ship it',
    url: 'https://github.com/acme/core/pull/12',
    state: 'open',
    isDraft: false,
    author: { login: 'octocat' },
    updatedAt: '2026-09-01T10:00:00Z',
    ...overrides
  }
}

function snapshot(sections: Array<[PullRequestInboxSectionKey, InboxPullRequest[]]>): PullRequestInboxSnapshot {
  return {
    available: true,
    message: null,
    sections: sections.map(([key, pullRequests]) => ({ key, title: key, pullRequests }))
  }
}

beforeEach(() => {
  resetWelcomeInboxCacheForTests()
  localStorage.clear()
})

test('welcomeInboxRows > needs-you sections come first, freshest inside each', () => {
  const rows = welcomeInboxRows(snapshot([
    ['authored', [pullRequest({ url: 'https://github.com/acme/core/pull/9', number: 9, updatedAt: '2026-09-03T10:00:00Z' })]],
    ['review-requested', [
      pullRequest({ url: 'https://github.com/acme/core/pull/7', number: 7, updatedAt: '2026-09-01T10:00:00Z' }),
      pullRequest({ url: 'https://github.com/acme/core/pull/8', number: 8, updatedAt: '2026-09-02T10:00:00Z' })
    ]]
  ]))

  expect(rows.map((row) => row.number)).toEqual([8, 7, 9])
  expect(rows[0]?.key).toBe('review-requested')
})

test('welcomeInboxRows > dedupes a pull request claimed by two sections', () => {
  const shared = pullRequest({ url: 'https://github.com/acme/core/pull/5', number: 5 })
  const rows = welcomeInboxRows(snapshot([
    ['review-requested', [shared]],
    ['assigned', [{ ...shared }]]
  ]))

  expect(rows).toHaveLength(1)
  expect(rows[0]?.key).toBe('review-requested')
})

test('welcomeInboxRows > caps the feed and derives the repo slug from the url', () => {
  const many = Array.from({ length: WELCOME_INBOX_LIMIT + 3 }, (_, index) =>
    pullRequest({ url: `https://github.com/acme/core/pull/${index + 1}`, number: index + 1 }))
  const rows = welcomeInboxRows(snapshot([['assigned', many]]))

  expect(rows).toHaveLength(WELCOME_INBOX_LIMIT)
  expect(rows[0]?.repo).toBe('acme/core')
})

test('welcomeInboxRows > an unavailable or empty inbox stays off the welcome screen', () => {
  expect(welcomeInboxRows(null)).toEqual([])
  expect(welcomeInboxRows({ available: false, message: 'gh missing', sections: [] })).toEqual([])
  expect(welcomeInboxRows(snapshot([['assigned', []]]))).toEqual([])
})

test('welcome inbox cache > round-trips rows and survives junk', () => {
  const rows = welcomeInboxRows(snapshot([['review-requested', [pullRequest()]]]))
  writeWelcomeInboxCache(rows)
  resetWelcomeInboxCacheForTests()

  expect(readWelcomeInboxCache()).toHaveLength(1)
  expect(readWelcomeInboxCache()[0]?.number).toBe(12)

  localStorage.setItem('kodi:welcome-inbox:v1', '{"rows":[{"nope":true}],"fetchedAt":1}')
  resetWelcomeInboxCacheForTests()
  expect(readWelcomeInboxCache()).toEqual([])
})

test('welcomeInboxRepos > collects every repository in the snapshot, sorted', () => {
  expect(welcomeInboxRepos(snapshot([
    ['authored', [
      pullRequest({ url: 'https://github.com/zeta/core/pull/1' }),
      pullRequest({ url: 'https://github.com/acme/app/pull/2' }),
      pullRequest({ url: 'https://github.com/acme/app/pull/3' })
    ]]
  ]))).toEqual(['acme/app', 'zeta/core'])
  expect(welcomeInboxRepos(null)).toEqual([])
})

test('welcome inbox cache > a changed repo scope counts as stale', () => {
  const rows = welcomeInboxRows(snapshot([['review-requested', [pullRequest()]]]))
  writeWelcomeInboxCache(rows, ['acme/core'], '')

  expect(readWelcomeInboxCache('')).toHaveLength(1)
  expect(welcomeInboxIsStale('')).toBe(false)
  expect(readWelcomeInboxCache('acme/core')).toEqual([])
  expect(welcomeInboxIsStale('acme/core')).toBe(true)
})

test('welcomeInboxExpectedRows > assumes a count only until a fetch reports one', () => {
  expect(welcomeInboxExpectedRows()).toBe(WELCOME_INBOX_ASSUMED_ROWS)

  writeWelcomeInboxCache(welcomeInboxRows(snapshot([['assigned', [
    pullRequest({ url: 'https://github.com/acme/core/pull/1' }),
    pullRequest({ url: 'https://github.com/acme/core/pull/2' })
  ]]])))
  resetWelcomeInboxCacheForTests()
  expect(welcomeInboxExpectedRows()).toBe(2)
})

// A stored zero is knowledge: reserving space for rows that are not coming is
// the layout shift the placeholder exists to prevent.
test('welcomeInboxExpectedRows > reserves nothing once a fetch has reported an empty inbox', () => {
  writeWelcomeInboxCache([])
  resetWelcomeInboxCacheForTests()
  expect(welcomeInboxExpectedRows()).toBe(0)
})

test('welcomeInboxExpectedRows > a scope change keeps the count after the rows are dropped', () => {
  writeWelcomeInboxCache(welcomeInboxRows(snapshot([['assigned', [pullRequest()]]])), [], '')
  touchWelcomeInboxCache('acme/core')

  expect(readWelcomeInboxCache('acme/core')).toEqual([])
  expect(welcomeInboxExpectedRows()).toBe(1)
})

test('welcome inbox cache > a failed fetch under a new scope drops the old rows but keeps repos', () => {
  writeWelcomeInboxCache(
    welcomeInboxRows(snapshot([['review-requested', [pullRequest()]]])),
    ['acme/core', 'zeta/app'],
    ''
  )
  touchWelcomeInboxCache('acme/core')

  expect(readWelcomeInboxCache('acme/core')).toEqual([])
  expect(readWelcomeInboxRepos()).toEqual(['acme/core', 'zeta/app'])
})
