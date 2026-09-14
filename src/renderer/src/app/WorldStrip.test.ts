import { expect, test } from 'bun:test'

import { createPatchWorld, type ReviewWorld } from '../review/useReviewWorlds'
import { partitionWorlds } from './WorldStrip'
import type { PullRequestReview } from '../../../shared/contracts'

const snapshot = {
  root: '/repo',
  name: 'repo',
  kind: 'git' as const,
  branch: 'main',
  head: 'head',
  paths: [],
  statuses: []
}

function patch(number: number): ReviewWorld {
  const review: PullRequestReview = {
    kind: 'github',
    selector: String(number),
    baseOid: `base-${number}`,
    headOid: `head-${number}`,
    commitId: `head-${number}`,
    viewerCanSubmitDecision: true,
    pullRequest: {
      number,
      title: `Review ${number}`,
      url: `https://github.com/acme/repo/pull/${number}`,
      state: 'OPEN',
      isDraft: false,
      author: { login: 'author' },
      headRefName: `feature-${number}`,
      baseRefName: 'main',
      reviewDecision: null,
      updatedAt: '2026-08-28T00:00:00Z',
      additions: 0,
      deletions: 0,
      changedFiles: 0
    },
    files: [],
    patch: '',
    omittedFiles: [],
    expectedFileCount: 0
  }
  return createPatchWorld(snapshot, review, number, 'ready')
}

test('world overflow keeps the active world directly reachable', () => {
  const worlds = Array.from({ length: 10 }, (_, index) => patch(index + 1))
  const active = worlds[9]!
  const partition = partitionWorlds(worlds, active.worldId)

  expect(partition.visible).toHaveLength(7)
  expect(partition.visible).toContain(active)
  expect(partition.overflow).toHaveLength(3)
})
