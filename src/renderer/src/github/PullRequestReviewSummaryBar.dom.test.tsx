import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PullRequestReviewSummaryBar } from './PullRequestReviewSummaryBar'

afterEach(cleanup)

function renderBar(props: Partial<Parameters<typeof PullRequestReviewSummaryBar>[0]> = {}) {
  return render(<PullRequestReviewSummaryBar
    message={null}
    inlineCommentCount={0}
    orphanedCommentCount={0}
    onSubmitReview={() => {}}
    {...props}
  />)
}

test('an idle review is just the button — no filler status line', () => {
  const submit = mock(() => {})
  renderBar({ onSubmitReview: submit })

  expect(document.querySelector('.review-session-summary')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Submit Review' }))
  expect(submit).toHaveBeenCalledTimes(1)
})

test('the button reports whether the composer is open', () => {
  renderBar({ expanded: true })
  expect(screen.getByRole('button', { name: 'Submit Review' }).getAttribute('aria-expanded')).toBe('true')
})

test('a submit result message replaces the idle line', () => {
  renderBar({ message: 'Review submitted', inlineCommentCount: 2 })

  const summary = document.querySelector('.review-session-summary')
  expect(summary?.textContent).toBe('Review submitted')
  expect(summary?.className).toContain('success')
})

// A push while the tab is open. The tab keeps showing the commits it was opened
// at, and says so, rather than swapping hunks under the reader.
test('a pushed commit offers a reload without moving the diff', () => {
  const adopt = mock(() => {})
  renderBar({ newRevision: { headOid: 'abcdef1234567890', onAdopt: adopt } })

  const load = screen.getByRole('button', { name: 'Load new commits' })
  expect(load.getAttribute('title')).toContain('abcdef12')
  fireEvent.click(load)
  expect(adopt).toHaveBeenCalledTimes(1)
})

test('no reload button when the tab is at the pull request head', () => {
  renderBar()
  expect(screen.queryByRole('button', { name: 'Load new commits' })).toBeNull()
})

test('pending inline comments read in the status cluster', () => {
  renderBar({ inlineCommentCount: 2 })

  expect(screen.getByText('2 inline comments ready')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Submit Review' })).toBeTruthy()
})
