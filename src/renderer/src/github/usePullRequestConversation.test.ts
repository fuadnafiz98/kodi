import { describe, expect, it } from 'bun:test'

import type { PullRequestConversation, RemoteReviewThread } from '../../../shared/contracts'
import {
  groupRemoteThreadsByPath,
  nextConversationPollDelay,
  outdatedRemoteThreads,
  sameConversation
} from './usePullRequestConversation'

describe('nextConversationPollDelay', () => {
  it('stays at the base interval while GitHub answers', () => {
    expect(nextConversationPollDelay(30_000, true)).toBe(30_000)
    expect(nextConversationPollDelay(240_000, true)).toBe(30_000)
  })

  it('doubles while GitHub is unavailable and stops at five minutes', () => {
    expect(nextConversationPollDelay(30_000, false)).toBe(60_000)
    expect(nextConversationPollDelay(60_000, false)).toBe(120_000)
    expect(nextConversationPollDelay(240_000, false)).toBe(300_000)
    expect(nextConversationPollDelay(300_000, false)).toBe(300_000)
  })
})

const thread = (overrides: Partial<RemoteReviewThread> = {}): RemoteReviewThread => ({
  id: 'thread-1',
  path: 'src/a.ts',
  line: 4,
  startLine: null,
  originalLine: 4,
  originalStartLine: null,
  diffHunk: '@@ -1,2 +1,3 @@',
  side: 'RIGHT',
  resolved: false,
  outdated: false,
  comments: [{ id: 'comment-1', body: 'Rename this.', authorLogin: 'reviewer', authorAvatarUrl: '', createdAt: '2026-08-17T10:00:00Z' }],
  ...overrides
})

const conversation = (overrides: Partial<PullRequestConversation> = {}): PullRequestConversation => ({
  available: true,
  message: null,
  body: 'Adds the inbox.',
  headOid: 'a'.repeat(40),
  threads: [thread()],
  reviews: [],
  ...overrides
})

describe('groupRemoteThreadsByPath', () => {
  it('groups threads by their file path', () => {
    const grouped = groupRemoteThreadsByPath([
      thread(),
      thread({ id: 'thread-2' }),
      thread({ id: 'thread-3', path: 'src/b.ts' })
    ])
    expect([...grouped.keys()]).toEqual(['src/a.ts', 'src/b.ts'])
    expect(grouped.get('src/a.ts')?.map((entry) => entry.id)).toEqual(['thread-1', 'thread-2'])
  })

  it('returns an empty map for no threads', () => {
    expect(groupRemoteThreadsByPath([]).size).toBe(0)
  })

  // GitHub nulls `line` once a push moves the code. Falling back to line 1 put
  // every stranded comment at the top of the file, on unrelated code.
  it('leaves stranded threads out of the diff instead of anchoring them at line 1', () => {
    const grouped = groupRemoteThreadsByPath([
      thread(),
      thread({ id: 'thread-2', outdated: true, line: null, startLine: null }),
      thread({ id: 'thread-3', line: null, startLine: null })
    ])
    expect(grouped.get('src/a.ts')?.map((entry) => entry.id)).toEqual(['thread-1'])
  })

  it('collects the stranded threads for the pull request context', () => {
    const outdated = thread({ id: 'thread-2', outdated: true, line: null, startLine: null })
    expect(outdatedRemoteThreads(conversation({ threads: [thread(), outdated] })).map((entry) => entry.id))
      .toEqual(['thread-2'])
    expect(outdatedRemoteThreads(null)).toEqual([])
  })
})

describe('sameConversation', () => {
  it('treats an identical poll result as unchanged', () => {
    expect(sameConversation(conversation(), conversation())).toBe(true)
  })

  // The head is how an open review learns of a push. Ignoring it kept the old
  // object on every poll after one, and the "Load new commits" button never came.
  it('detects a push that changed nothing but the head commit', () => {
    expect(sameConversation(conversation(), conversation({ headOid: 'b'.repeat(40) }))).toBe(false)
  })

  it('never matches a missing previous conversation', () => {
    expect(sameConversation(null, conversation())).toBe(false)
  })

  it('detects new comments, replies, and resolution changes', () => {
    expect(sameConversation(conversation(), conversation({ threads: [thread({ resolved: true })] }))).toBe(false)
    expect(sameConversation(conversation(), conversation({ threads: [thread({ outdated: true })] }))).toBe(false)
    expect(sameConversation(conversation(), conversation({
      threads: [thread({ comments: [...thread().comments, { id: 'comment-2', body: 'Reply', authorLogin: 'other', authorAvatarUrl: '', createdAt: '2026-08-17T11:00:00Z' }] })]
    }))).toBe(false)
    expect(sameConversation(conversation(), conversation({
      threads: [thread({ comments: [{ id: 'comment-1', body: 'Edited.', authorLogin: 'reviewer', authorAvatarUrl: '', createdAt: '2026-08-17T10:00:00Z' }] })]
    }))).toBe(false)
  })

  it('detects new threads, reviews, description edits, and availability changes', () => {
    expect(sameConversation(conversation(), conversation({ threads: [] }))).toBe(false)
    expect(sameConversation(conversation(), conversation({ body: 'Rewritten.' }))).toBe(false)
    expect(sameConversation(conversation(), conversation({
      reviews: [{ id: 'review-1', state: 'APPROVED', body: '', authorLogin: 'reviewer', authorAvatarUrl: '', submittedAt: null }]
    }))).toBe(false)
    expect(sameConversation(conversation(), conversation({ available: false, message: 'gh missing' }))).toBe(false)
  })

  it('detects avatar changes on comments and reviews', () => {
    expect(sameConversation(conversation(), conversation({
      threads: [thread({
        comments: [{ ...thread().comments[0]!, authorAvatarUrl: 'https://avatars.example/c.png' }]
      })]
    }))).toBe(false)
    const review = { id: 'review-1', state: 'APPROVED', body: '', authorLogin: 'reviewer', submittedAt: null }
    expect(sameConversation(
      conversation({ reviews: [{ ...review, authorAvatarUrl: '' }] }),
      conversation({ reviews: [{ ...review, authorAvatarUrl: 'https://avatars.example/r.png' }] })
    )).toBe(false)
  })

  it('detects coordinate-only and timestamp-only anchor changes', () => {
    expect(sameConversation(conversation(), conversation({
      threads: [thread({ path: 'src/b.ts' })]
    }))).toBe(false)
    expect(sameConversation(conversation(), conversation({
      threads: [thread({ startLine: 2, side: 'LEFT' })]
    }))).toBe(false)
    expect(sameConversation(conversation(), conversation({
      threads: [thread({ comments: [{ ...thread().comments[0]!, createdAt: '2026-08-18T10:00:00Z' }] })]
    }))).toBe(false)
  })
})
