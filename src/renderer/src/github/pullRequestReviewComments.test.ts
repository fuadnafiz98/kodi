import { describe, expect, it } from 'bun:test'

import type { ReviewThread } from '../review/ReviewComments'
import { createPullRequestReviewComments } from './pullRequestReviewComments'

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'thread-1',
    body: 'Check this range.',
    lineNumber: 4,
    range: { start: 4, end: 7, side: 'additions', endSide: 'additions' },
    replies: [],
    resolved: false,
    ...overrides
  }
}

describe('createPullRequestReviewComments', () => {
  it('maps a selected range to GitHub review coordinates', () => {
    expect(createPullRequestReviewComments({ 'src/value.ts': [thread()] })).toEqual([{
      path: 'src/value.ts',
      body: 'Check this range.',
      line: 7,
      side: 'RIGHT',
      startLine: 4,
      startSide: 'RIGHT'
    }])
  })

  it('uses the old side for deletions and omits unsafe drafts', () => {
    expect(createPullRequestReviewComments({
      'src/value.ts': [
        thread({ range: { start: 9, end: 9, side: 'deletions' } }),
        thread({ id: 'resolved', resolved: true }),
        thread({ id: 'orphaned', orphaned: true })
      ]
    })).toEqual([{
      path: 'src/value.ts',
      body: 'Check this range.',
      line: 9,
      side: 'LEFT'
    }])
  })
})
