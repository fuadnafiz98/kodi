import { describe, expect, test } from 'bun:test'

import type { PullRequestReview } from '../../../shared/contracts'
import {
  compareReviewCheckpoint,
  createReviewCheckpoint,
  createSinceReview,
  createSinceReviewFromPages,
  filterReviewPatch,
  filterReviewPatchPages,
  parseStoredReviewCheckpoint,
  reviewFileCheckpointSignature
} from './reviewCheckpoints'

const oid = (digit: string): string => digit.repeat(40)

function review(files: PullRequestReview['files'], patch = ''): PullRequestReview {
  return {
    kind: 'github', selector: '7', baseOid: oid('1'), headOid: oid('2'), commitId: oid('2'),
    viewerCanSubmitDecision: true,
    pullRequest: {
      number: 7, title: 'Checkpoint', url: 'https://github.com/acme/repo/pull/7', state: 'OPEN',
      isDraft: false, author: { login: 'author' }, headRefName: 'feature', baseRefName: 'main',
      reviewDecision: null, updatedAt: '2026-08-28T10:00:00Z', additions: 1, deletions: 1,
      changedFiles: files.length, checks: null, mergeable: null
    },
    files, patch, omittedFiles: [], expectedFileCount: files.length
  }
}

describe('review checkpoints', () => {
  test('prefers full blob IDs, then patch hashes, and labels line counts as fallback', () => {
    expect(reviewFileCheckpointSignature({ path: 'a.ts', additions: 1, deletions: 0, headBlobOid: oid('a') }))
      .toEqual({ path: 'a.ts', signatureKind: 'blob', signature: `head:${oid('a')}` })
    expect(reviewFileCheckpointSignature({ path: 'b.ts', additions: 1, deletions: 0, patchHash: 'b'.repeat(64) }).signatureKind)
      .toBe('patch')
    expect(reviewFileCheckpointSignature({ path: 'c.ts', additions: 1, deletions: 1 }).signatureKind)
      .toBe('fallback')
  })

  test('treats matching fallback counts as uncertain changes instead of identity', () => {
    const checkpoint = createReviewCheckpoint(review([
      { path: 'same.ts', additions: 2, deletions: 2 },
      { path: 'gone.ts', additions: 1, deletions: 0, headBlobOid: oid('c') }
    ]), '2026-08-28T10:00:00Z')
    const comparison = compareReviewCheckpoint(checkpoint, [
      { path: 'same.ts', additions: 2, deletions: 2 },
      { path: 'new.ts', additions: 1, deletions: 0, headBlobOid: oid('d') }
    ])
    expect(comparison.changedFiles.map((file) => file.path)).toEqual(['same.ts', 'new.ts'])
    expect(comparison.removedPaths).toEqual(['gone.ts'])
    expect(comparison.uncertainPaths).toEqual(['same.ts'])
  })

  test('filters whole patch sections and creates a file-level Since review', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts\nindex 1111111..2222222 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      'diff --git a/b.ts b/b.ts\nindex 3333333..4444444 100644\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-left\n+right\n'
    ].join('')
    const current = review([
      { path: 'a.ts', additions: 1, deletions: 1, headBlobOid: oid('a') },
      { path: 'b.ts', additions: 1, deletions: 1, headBlobOid: oid('b') }
    ], patch)
    const checkpoint = createReviewCheckpoint(review([
      { path: 'a.ts', additions: 1, deletions: 1, headBlobOid: oid('a') },
      { path: 'gone.ts', additions: 1, deletions: 0, headBlobOid: oid('c') }
    ]))
    const since = createSinceReview(current, checkpoint)
    expect(since.review.files.map((file) => file.path)).toEqual(['b.ts'])
    expect(since.review.patch).toBe(filterReviewPatch(patch, new Set(['b.ts'])))
    expect(since.review.patch).toContain('b/b.ts')
    expect(since.review.patch).not.toContain('b/a.ts')
    expect(since.removedPaths).toEqual(['gone.ts'])

    const pages = [patch.slice(0, patch.indexOf('diff --git a/b.ts')), patch.slice(patch.indexOf('diff --git a/b.ts'))]
    const pagedSince = createSinceReviewFromPages(current, pages, checkpoint)
    expect(pagedSince.review.patch).toBe('')
    expect(pagedSince.patchPages).toEqual([filterReviewPatch(patch, new Set(['b.ts']))])
    expect(filterReviewPatchPages(pages, new Set(['b.ts']))).toEqual([...(pagedSince.patchPages ?? [])])
  })

  test('filters a changed Git-quoted UTF-8 path exactly', () => {
    const path = 'dir/a"b-é.ts'
    const patch = 'diff --git "a/dir/a\\"b-\\303\\251.ts" "b/dir/a\\"b-\\303\\251.ts"\n'
      + 'index 1111111..2222222 100644\n--- "a/dir/a\\"b-\\303\\251.ts"\n'
      + '+++ "b/dir/a\\"b-\\303\\251.ts"\n@@ -1 +1 @@\n-old\n+new\n'

    expect(filterReviewPatch(patch, new Set([path]))).toBe(patch)
  })

  test('rejects corrupt persisted checkpoints', () => {
    expect(parseStoredReviewCheckpoint('{')).toBeNull()
    expect(parseStoredReviewCheckpoint(JSON.stringify({ version: 1 }))).toBeNull()
  })
})
