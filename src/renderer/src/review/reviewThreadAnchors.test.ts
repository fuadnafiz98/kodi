import { describe, expect, test } from 'bun:test'

import { createPatchReviewItems } from './reviewItems'
import type { ReviewThread } from './ReviewComments'
import {
  attachReviewThreadToRange,
  createReviewCommentAnchor,
  reanchorReviewThread,
  reanchorReviewThreads
} from './reviewThreadAnchors'

function item(contents: string, oldOid: string, newOid: string) {
  const lines = contents.split('\n')
  const body = lines.map((line) => `+${line}`).join('\n')
  const patch = `diff --git a/a.ts b/a.ts\nindex ${oldOid}..${newOid} 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -0,0 +1,${lines.length} @@\n${body}\n`
  return createPatchReviewItems(patch, newOid)[0]!
}

function threadFor(reviewItem: ReturnType<typeof item>, line: number): ReviewThread {
  const range = { start: line, end: line, side: 'additions' as const }
  return {
    id: 'thread-1', body: 'Check this.', lineNumber: line, side: 'additions', range,
    replies: [], resolved: false, anchor: createReviewCommentAnchor(reviewItem, range) ?? undefined
  }
}

describe('review comment anchors', () => {
  test('moves a comment when its selected text has one match after a push', () => {
    const before = item('first\ntarget\nlast', '1111111', '2222222')
    const after = item('inserted\nfirst\ntarget\nlast', '1111111', '3333333')
    const moved = reanchorReviewThread(threadFor(before, 2), after)
    expect(moved.orphaned).toBe(false)
    expect(moved.range).toMatchObject({ start: 3, end: 3, side: 'additions' })
    expect(moved.lineNumber).toBe(3)
    expect(moved.anchor?.blobOid).toBe('3333333')
  })

  test('reanchors a multi-line comment after the last selected line', () => {
    const before = item('first\ntarget\nkept\nlast', '1111111', '2222222')
    const after = item('inserted\nfirst\ntarget\nkept\nlast', '1111111', '3333333')
    const range = { start: 2, end: 3, side: 'additions' as const }
    const original = {
      ...threadFor(before, 2),
      range,
      lineNumber: 2,
      anchor: createReviewCommentAnchor(before, range) ?? undefined
    }
    const moved = reanchorReviewThread(original, after)
    expect(moved.orphaned).toBe(false)
    expect(moved.range).toMatchObject({ start: 3, end: 4, side: 'additions' })
    expect(moved.lineNumber).toBe(4)
  })

  test('uses surrounding context to disambiguate repeated selected text', () => {
    const before = item('alpha\ntarget\nomega', '1111111', '2222222')
    const after = item('noise\ntarget\nnoise\nalpha\ntarget\nomega', '1111111', '3333333')
    const moved = reanchorReviewThread(threadFor(before, 2), after)
    expect(moved.orphaned).toBe(false)
    expect(moved.range.start).toBe(5)
  })

  test('orphans zero and ambiguous matches instead of guessing', () => {
    const before = item('alpha\ntarget\nomega', '1111111', '2222222')
    const original = threadFor(before, 2)
    expect(reanchorReviewThread(original, item('alpha\nmissing\nomega', '1111111', '3333333')).orphaned).toBe(true)
    expect(reanchorReviewThread(original, item('alpha\ntarget\nomega\nalpha\ntarget\nomega', '1111111', '3333333')).orphaned).toBe(true)
  })

  test('waits for incomplete streams before orphaning unloaded paths', () => {
    const before = item('target', '1111111', '2222222')
    const threads = { 'a.ts': [threadFor(before, 1)] }
    expect(reanchorReviewThreads([], threads, false)).toBe(threads)
    expect(reanchorReviewThreads([], threads, true)['a.ts']?.[0]?.orphaned).toBe(true)
  })

  test('orphans legacy coordinates instead of guessing their selected text', () => {
    const reviewItem = item('current line', '1111111', '2222222')
    const legacy = { ...threadFor(reviewItem, 1), anchor: undefined }

    expect(reanchorReviewThread(legacy, reviewItem).orphaned).toBe(true)
  })

  test('manually attaches an orphan to a confirmed selection', () => {
    const before = item('old target', '1111111', '2222222')
    const orphan = { ...threadFor(before, 1), orphaned: true }
    const after = item('replacement', '2222222', '3333333')
    const attached = attachReviewThreadToRange(
      orphan,
      after,
      { start: 1, end: 1, side: 'additions' }
    )

    expect(attached).toMatchObject({ orphaned: false, lineNumber: 1 })
    expect(attached?.anchor?.selectedText).toBe('replacement')
  })

  test('attaches a multi-line range after the last selected line', () => {
    const before = item('one\ntwo\nthree', '1111111', '2222222')
    const orphan = { ...threadFor(before, 1), orphaned: true }
    const attached = attachReviewThreadToRange(
      orphan,
      before,
      { start: 1, end: 3, side: 'additions' }
    )

    expect(attached).toMatchObject({ orphaned: false, lineNumber: 3 })
    expect(attached?.range).toMatchObject({ start: 1, end: 3 })
  })
})
