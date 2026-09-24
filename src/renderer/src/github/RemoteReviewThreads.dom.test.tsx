import { afterEach, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { RemoteReviewThread } from '../../../shared/contracts'
import { RemoteReviewThreadCard } from './RemoteReviewThreads'

afterEach(cleanup)

function thread(body: string): RemoteReviewThread {
  return {
    id: 'thread-1',
    path: 'src/app.ts',
    line: 1,
    startLine: 1,
    originalLine: 1,
    originalStartLine: 1,
    diffHunk: '',
    side: 'RIGHT',
    resolved: false,
    outdated: false,
    comments: [{
      id: 'comment-1',
      authorLogin: 'reviewer',
      authorAvatarUrl: '',
      createdAt: '2026-08-31T12:00:00.000Z',
      body
    }]
  }
}

// GitHub folds a resolved thread away; so does this, so that resolving on
// GitHub visibly clears the review here instead of leaving a dimmed card behind.
test('a resolved thread is one row until it is asked for', () => {
  render(<RemoteReviewThreadCard
    thread={{ ...thread('Fixed in the follow-up.'), resolved: true }}
    pending={false} onReply={() => {}} onToggleResolved={() => {}} />)

  expect(screen.queryByText('Fixed in the follow-up.')).toBeNull()
  const summary = screen.getByRole('button', { name: /resolved/ })
  expect(summary.textContent).toContain('1 comment')

  fireEvent.click(summary)
  expect(screen.getByText('Fixed in the follow-up.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Hide this resolved thread' }))
  expect(screen.queryByText('Fixed in the follow-up.')).toBeNull()
})

test('an unresolved thread is open on arrival', () => {
  render(<RemoteReviewThreadCard
    thread={thread('Rename this.')}
    pending={false} onReply={() => {}} onToggleResolved={() => {}} />)

  expect(screen.getByText('Rename this.')).toBeTruthy()
})

test('renders GitHub table syntax in a thread comment', async () => {
  render(<RemoteReviewThreadCard
    thread={thread('| a | b |\n| --- | --- |\n| 1 | 2 |')}
    pending={false} onReply={() => {}} onToggleResolved={() => {}} />)

  expect(await screen.findByRole('table')).toBeTruthy()
})

test('sanitises script tags out of GitHub comment bodies', async () => {
  const { container } = render(<RemoteReviewThreadCard
    thread={thread('Safe text <script>alert(1)</script>')}
    pending={false} onReply={() => {}} onToggleResolved={() => {}} />)

  await waitFor(() => { expect(screen.getByText(/Safe text/).tagName).toBe('P') })
  expect(container.querySelector('script')).toBeNull()
})

test('autolinks a bare URL in a GitHub comment', async () => {
  render(<RemoteReviewThreadCard
    thread={thread('See https://example.com/review')}
    pending={false} onReply={() => {}} onToggleResolved={() => {}} />)

  const link = await screen.findByRole('link', { name: 'https://example.com/review' })
  expect(link.getAttribute('href')).toBe('https://example.com/review')
})
