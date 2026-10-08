import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { PullRequestReviewBar } from './PullRequestReviewBar'

afterEach(cleanup)

test('draws nothing while closed: the toolbar summary stands in for it', () => {
  const { container } = render(<PullRequestReviewBar submitting={null} message={null} inlineCommentCount={0}
    orphanedCommentCount={1} viewerCanSubmitDecision={true} onSubmit={async () => true} />)

  expect(container.innerHTML).toBe('')
})

test('blocks review submission until orphaned comments are handled', () => {
  const submit = mock(async () => true)
  render(<PullRequestReviewBar expanded submitting={null} message={null} inlineCommentCount={0}
    orphanedCommentCount={1} viewerCanSubmitDecision={true} onSubmit={submit} />)

  expect(screen.getByText('1 orphaned comment must be reattached or dropped before submission.')).toBeTruthy()
  const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement
  expect(approve.disabled).toBe(true)
  fireEvent.click(approve)
  expect(submit).not.toHaveBeenCalled()
})

test('shows a failed submit message while the bar is expanded', async () => {
  render(<PullRequestReviewBar expanded submitting={null} message="Nope" inlineCommentCount={0}
    orphanedCommentCount={0} viewerCanSubmitDecision={true}
    onSubmit={async () => false} />)

  expect(screen.getByRole('alert').textContent).toBe('Nope')
})

test('shows an always-open finish form with Approve at the end of a review', () => {
  render(<PullRequestReviewBar variant="finish" submitting={null} message={null}
    inlineCommentCount={0} orphanedCommentCount={0} viewerCanSubmitDecision={true}
    onSubmit={async () => true} />)

  expect(screen.getByRole('region', { name: 'Finish review' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Submit Review' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull()
})

test('keeps approval available when there are no orphans', () => {
  render(<PullRequestReviewBar expanded submitting={null} message={null} inlineCommentCount={0}
    orphanedCommentCount={0} viewerCanSubmitDecision={true} onSubmit={async () => true} />)

  expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false)
})

test('the decision being posted says so until GitHub answers', () => {
  const view = render(<PullRequestReviewBar variant="finish" submitting="approve" message={null}
    inlineCommentCount={0} orphanedCommentCount={0} viewerCanSubmitDecision={true}
    onSubmit={async () => true} />)

  const approving = screen.getByRole('button', { name: 'Approving…' }) as HTMLButtonElement
  expect(approving.getAttribute('aria-busy')).toBe('true')
  expect(approving.disabled).toBe(true)
  expect(screen.getByRole('button', { name: 'Request Changes' }).getAttribute('aria-busy')).toBe('false')

  view.rerender(<PullRequestReviewBar variant="finish" submitting={null} message={null}
    inlineCommentCount={0} orphanedCommentCount={0} viewerCanSubmitDecision={true}
    onSubmit={async () => true} />)
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()
})
