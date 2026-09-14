import { describe, expect, it } from 'bun:test'

import { fileNameFromReviewPath, formatReviewCommentsForAgent } from './ReviewSummary'

describe('formatReviewCommentsForAgent', () => {
  it('includes file, selected range, body, and replies', () => {
    const prompt = formatReviewCommentsForAgent([{
      path: 'src/app.ts',
      thread: {
        id: 'thread-1',
        body: 'Handle the error explicitly.',
        lineNumber: 8,
        side: 'additions',
        range: { start: 8, end: 10, side: 'additions' },
        replies: [{ id: 'reply-1', body: 'Preserve the original cause.' }],
        resolved: false
      }
    }])

    expect(prompt).toContain('src/app.ts — Lines 8–10 · new')
    expect(prompt).toContain('Handle the error explicitly.')
    expect(prompt).toContain('Reply: Preserve the original cause.')
  })

  it('warns the agent when a comment needs a human-selected location', () => {
    const prompt = formatReviewCommentsForAgent([{
      path: 'src/app.ts',
      thread: {
        id: 'thread-1', body: 'Keep this check.', lineNumber: 8,
        range: { start: 8, end: 8, side: 'additions' }, replies: [],
        resolved: false, orphaned: true
      }
    }])

    expect(prompt).toContain('[Orphaned — verify location]')
  })

  it('shows the file name, not the whole path, in the list', () => {
    expect(fileNameFromReviewPath('apps/web/src/route.ts')).toBe('route.ts')
    expect(fileNameFromReviewPath('LICENSE')).toBe('LICENSE')
  })
})
