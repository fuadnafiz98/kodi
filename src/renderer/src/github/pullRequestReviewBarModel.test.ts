import { describe, expect, test } from 'bun:test'

import { reviewBarSummary } from './pullRequestReviewBarModel'

describe('reviewBarSummary', () => {
  test('a submission message wins over every count', () => {
    expect(reviewBarSummary('Review submitted', 4, 2)).toBe('Review submitted')
  })

  test('orphaned comments come before ready ones, and pluralise', () => {
    expect(reviewBarSummary(null, 3, 1)).toBe('1 orphaned comment needs attention')
    expect(reviewBarSummary(null, 3, 2)).toBe('2 orphaned comments need attention')
  })

  test('inline comments pluralise, and none is an invitation', () => {
    expect(reviewBarSummary(null, 1, 0)).toBe('1 inline comment ready')
    expect(reviewBarSummary(null, 5, 0)).toBe('5 inline comments ready')
    expect(reviewBarSummary(null, 0, 0)).toBe('Review this pull request on GitHub')
  })
})
