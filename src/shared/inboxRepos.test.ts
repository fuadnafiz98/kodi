import { describe, expect, it } from 'bun:test'

import { inboxRepoScope, inboxRepoSlug, MAX_INBOX_REPOS, normalizeInboxRepos } from './inboxRepos.js'

describe('inboxRepoSlug', () => {
  it('accepts a bare owner/name slug', () => {
    expect(inboxRepoSlug('pierre-code/kodi')).toBe('pierre-code/kodi')
    expect(inboxRepoSlug('  Acme/Core_1.x  ')).toBe('acme/core_1.x')
  })

  it('pulls the slug out of repository and pull-request URLs', () => {
    expect(inboxRepoSlug('https://github.com/acme/core')).toBe('acme/core')
    expect(inboxRepoSlug('https://github.com/Acme/Core/pull/42')).toBe('acme/core')
    expect(inboxRepoSlug('https://github.com/acme/core/issues?state=open')).toBe('acme/core')
  })

  it('rejects anything that is not a GitHub repository', () => {
    expect(inboxRepoSlug('kodi')).toBeNull()
    expect(inboxRepoSlug('acme/core/tree/main')).toBeNull()
    expect(inboxRepoSlug('https://gitlab.com/acme/core')).toBeNull()
    expect(inboxRepoSlug('http://github.com/acme/core')).toBeNull()
    expect(inboxRepoSlug('')).toBeNull()
    expect(inboxRepoSlug('owner//repo')).toBeNull()
  })
})

describe('normalizeInboxRepos', () => {
  it('drops non-strings and non-slugs, lowercases, and dedupes', () => {
    expect(normalizeInboxRepos([
      'Acme/Core',
      'https://github.com/acme/core/pull/9',
      'acme/core',
      42,
      'not a slug',
      'pierre/kodi'
    ])).toEqual(['acme/core', 'pierre/kodi'])
  })

  it('caps the list and returns empty for non-arrays', () => {
    expect(normalizeInboxRepos('acme/core')).toEqual([])
    expect(normalizeInboxRepos(undefined)).toEqual([])
    const many = Array.from({ length: MAX_INBOX_REPOS + 5 }, (_, index) => `acme/repo-${index}`)
    expect(normalizeInboxRepos(many)).toHaveLength(MAX_INBOX_REPOS)
  })
})

describe('inboxRepoScope', () => {
  it('joins slugs into repo: qualifiers, empty when unset', () => {
    expect(inboxRepoScope([])).toBe('')
    expect(inboxRepoScope(['acme/core', 'pierre/kodi'])).toBe('repo:acme/core repo:pierre/kodi')
  })
})
