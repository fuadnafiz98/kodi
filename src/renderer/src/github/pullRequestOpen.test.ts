import { expect, test } from 'bun:test'

import { isPullRequestWorkspacePending, reviewFolderChip } from './pullRequestOpen'
import { createNewWorld, createPatchWorld, type DeskWorld } from '../review/useReviewWorlds'
import type { PullRequestReview, RepositorySnapshot } from '../../../shared/contracts'

const snapshot: RepositorySnapshot = {
  root: '/projects/alpha',
  name: 'alpha',
  kind: 'git',
  branch: 'main',
  head: 'a'.repeat(40),
  paths: ['src/app.ts'],
  statuses: [{ path: 'src/app.ts', status: 'modified' }]
}

const desk: DeskWorld = {
  source: 'desk',
  worldId: 'desk:/projects/alpha',
  label: 'alpha',
  root: snapshot.root,
  snapshot,
  baselineOid: snapshot.head,
  workingRevision: 0
}

function review(fileCount = 0): PullRequestReview {
  return {
    kind: 'github',
    selector: '338',
    baseOid: 'base',
    headOid: 'head',
    commitId: 'head',
    viewerCanSubmitDecision: true,
    pullRequest: {
      number: 338,
      title: 'Fmx 626',
      url: 'https://github.com/acme/alpha/pull/338',
      state: 'OPEN',
      isDraft: false,
      author: { login: 'reviewer' },
      headRefName: 'fmx-626',
      baseRefName: 'main',
      reviewDecision: null,
      updatedAt: '2026-08-29T00:00:00Z',
      additions: 2,
      deletions: 1,
      changedFiles: fileCount
    },
    files: Array.from({ length: fileCount }, (_, index) => ({
      path: `src/file-${index}.ts`,
      additions: 1,
      deletions: 0
    })),
    patch: '',
    omittedFiles: [],
    expectedFileCount: fileCount
  }
}

test('blanks the working tree while a pull request is still being fetched', () => {
  expect(isPullRequestWorkspacePending('review:338', desk)).toBe(true)
  expect(isPullRequestWorkspacePending('resolve:pull-request', createNewWorld())).toBe(true)
  expect(isPullRequestWorkspacePending(null, createPatchWorld(snapshot, review(0), 1, 'loading'))).toBe(true)
})

test('the new-tab folder chip prefers a chosen checkout over a suggested match', () => {
  const chosen = { ...createNewWorld(), repositoryRoot: '/Users/me/Developer/app' }
  expect(reviewFolderChip(chosen, {
    root: '/Users/me/Developer/other',
    name: 'other',
    displayPath: '~/Developer/other',
    source: 'matched'
  })).toEqual({ name: 'app', path: '/Users/me/Developer/app' })
  expect(reviewFolderChip(createNewWorld(), {
    root: '/Users/me/Developer/app',
    name: 'app',
    displayPath: '~/Developer/app',
    source: 'remembered'
  })).toEqual({ name: 'app', path: '~/Developer/app' })
  expect(reviewFolderChip(null, null)).toEqual({ name: null, path: null })
})

test('keeps a ready or streamed review visible', () => {
  expect(isPullRequestWorkspacePending(null, desk)).toBe(false)
  expect(isPullRequestWorkspacePending(null, createPatchWorld(snapshot, review(3), 1, 'ready'))).toBe(false)
  expect(isPullRequestWorkspacePending(null, createPatchWorld(snapshot, review(1), 1, 'loading'))).toBe(false)
})
