import { expect, test } from 'bun:test'
import type { CodeViewItem } from '@pierre/diffs'

import { createPatchReviewItems, pathFromReviewItemId } from './reviewItems'

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
