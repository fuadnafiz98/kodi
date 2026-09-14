import { describe, expect, test } from 'bun:test'
import type { CodeViewItem } from '@pierre/diffs'

import { buildViewedPathsKey, parseViewedPathsKey } from './viewedPaths'
import { markViewedFile } from './viewedFileStorage'
import { reviewItemId } from './reviewItems'

function fileItem(path: string, contents: string): CodeViewItem<undefined> {
  return {
    id: reviewItemId(path),
    type: 'file',
    file: { name: path, contents, cacheKey: `${path}:${contents}` }
  } as CodeViewItem<undefined>
}

function itemsFor(items: readonly CodeViewItem<undefined>[]): Map<string, CodeViewItem<undefined>> {
  return new Map(items.map((item) => [item.id.slice('review:'.length), item]))
}

describe('buildViewedPathsKey', () => {
  test('is empty when nothing has been viewed', () => {
    expect(buildViewedPathsKey(itemsFor([fileItem('a.ts', 'one')]), {})).toBe('')
  })

  test('keeps a path whose item still matches the recorded signature', () => {
    const item = fileItem('a.ts', 'one')
    const viewed = markViewedFile({}, item)
    expect(buildViewedPathsKey(itemsFor([item]), viewed)).toBe('a.ts')
  })

  test('drops a path whose contents changed since it was viewed', () => {
    const viewed = markViewedFile({}, fileItem('a.ts', 'one'))
    expect(buildViewedPathsKey(itemsFor([fileItem('a.ts', 'two')]), viewed)).toBe('')
  })

  test('drops a path that is no longer part of the review', () => {
    const viewed = markViewedFile({}, fileItem('a.ts', 'one'))
    expect(buildViewedPathsKey(itemsFor([fileItem('b.ts', 'other')]), viewed)).toBe('')
  })

  test('is stable regardless of the order paths were viewed in', () => {
    const first = fileItem('a.ts', 'one')
    const second = fileItem('b.ts', 'two')
    const items = itemsFor([first, second])
    const forward = markViewedFile(markViewedFile({}, first), second)
    const backward = markViewedFile(markViewedFile({}, second), first)
    expect(buildViewedPathsKey(items, forward)).toBe(buildViewedPathsKey(items, backward))
  })
})

describe('parseViewedPathsKey', () => {
  test('round-trips a built key', () => {
    const first = fileItem('a.ts', 'one')
    const second = fileItem('nested/b.ts', 'two')
    const viewed = markViewedFile(markViewedFile({}, first), second)
    const key = buildViewedPathsKey(itemsFor([first, second]), viewed)
    expect([...parseViewedPathsKey(key)].sort()).toEqual(['a.ts', 'nested/b.ts'])
  })

  test('reads an empty key as an empty set', () => {
    expect(parseViewedPathsKey('').size).toBe(0)
  })
})
