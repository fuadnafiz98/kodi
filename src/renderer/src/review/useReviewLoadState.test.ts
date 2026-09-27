import { describe, expect, it, test } from 'bun:test'

import { COMMAND_ABORTED_MESSAGE } from '../../../shared/contracts'

import {
  appendOmittedFiles,
  canAppendPatch,
  canAppendPatchPages,
  FOLDER_REVIEW_PAGE_SIZE,
  parsePatchPageBatch,
  reviewLoadStateFromExternalItems,
  requestWorkingTreePatch,
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

describe('requestWorkingTreePatch', () => {
  const aborted = new Error(`Error invoking remote method 'repository:get-working-tree-patch': Error: ${COMMAND_ABORTED_MESSAGE}`)
  const patch = { patch: 'diff --git a/x b/x\n', omittedFiles: [] }
  const noWait = async (): Promise<void> => {}

  // A save while the review loads aborts the build for the older snapshot. The
  // loader used to read that as "plain folder" and fetch fifty files one by one.
  it('asks again when a newer snapshot superseded the build', async () => {
    let calls = 0
    const repository = {
      getWorkingTreePatch: async () => {
        calls += 1
        if (calls < 3) throw aborted
        return patch
      }
    }
    expect(await requestWorkingTreePatch(repository, ['x'], 'r', () => false, noWait)).toEqual(patch)
    expect(calls).toBe(3)
  })

  it('passes any other failure straight through, which is what a plain folder answers', async () => {
    let calls = 0
    const repository = {
      getWorkingTreePatch: async () => {
        calls += 1
        throw new Error('The open folder is not a Git repository.')
      }
    }
    await expect(requestWorkingTreePatch(repository, ['x'], 'r', () => false, noWait)).rejects.toThrow('not a Git repository')
    expect(calls).toBe(1)
  })

  it('stops asking once the load it belongs to was abandoned', async () => {
    let calls = 0
    const repository = { getWorkingTreePatch: async () => { calls += 1; throw aborted } }
    await expect(requestWorkingTreePatch(repository, ['x'], 'r', () => calls >= 1, noWait)).rejects.toThrow(COMMAND_ABORTED_MESSAGE)
    expect(calls).toBe(1)
  })

  it('gives up after a few supersessions in a row', async () => {
    let calls = 0
    const repository = { getWorkingTreePatch: async () => { calls += 1; throw aborted } }
    await expect(requestWorkingTreePatch(repository, ['x'], 'r', () => false, noWait)).rejects.toThrow(COMMAND_ABORTED_MESSAGE)
    expect(calls).toBe(4)
  })
})

describe('appendOmittedFiles', () => {
  const file = (path: string) => ({ path, reason: 'too-large' as const, additions: 1, deletions: 0 })
  test('an omission streamed again by a retry is kept once', () => {
    expect(appendOmittedFiles([file('a.bin')], [file('a.bin'), file('b.bin')]).map((entry) => entry.path))
      .toEqual(['a.bin', 'b.bin'])
  })
  test('nothing new keeps the same list', () => {
    const current = [file('a.bin')]
    expect(appendOmittedFiles(current, [])).toBe(current)
  })
})
