import { expect, test } from 'bun:test'
import type { CodeViewItem } from '@pierre/diffs'

import { createPatchReviewItems, mergeReviewItems, pathFromReviewItemId } from './reviewItems'

// The viewer looks a diff up by cacheKey alone — no content comparison — so a
// positional key served one file's highlighted lines against another file's
// hunks and the renderer threw past the end of them.
test('patch cache keys follow content, not the position a file was parsed at', () => {
  const fileX = 'diff --git a/x.ts b/x.ts\nindex 111..222 100644\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n'
  const fileY = 'diff --git a/y.ts b/y.ts\nindex 333..444 100644\n--- a/y.ts\n+++ b/y.ts\n@@ -0,0 +1,1 @@\n+gamma\n'

  const first = createPatchReviewItems(fileX + fileY, 'v1')
  const second = createPatchReviewItems(fileY + fileX, 'v1')

  const keyOf = (items: readonly CodeViewItem<unknown>[], path: string): string | undefined => {
    const item = items.find((candidate) => pathFromReviewItemId(candidate.id) === path)
    return item?.type === 'diff' ? item.fileDiff.cacheKey : undefined
  }

  expect(keyOf(first, 'x.ts')).toBeTruthy()
  expect(keyOf(first, 'x.ts')).toBe(keyOf(second, 'x.ts'))
  expect(keyOf(first, 'y.ts')).toBe(keyOf(second, 'y.ts'))
  expect(keyOf(first, 'x.ts')).not.toBe(keyOf(first, 'y.ts'))
})

test('a file whose content changed takes a new cache key', () => {
  const before = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1,1 @@\n+alpha\n'
  const after = 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1,2 @@\n+alpha\n+beta\n'

  const keyOf = (patch: string): string | undefined => {
    const item = createPatchReviewItems(patch, 'v1')[0]
    return item?.type === 'diff' ? item.fileDiff.cacheKey : undefined
  }

  expect(keyOf(before)).toBeTruthy()
  expect(keyOf(before)).not.toBe(keyOf(after))
})

const twoFilePatch = (secondLine: string): string => [
  'diff --git a/a.ts b/a.ts',
  'index 1111111..2222222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1 +1 @@',
  '-old a',
  '+new a',
  'diff --git a/b.ts b/b.ts',
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -1 +1 @@',
  '-old b',
  `+${secondLine}`,
  ''
].join('\n')

// Every working-tree reload has its own version, so its cache keys never match
// the last load's. Replacing an unchanged file's item anyway made the viewer
// re-highlight the whole review on every save anywhere in the repository.
test('a reload keeps the item on screen for every file whose diff did not change', () => {
  const first = createPatchReviewItems(twoFilePatch('new b'), 'working-tree-1')
  const reload = createPatchReviewItems(twoFilePatch('newer b'), 'working-tree-2')
  const merged = mergeReviewItems(first, reload)

  expect(merged[0]).toBe(first[0])
  expect(merged[1]).toBe(reload[1])
  expect(merged[1]).not.toBe(first[1])
})
