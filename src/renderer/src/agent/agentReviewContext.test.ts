import { describe, expect, test } from 'bun:test'

import type { RepositoryReview, RepositorySnapshot } from '../../../shared/contracts'
import { agentContextLabel, agentSubjectForWorld, formatAgentReviewContext } from './agentReviewContext'
import { createPatchWorld } from '../review/useReviewWorlds'

const snapshot: RepositorySnapshot = {
  root: '/repo-a',
  name: 'repo-a',
  kind: 'git',
  branch: 'main',
  head: 'desk-head',
  paths: ['src/file-0.ts'],
  statuses: []
}

const githubReview = (fileCount: number, patch = 'diff --git a/huge b/huge\n'.repeat(4000)): RepositoryReview => ({
  kind: 'github',
  selector: '1092',
  baseOid: 'base-1092',
  headOid: 'head-1092',
  commitId: 'abc',
  viewerCanSubmitDecision: true,
  pullRequest: {
    number: 1092,
    title: 'Speed up diffs',
    url: 'https://github.com/example/repo/pull/1092',
    state: 'OPEN',
    isDraft: false,
    author: { login: 'octocat' },
    headRefName: 'perf',
    baseRefName: 'main',
    reviewDecision: null,
    updatedAt: '2026-08-27T00:00:00Z',
    additions: 10,
    deletions: 2,
    changedFiles: fileCount
  },
  files: Array.from({ length: fileCount }, (_, index) => ({
    path: `src/file-${index}.ts`,
    additions: 1,
    deletions: 0
  })),
  patch,
  omittedFiles: [],
  expectedFileCount: fileCount
})

describe('formatAgentReviewContext', () => {
  test('summarizes files instead of copying the patch body', () => {
    const context = formatAgentReviewContext(githubReview(3, 'THIS PATCH MUST NOT APPEAR'))
    expect(context).toContain('#1092 Speed up diffs')
    expect(context).toContain('src/file-0.ts (+1/-0)')
    expect(context).not.toContain('THIS PATCH MUST NOT APPEAR')
  })

  test('caps a large file list so a streamed review cannot rebuild a megabyte string', () => {
    const context = formatAgentReviewContext(githubReview(120))
    expect(context).toContain('src/file-0.ts (+1/-0)')
    expect(context).toContain('…and 40 more files')
    expect(context).not.toContain('src/file-80.ts')
    expect(context.length).toBeLessThan(8_000)
  })

  test('binds a Patch tab to its repository and immutable revisions', () => {
    const review = githubReview(1)
    const subject = agentSubjectForWorld(createPatchWorld(snapshot, review, 1, 'ready'))
    const context = formatAgentReviewContext(review, subject)

    expect(subject).toEqual({
      tabId: 'patch:https://github.com/example/repo/pull/1092:base-1092:head-1092',
      repositoryRoot: '/repo-a',
      repositoryName: 'repo-a',
      source: 'patch',
      baseOid: 'base-1092',
      headOid: 'head-1092',
      pullRequestUrl: 'https://github.com/example/repo/pull/1092',
      workingBranch: 'main'
    })
    expect(context).toContain('Repository root: /repo-a')
    expect(context).toContain('Current branch: main')
    expect(context).toContain('Base revision: base-1092')
    expect(context).toContain('Head revision: head-1092')
    expect(context).toContain('Do not fetch them')
  })
})

describe('agentContextLabel', () => {
  test('names the pull request inside its local checkout', () => {
    const review = githubReview(1)
    const world = createPatchWorld(snapshot, review, 1, 'ready')
    expect(agentContextLabel(world, review)).toBe('#1092 in repo-a')
  })
})
