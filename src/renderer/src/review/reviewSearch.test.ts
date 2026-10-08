import { describe, expect, test } from 'bun:test'
import { parseDiffFromFile, parsePatchFiles, type CodeViewItem } from '@pierre/diffs'

import {
  carryActiveIndex,
  findInLine,
  isCaseSensitive,
  nextMatchIndex,
  REVIEW_SEARCH_LIMIT,
  searchReviewItems
} from './reviewSearch'

const lines = (count: number, line: (index: number) => string): string =>
  Array.from({ length: count }, (_unused, index) => `${line(index)}\n`).join('')

function diffItem(path: string, before: string, after: string): CodeViewItem<unknown> {
  return {
    id: `review:${path}`,
    type: 'diff',
    fileDiff: parseDiffFromFile({ name: path, contents: before }, { name: path, contents: after })
  } as CodeViewItem<unknown>
}

describe('findInLine', () => {
  test('is case-insensitive unless the query has an uppercase letter', () => {
    expect(isCaseSensitive('needle')).toBe(false)
    expect(isCaseSensitive('Needle')).toBe(true)
    expect(findInLine('Needle and needle', 'needle')).toEqual([0, 11])
    expect(findInLine('Needle and needle', 'Needle')).toEqual([0])
  })

  test('lists every occurrence in a line, without overlaps', () => {
    expect(findInLine('aaaa', 'aa')).toEqual([0, 2])
    expect(findInLine('abc', '')).toEqual([])
  })
})

describe('searchReviewItems', () => {
  // 100 lines; line 40 rewritten and line 80 rewritten, so two hunks.
  const before = lines(100, (index) => `const value${index + 1} = ${index + 1}`)
  const after = lines(100, (index) => index + 1 === 40
    ? 'const value40 = needle(40)'
    : index + 1 === 80 ? 'const needle80 = 80' : `const value${index + 1} = ${index + 1}`)

  test('numbers matches by the line the review draws, on the right side', () => {
    const removed = diffItem('a.ts', lines(10, (index) => index === 4 ? 'old needle here' : `line ${index}`),
      lines(10, (index) => index === 4 ? 'new text here' : `line ${index}`))
    const added = diffItem('b.ts', before, after)
    const { matches, truncated } = searchReviewItems([removed, added], 'needle')
    expect(truncated).toBe(false)
    expect(matches).toEqual([
      { itemId: 'review:a.ts', side: 'deletions', lineNumber: 5, column: 4, length: 6 },
      { itemId: 'review:b.ts', side: 'additions', lineNumber: 40, column: 16, length: 6 },
      { itemId: 'review:b.ts', side: 'additions', lineNumber: 80, column: 6, length: 6 }
    ])
  })

  test('finds context lines once, and unchanged lines only when the review shows them', () => {
    const item = diffItem('c.ts', before, after)
    // value37..value43 are context around line 40; value10 is folded away.
    expect(searchReviewItems([item], 'value38 ').matches).toEqual([
      { itemId: 'review:c.ts', side: 'additions', lineNumber: 38, column: 6, length: 8 }
    ])
    expect(searchReviewItems([item], 'value10 ').matches).toEqual([])
    expect(searchReviewItems([item], 'value10 ', { includeUnchanged: true }).matches).toEqual([
      { itemId: 'review:c.ts', side: 'additions', lineNumber: 10, column: 6, length: 8 }
    ])
    expect(searchReviewItems([item], 'value99 ', { includeUnchanged: true }).matches.map((match) => match.lineNumber))
      .toEqual([99])
  })

  test('numbers a patch that only carries its hunks the same as the whole file', () => {
    const patch = [
      'diff --git a/d.ts b/d.ts',
      '--- a/d.ts',
      '+++ b/d.ts',
      '@@ -200,3 +210,4 @@ function outer() {',
      ' keep one',
      '-gone needle',
      '+fresh needle',
      '+another needle',
      ' keep two',
      ''
    ].join('\n')
    const fileDiff = parsePatchFiles(patch, 'test')[0]!.files[0]!
    const item = { id: 'review:d.ts', type: 'diff', fileDiff } as CodeViewItem<unknown>
    expect(searchReviewItems([item], 'needle').matches.map((match) => [match.side, match.lineNumber]))
      .toEqual([['deletions', 201], ['additions', 211], ['additions', 212]])
    // A partial patch has no unchanged lines to show, folded or not.
    expect(searchReviewItems([item], 'keep', { includeUnchanged: true }).matches.map((match) => match.lineNumber))
      .toEqual([210, 213])
  })

  test('searches whole files, and skips the placeholder a preview draws', () => {
    const file = { id: 'review:e.md', type: 'file', file: { name: 'e.md', contents: 'one\ntwo needle\n' } } as CodeViewItem<unknown>
    const preview = { id: 'review:f.png', type: 'file', file: { name: 'f.png', contents: '​' } } as CodeViewItem<unknown>
    expect(searchReviewItems([preview, file], 'needle').matches).toEqual([
      { itemId: 'review:e.md', side: 'additions', lineNumber: 2, column: 4, length: 6 }
    ])
    expect(searchReviewItems([preview], '​').matches).toEqual([])
  })

  test('stops at the cap and says the list is incomplete', () => {
    const big = { id: 'review:g.txt', type: 'file', file: { name: 'g.txt', contents: 'x'.repeat(REVIEW_SEARCH_LIMIT + 10) } } as CodeViewItem<unknown>
    const result = searchReviewItems([big], 'x')
    expect(result.matches).toHaveLength(REVIEW_SEARCH_LIMIT)
    expect(result.truncated).toBe(true)
  })
})

describe('moving between matches', () => {
  test('wraps both ways', () => {
    expect(nextMatchIndex(3, 2, true)).toBe(0)
    expect(nextMatchIndex(3, 0, false)).toBe(2)
    expect(nextMatchIndex(3, -1, false)).toBe(2)
    expect(nextMatchIndex(0, -1, true)).toBe(-1)
  })

  test('keeps the reader near the active match while the query grows', () => {
    const order = ['review:a.ts', 'review:b.ts']
    const at = (itemId: string, lineNumber: number, column = 0) => ({ itemId, side: 'additions' as const, lineNumber, column, length: 3 })
    const matches = [at('review:a.ts', 5), at('review:b.ts', 2), at('review:b.ts', 9)]
    expect(carryActiveIndex(at('review:b.ts', 3), matches, order)).toBe(2)
    expect(carryActiveIndex(at('review:a.ts', 5), matches, order)).toBe(0)
    expect(carryActiveIndex(at('review:b.ts', 99), matches, order)).toBe(0)
    expect(carryActiveIndex(null, matches, order)).toBe(0)
  })
})
