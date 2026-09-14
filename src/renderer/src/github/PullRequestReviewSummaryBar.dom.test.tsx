import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import type { ReviewCheckpoint } from '../review/reviewCheckpoints'
import type { ReviewCheckpointBarProps } from '../review/ReviewCheckpointStatus'
import { PullRequestReviewSummaryBar } from './PullRequestReviewSummaryBar'

afterEach(cleanup)

const checkpoint: ReviewCheckpoint = {
  version: 1,
  pullRequestUrl: 'https://github.com/acme/repo/pull/7',
  baseOid: '1'.repeat(40),
  headOid: '2'.repeat(40),
  createdAt: '2026-08-28T10:00:00Z',
  manifest: []
}

function checkpointBar(overrides: Partial<ReviewCheckpointBarProps> = {}): ReviewCheckpointBarProps {
  return {
    checkpoint,
    changedFileCount: 0,
    removedFileCount: 0,
    reviewReady: true,
    onSetCheckpoint: () => {},
    onOpenSince: () => {},
    ...overrides
  }
}

function renderBar(props: Partial<Parameters<typeof PullRequestReviewSummaryBar>[0]> = {}) {
  return render(<PullRequestReviewSummaryBar
    message={null}
    inlineCommentCount={0}
    orphanedCommentCount={0}
    onSubmitReview={() => {}}
    {...props}
  />)
}

test('checkpoint status and the way into the composer share one bar', () => {
  renderBar({ checkpointBar: checkpointBar() })

  expect(screen.getByText(/Checkpoint/).textContent).toContain('22222222')
  expect(screen.getByText('No files since checkpoint').tagName).toBe('SPAN')
  expect(screen.getByRole('button', { name: 'Update checkpoint' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Submit Review' })).toBeTruthy()
  expect(screen.queryByText('Review this pull request on GitHub')).toBeNull()
})

test('requires an explicit checkpoint before Since is offered', () => {
  const setCheckpoint = mock(() => {})
  renderBar({ checkpointBar: checkpointBar({ checkpoint: null, onSetCheckpoint: setCheckpoint }) })

  expect(screen.getByText('No review checkpoint')).toBeTruthy()
  expect(screen.queryByText(/since checkpoint/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Set checkpoint' }))
  expect(setCheckpoint).toHaveBeenCalledTimes(1)
})

test('the since count becomes the link into the since view', () => {
  const openSince = mock(() => {})
  renderBar({ checkpointBar: checkpointBar({ changedFileCount: 3, removedFileCount: 1, onOpenSince: openSince }) })

  fireEvent.click(screen.getByRole('button', { name: '3 since checkpoint · 1 removed' }))
  expect(openSince).toHaveBeenCalledTimes(1)
})

test('a submit result message still reads in the status cluster', () => {
  renderBar({ checkpointBar: checkpointBar(), message: 'Review submitted', inlineCommentCount: 2 })

  const summary = document.querySelector('.review-session-summary')
  expect(summary?.textContent).toBe('Review submitted')
  expect(summary?.className).toContain('success')
})

test('without a checkpoint segment the bar keeps its plain summary', () => {
  renderBar({ inlineCommentCount: 2 })

  expect(screen.getByText('2 inline comments ready')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Submit Review' })).toBeTruthy()
})
