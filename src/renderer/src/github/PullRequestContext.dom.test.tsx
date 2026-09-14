import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { PullRequestConversation } from '../../../shared/contracts'
import { PullRequestContext } from './PullRequestContext'

afterEach(cleanup)

const conversation: PullRequestConversation = {
  available: true,
  message: null,
  body: '',
  threads: [],
  reviews: [{
    id: 'review-1',
    state: 'COMMENTED',
    authorLogin: 'reviewer',
    authorAvatarUrl: '',
    submittedAt: null,
    body: [
      '<details><summary>Files reviewed</summary>',
      '',
      '| File | Description |',
      '| --- | --- |',
      '| `src/app.ts` | **Updated** behavior |',
      '',
      '</details>',
      '',
      '<a href="/owner/repository/pull/1">Open review</a>'
    ].join('\n')
  }]
}

describe('PullRequestContext', () => {
  test('toggles the whole pull request context', () => {
    render(<PullRequestContext conversation={conversation} />)
    const toggle = screen.getByRole('button', { name: 'Pull request context' })

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('reviewer')).toBeTruthy()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('reviewer')).toBeNull()
  })

  test('renders each review with an avatar, a toned state badge, and its age', async () => {
    const previousRepository = window.repository
    window.repository = {
      getAvatar: async (url: string) =>
        url === 'https://avatars.example/f.png' ? 'data:image/png;base64,Zm9v' : null
    } as unknown as NonNullable<typeof window.repository>
    try {
      render(<PullRequestContext conversation={{
        ...conversation,
        reviews: [
          { id: 'r1', state: 'APPROVED', body: '', authorLogin: 'fuadnafiz98', authorAvatarUrl: 'https://avatars.example/f.png', submittedAt: '2026-08-17T10:05:00Z' },
          { id: 'r2', state: 'CHANGES_REQUESTED', body: '', authorLogin: 'reviewer', authorAvatarUrl: '', submittedAt: null }
        ]
      }} />)

      await waitFor(() => expect(document.querySelector('img.remote-avatar')).not.toBeNull())
      const img = document.querySelector<HTMLImageElement>('img.remote-avatar')!
      expect(img.src).toBe('data:image/png;base64,Zm9v')

      const monogram = screen.getByText('R')
      expect(monogram.className).toContain('remote-avatar')

      expect(document.querySelector('.pr-context-review-state[data-tone="approved"]')?.textContent).toContain('Approved')
      expect(document.querySelector('.pr-context-review-state[data-tone="changes"]')?.textContent).toContain('Changes requested')
    } finally {
      window.repository = previousRepository
    }
  })

  test('renders GitHub details and tables instead of raw markup', async () => {
    render(<PullRequestContext conversation={conversation} />)
    const disclosure = (await screen.findByText('Files reviewed')).closest('details')

    expect(disclosure).not.toBeNull()
    expect(within(disclosure!).getByRole('table')).toBeTruthy()
    expect(screen.queryByText(/<details>/)).toBeNull()
    expect(screen.getByText('Updated').tagName).toBe('STRONG')
    expect(screen.getByRole('link', { name: 'Open review' }).getAttribute('href'))
      .toBe('https://github.com/owner/repository/pull/1')
  })
})
