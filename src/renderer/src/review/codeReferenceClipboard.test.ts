import { describe, expect, it } from 'bun:test'

import type { ReviewThread } from './ReviewComments'
import {
  codeFromComparison,
  codeReferenceAddress,
  formatCodeReference,
  formatReviewComment,
  reviewCommentCode,
  type CodeReference
} from './codeReferenceClipboard'

function thread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'thread-1',
    body: 'Rename this.',
    lineNumber: 13,
    range: { start: 11, end: 13, side: 'additions', endSide: 'additions' },
    replies: [],
    resolved: false,
    ...overrides
  }
}

const anchor = {
  version: 1 as const,
  selectedText: 'const first = 1\nconst second = 2\nconst third = 3',
  beforeContextHash: 'a',
  afterContextHash: 'b',
  side: 'additions' as const,
  blobOid: null
}

const reference = (overrides: Partial<CodeReference> = {}): CodeReference => ({
  path: 'src/app/App.tsx',
  first: 12,
  last: 12,
  side: 'additions',
  ...overrides
})

describe('the address a copied reference carries', () => {
  it('names one line without a range', () => {
    expect(codeReferenceAddress(reference())).toBe('src/app/App.tsx:12')
  })

  it('orders the ends of an upward drag', () => {
    expect(codeReferenceAddress(reference({ first: 18, last: 12 }))).toBe('src/app/App.tsx:12-18')
  })

  // The same numbers name different code on the two sides of a diff.
  it('marks pre-change line numbers as old', () => {
    expect(codeReferenceAddress(reference({ side: 'deletions' }))).toBe('src/app/App.tsx:12 (old)')
  })
})

describe('a copied line', () => {
  it('is the address, then the line, fenced by extension', () => {
    expect(formatCodeReference(reference({ first: 17, last: 17 }), '    requests:'))
      .toBe('src/app/App.tsx:17\n\n```tsx\n    requests:\n```')
  })

  it('is the address alone when the line could not be read', () => {
    expect(formatCodeReference(reference(), null)).toBe('src/app/App.tsx:12')
  })

  it('reads the named lines out of the side they belong to', () => {
    expect(codeFromComparison(reference({ first: 2, last: 3 }), {
      additions: 'one\ntwo\nthree\nfour'
    })).toBe('two\nthree')
    expect(codeFromComparison(reference({ first: 1, last: 1, side: 'deletions' }), {
      additions: 'new',
      deletions: 'old'
    })).toBe('old')
    expect(codeFromComparison(reference({ first: 9, last: 9 }), { additions: 'one\ntwo' }))
      .toBe(null)
  })
})

describe('the code a copied comment carries', () => {
  it('prefers the exact text the comment was anchored to', () => {
    expect(reviewCommentCode(thread({ anchor }), { additions: 'other\nlines\nentirely' }))
      .toBe(anchor.selectedText)
  })

  it('reads the lines back out of the comparison when there is no anchor', () => {
    expect(reviewCommentCode(thread(), { additions: 'one\ntwo\nthree\nfour\nfive' }))
      .toBe(null)
    expect(reviewCommentCode(thread({ range: { start: 2, end: 3, side: 'additions' } }), {
      additions: 'one\ntwo\nthree\nfour\nfive'
    })).toBe('two\nthree')
  })

  it('reads the old file for a comment on a deleted line', () => {
    expect(reviewCommentCode(thread({ range: { start: 1, end: 1, side: 'deletions' } }), {
      additions: 'new',
      deletions: 'old'
    })).toBe('old')
  })

  it('answers nothing rather than a guess when the range is off the end', () => {
    expect(reviewCommentCode(thread({ range: { start: 9, end: 9, side: 'additions' } }), {
      additions: 'one\ntwo'
    })).toBe(null)
    expect(reviewCommentCode(thread())).toBe(null)
  })
})

describe('the markdown a copied comment produces', () => {
  it('leads with the address, then the code, then the comment', () => {
    expect(formatReviewComment('src/app/App.tsx', thread({ anchor }), anchor.selectedText)).toBe(
      'src/app/App.tsx:11-13\n'
      + '\n'
      + '```tsx\n'
      + 'const first = 1\nconst second = 2\nconst third = 3\n'
      + '```\n'
      + '\n'
      + 'Rename this.\n'
    )
  })

  it('carries the replies as the rest of the discussion', () => {
    const text = formatReviewComment('a.ts', thread({
      replies: [{ id: 'r1', body: 'Or delete it.' }, { id: 'r2', body: '  ' }]
    }), 'code')
    expect(text.endsWith('Rename this.\n\nOr delete it.\n')).toBe(true)
  })

  // Reviewing a markdown file means quoting backticks with backticks.
  it('opens a longer fence than the code contains', () => {
    const text = formatReviewComment('README.md', thread(), '```ts\nconst a = 1\n```')
    expect(text).toContain('````md\n```ts')
    expect(text.split('````')).toHaveLength(3)
  })

  it('skips the fence when the code could not be read', () => {
    expect(formatReviewComment('Makefile', thread(), null)).toBe('Makefile:11-13\n\nRename this.\n')
  })

  it('leaves the language off a file that has no extension', () => {
    expect(formatReviewComment('Makefile', thread(), 'all:')).toContain('```\nall:\n```')
  })
})
