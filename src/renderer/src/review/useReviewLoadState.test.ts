import { describe, expect, test } from 'bun:test'

import {
  canAppendPatch,
  canAppendPatchPages,
  FOLDER_REVIEW_PAGE_SIZE,
  parsePatchPageBatch,
  reviewLoadStateFromExternalItems,
  reviewProgress,
  type ReviewProgressInput
} from './useReviewLoadState'

const BASE: ReviewProgressInput = {
  streamingFileCount: null,
  streamedFileCount: 0,
  streamStalled: false,
  hasExternalReview: false,
  loadedPathCount: 0,
  stablePathCount: 0,
  paged: false,
  loadLimit: FOLDER_REVIEW_PAGE_SIZE
}

describe('reviewProgress', () => {
  test('a folder review targets every path and loads until it has them', () => {
    expect(reviewProgress({ ...BASE, stablePathCount: 12, loadedPathCount: 5 }))
      .toEqual({ loading: true, targetPathCount: 12 })
    expect(reviewProgress({ ...BASE, stablePathCount: 12, loadedPathCount: 12 }))
      .toEqual({ loading: false, targetPathCount: 12 })
  })

  test('a paged folder review targets one page at a time', () => {
    expect(reviewProgress({ ...BASE, paged: true, stablePathCount: 400, loadedPathCount: 50 }))
      .toEqual({ loading: false, targetPathCount: 50 })
    expect(reviewProgress({ ...BASE, paged: true, stablePathCount: 20, loadedPathCount: 20 }))
      .toEqual({ loading: false, targetPathCount: 20 })
  })

  test('a streamed review climbs towards the count GitHub reported', () => {
    const streaming = { ...BASE, hasExternalReview: true, streamingFileCount: 40, stablePathCount: 9 }
    expect(reviewProgress({ ...streaming, streamedFileCount: 9 }))
      .toEqual({ loading: true, targetPathCount: 40 })
    expect(reviewProgress({ ...streaming, streamedFileCount: 40, stablePathCount: 40 }))
      .toEqual({ loading: false, targetPathCount: 40 })
  })

  test('more paths than GitHub expected still raise the target', () => {
    expect(reviewProgress({
      ...BASE, hasExternalReview: true, streamingFileCount: 40, streamedFileCount: 45, stablePathCount: 45
    })).toEqual({ loading: false, targetPathCount: 45 })
  })

  test('a stalled stream stops reporting progress instead of spinning forever', () => {
    const dead = {
      ...BASE, hasExternalReview: true, streamingFileCount: 40, streamedFileCount: 3, stablePathCount: 3
    }
    expect(reviewProgress(dead).loading).toBe(true)
    expect(reviewProgress({ ...dead, streamStalled: true }).loading).toBe(false)
  })

  test('a local review is never loading, whatever the path count', () => {
    expect(reviewProgress({ ...BASE, hasExternalReview: true, stablePathCount: 30 }))
      .toEqual({ loading: false, targetPathCount: 30 })
  })

  test('a streamed local review climbs towards expectedFileCount', () => {
    expect(reviewProgress({
      ...BASE,
      hasExternalReview: true,
      streamingFileCount: 12,
      streamedFileCount: 1,
      stablePathCount: 1
    })).toEqual({ loading: true, targetPathCount: 12 })
  })
})

describe('reviewLoadStateFromExternalItems', () => {
  test('is ready on the same tick the patch parses, so CodeView never mounts empty', () => {
    const items = [{ id: 'review:src/a.ts', type: 'file' }] as never
    const state = reviewLoadStateFromExternalItems(items, ['src/a.ts', 'src/b.ts'], [])
    expect(state.items).toBe(items)
    expect([...state.loadedPaths]).toEqual(['src/a.ts', 'src/b.ts'])
    expect(state.skippedCount).toBe(1)
    expect(state.paged).toBe(false)
  })

  test('does not count omitted files as skipped', () => {
    const items = [{ id: 'review:src/a.ts', type: 'file' }] as never
    const state = reviewLoadStateFromExternalItems(
      items,
      ['src/a.ts', 'huge.bin'],
      [{ path: 'huge.bin', reason: 'too-large', additions: 0, deletions: 0 }]
    )
    expect(state.skippedCount).toBe(0)
    expect(state.omittedFiles).toHaveLength(1)
  })
})

describe('canAppendPatch', () => {
  const parsed = { key: 'pr-7', length: 12, tail: 'hello world\n' }

  test('appends when the consumed seam is still intact', () => {
    expect(canAppendPatch(parsed, 'pr-7', 'hello world\ndiff --git a b\n')).toBe(true)
  })

  test('re-parses when the stream rewrote the bytes the slice would start after', () => {
    expect(canAppendPatch(parsed, 'pr-7', 'HELLO world\ndiff --git a b\n')).toBe(false)
  })

  test('re-parses a shorter patch and a different review', () => {
    expect(canAppendPatch(parsed, 'pr-7', 'hello\n')).toBe(false)
    expect(canAppendPatch(parsed, 'pr-8', 'hello world\ndiff --git a b\n')).toBe(false)
  })

  test('an empty cache always appends from zero', () => {
    expect(canAppendPatch({ key: 'pr-7', length: 0, tail: '' }, 'pr-7', 'anything')).toBe(true)
  })
})

const patchPage = (path: string, before: string, after: string): string => [
  `diff --git a/${path} b/${path}`,
  'index 1111111..2222222 100644',
  `--- a/${path}`,
  `+++ b/${path}`,
  '@@ -1 +1 @@',
  `-${before}`,
  `+${after}`,
  ''
].join('\n')

describe('paged patch parsing', () => {
  const firstPage = patchPage('a.ts', 'old-a', 'new-a')
  const secondPage = patchPage('b.ts', 'old-b', 'new-b')

  test('appends only new pages', () => {
    const initial = parsePatchPageBatch({ key: '', pageRefs: [], items: [] }, 'pr-7', [firstPage])
    const firstItem = initial.items[0]
    const appended = parsePatchPageBatch(initial, 'pr-7', [firstPage, secondPage])

    expect(canAppendPatchPages(initial, 'pr-7', [firstPage, secondPage])).toBe(true)
    expect(appended.items.map((item) => item.id)).toEqual(['review:a.ts', 'review:b.ts'])
    expect(appended.items[0]).toBe(firstItem)
  })

  test('a replaced page forces a full reparse', () => {
    const initial = parsePatchPageBatch({ key: '', pageRefs: [], items: [] }, 'pr-7', [firstPage, secondPage])
    const replacement = patchPage('c.ts', 'old-c', 'new-c')
    const reparsed = parsePatchPageBatch(initial, 'pr-7', [replacement, secondPage])

    expect(canAppendPatchPages(initial, 'pr-7', [replacement, secondPage])).toBe(false)
    expect(reparsed.items.map((item) => item.id)).toEqual(['review:c.ts', 'review:b.ts'])
    expect(reparsed.items).not.toContain(initial.items[0])
  })
})
