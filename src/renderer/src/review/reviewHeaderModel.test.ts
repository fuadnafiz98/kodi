import { describe, expect, test } from 'bun:test'

import type { PullRequestReview, RepositoryReview } from '../../../shared/contracts'
import { reviewBarMode, reviewToolbarComparison, reviewToolbarTitle } from './reviewHeaderModel'

function githubReview(state: PullRequestReview['pullRequest']['state']): RepositoryReview {
  return {
    kind: 'github',
    pullRequest: {
      number: 717,
      title: 'Make it instant',
      baseRefName: 'main',
      headRefName: 'perf',
      state
    },
    viewerCanSubmitDecision: true
  } as unknown as RepositoryReview
}

const localReview = {
  kind: 'local',
  title: 'main → perf',
  baseRefName: 'main',
  headRefName: 'perf'
} as unknown as RepositoryReview

describe('reviewToolbarTitle / reviewToolbarComparison', () => {
  test('a pull request is numbered, a local review is not', () => {
    expect(reviewToolbarTitle(githubReview('OPEN'))).toBe('#717 Make it instant')
    expect(reviewToolbarTitle(localReview)).toBe('main → perf')
    expect(reviewToolbarTitle(null)).toBeUndefined()
  })

  test('both kinds report base → head', () => {
    expect(reviewToolbarComparison(githubReview('OPEN'))).toBe('main → perf')
    expect(reviewToolbarComparison(localReview)).toBe('main → perf')
    expect(reviewToolbarComparison(null)).toBeUndefined()
  })
})

describe('reviewBarMode', () => {
  test('the composer needs an open pull request in the patch world', () => {
    expect(reviewBarMode(githubReview('OPEN'), 'patch')).toBe('submit')
  })

  test('the since world is read only even for an open pull request', () => {
    expect(reviewBarMode(githubReview('OPEN'), 'since')).toBe('since')
  })

  test('a merged pull request, or one seen from the desk, explains itself', () => {
    expect(reviewBarMode(githubReview('MERGED'), 'patch')).toBe('closed')
    expect(reviewBarMode(githubReview('OPEN'), 'desk')).toBe('closed')
  })

  test('local reviews and no review at all', () => {
    expect(reviewBarMode(localReview, 'patch')).toBe('local')
    expect(reviewBarMode(localReview, 'since')).toBe('local')
    expect(reviewBarMode(null, 'patch')).toBe('none')
  })
})
