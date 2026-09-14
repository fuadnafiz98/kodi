import { afterEach, describe, expect, it } from 'bun:test'

import type { ReviewThread } from './ReviewComments'
import {
  parseStoredReviewThreads,
  reviewThreadStorageKey,
  saveStoredReviewThreads
} from './reviewThreadStorage'

afterEach(() => localStorage.clear())

const validThread = {
  id: 'thread-1',
  body: 'Rename this variable.',
  lineNumber: 4,
  range: { start: 4, end: 6 },
  replies: [],
  resolved: false
}

describe('reviewThreadStorageKey', () => {
  it('scopes keys by repository root and review identity', () => {
    expect(reviewThreadStorageKey('/repo', 'working-tree'))
      .toBe('kodi:review-threads:/repo:working-tree')
    expect(reviewThreadStorageKey('/repo', 'github:https://github.com/a/b/pull/1'))
      .not.toBe(reviewThreadStorageKey('/repo', 'working-tree'))
  })
})

describe('parseStoredReviewThreads', () => {
  it('round-trips valid thread maps', () => {
    const stored = JSON.stringify({ 'src/a.ts': [validThread] })
    expect(parseStoredReviewThreads(stored)).toEqual({ 'src/a.ts': [validThread] })
  })

  it('round-trips anchor and orphan state', () => {
    const anchored: ReviewThread = {
      ...validThread,
      orphaned: true,
      anchor: {
        version: 1, selectedText: 'value', beforeContextHash: 'before',
        afterContextHash: 'after', side: 'additions', blobOid: 'a'.repeat(40)
      }
    }
    expect(parseStoredReviewThreads(JSON.stringify({ 'src/a.ts': [anchored] })))
      .toEqual({ 'src/a.ts': [anchored] })
  })

  it('returns an empty map for missing or corrupt payloads', () => {
    expect(parseStoredReviewThreads(null)).toEqual({})
    expect(parseStoredReviewThreads('not json')).toEqual({})
    expect(parseStoredReviewThreads('[1,2]')).toEqual({})
    expect(parseStoredReviewThreads('"text"')).toEqual({})
  })

  it('drops malformed threads while keeping valid ones', () => {
    const stored = JSON.stringify({
      'src/a.ts': [
        validThread,
        { ...validThread, id: 'bad-range', range: { start: '4', end: 6 } },
        { ...validThread, id: 'bad-reply', replies: [{ id: 1, body: 'invalid' }] },
        { id: 42, body: 'missing fields' }
      ],
      'src/b.ts': [{ body: 'no id' }],
      'src/c.ts': 'not an array'
    })
    expect(parseStoredReviewThreads(stored)).toEqual({ 'src/a.ts': [validThread] })
  })
})

describe('saveStoredReviewThreads', () => {
  it('returns false when the payload exceeds the per-key cap', () => {
    const threads = {
      'src/a.ts': Array.from({ length: 4_000 }, (_unused, index) => ({
        ...validThread,
        id: `thread-${index}`,
        body: 'x'.repeat(200)
      }))
    }
    expect(saveStoredReviewThreads('kodi:review-threads:/repo:test', threads)).toBe(false)
  })
})
