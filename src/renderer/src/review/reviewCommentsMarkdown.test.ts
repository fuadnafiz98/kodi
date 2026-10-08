import { describe, expect, test } from 'bun:test'
import { parseDiffFromFile, type CodeViewItem } from '@pierre/diffs'

import type { ReviewThread } from './ReviewComments'
import { formatReviewCommentsMarkdown } from './reviewCommentsMarkdown'

const before = Array.from({ length: 12 }, (_unused, index) => `line ${index + 1}`).join('\n') + '\n'
const after = before.replace('line 6\n', 'line six\n').replace('line 7\n', '')
const item = { id: 'review:src/a.ts', type: 'diff', fileDiff: parseDiffFromFile({ name: 'src/a.ts', contents: before }, { name: 'src/a.ts', contents: after }) } as CodeViewItem<unknown>
const thread = (overrides: Partial<ReviewThread>): ReviewThread => ({
  id: 't', body: 'Why six?', lineNumber: 6, side: 'additions', range: { start: 6, end: 6, side: 'additions' },
  replies: [], resolved: false, ...overrides
})

describe('formatReviewCommentsMarkdown', () => {
  test('quotes the commented row with three rows of context, new-side numbers', () => {
    const markdown = formatReviewCommentsMarkdown([{ path: 'src/a.ts', thread: thread({}) }], () => item)
    expect(markdown).toBe([
      '# Address these review comments',
      '',
      '1. **src/a.ts** (New line 6)',
      '',
      '```diff',
      ' 3 line 3',
      ' 4 line 4',
      ' 5 line 5',
      '-6 line 6',
      '-7 line 7',
      '+6 line six',
      ' 7 line 8',
      ' 8 line 9',
      ' 9 line 10',
      '```',
      '',
      '> Why six?',
      ''
    ].join('\n'))
  })

  test('the old side, ranges, replies, orphans and file order', () => {
    const markdown = formatReviewCommentsMarkdown([
      { path: 'src/b.ts', thread: thread({ id: 'b', body: 'B', orphaned: true }) },
      { path: 'src/a.ts', thread: thread({ id: 'old', body: 'Gone?', range: { start: 6, end: 7, side: 'deletions' }, replies: [{ id: 'r', body: 'Yes.' } as ReviewThread['replies'][number]] }) }
    ], (path) => path === 'src/a.ts' ? item : undefined, { heading: '## Notes' })
    expect(markdown.startsWith('## Notes\n\n1. **src/a.ts** (Old lines 6–7)')).toBe(true)
    expect(markdown).toContain('> Gone?\n\n> Yes.')
    expect(markdown).toContain('2. **src/b.ts** (New line 6) [orphaned — verify location]\n\n> B')
  })

  test('a fence outgrows backticks in the code', () => {
    const code = { id: 'review:x.md', type: 'file', file: { name: 'x.md', contents: 'a\n```js\nb\n' } } as CodeViewItem<unknown>
    const markdown = formatReviewCommentsMarkdown([{ path: 'x.md', thread: thread({ range: { start: 2, end: 2, side: 'additions' } }) }], () => code)
    expect(markdown).toContain('````diff\n')
  })
})
