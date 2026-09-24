import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import type { PullRequestConversation } from '../../../shared/contracts'
import { PullRequestContext } from './PullRequestContext'

afterEach(cleanup)

const conversation: PullRequestConversation = {
  available: true,
  message: null,
  body: '',
  headOid: 'a'.repeat(40),
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
  // The body stays mounted so its height can animate; collapsed means marked and
  // inert, not unmounted.
  test('toggles the whole pull request context', () => {
    render(<PullRequestContext conversation={conversation} />)
    const toggle = screen.getByRole('button', { name: 'Pull request context' })
    const body = document.querySelector('.pr-context-body')

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(body?.hasAttribute('data-collapsed')).toBe(false)
    expect(screen.getByText('reviewer')).toBeTruthy()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(body?.hasAttribute('data-collapsed')).toBe(true)
    expect(body?.hasAttribute('inert')).toBe(true)

    fireEvent.click(toggle)

    expect(body?.hasAttribute('data-collapsed')).toBe(false)
    expect(body?.hasAttribute('inert')).toBe(false)
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

      expect(document.querySelector('.pr-context-review[data-tone="approved"]')?.textContent)
        .toContain('fuadnafiz98 approved these changes')
      expect(document.querySelector('.pr-context-review[data-tone="changes"]')?.textContent)
        .toContain('reviewer requested changes')
    } finally {
      window.repository = previousRepository
    }
  })

  // The diff cannot show these: GitHub nulled their line when the code moved.
  // The hunk they were written on is the only context they still have.
  test('lists outdated threads with the hunk they were written on', () => {
    render(<PullRequestContext conversation={{
      ...conversation,
      threads: [{
        id: 'thread-1',
        path: 'src/app.ts',
        line: null,
        startLine: null,
        originalLine: 41,
        originalStartLine: null,
        diffHunk: '@@ -38,4 +38,5 @@\n-  const stale = true',
        side: 'RIGHT',
        resolved: false,
        outdated: true,
        comments: [{
          id: 'comment-1',
          body: 'This branch is unreachable.',
          authorLogin: 'reviewer',
          authorAvatarUrl: '',
          createdAt: '2026-08-17T10:00:00Z'
        }]
      }]
    }} />)

    const disclosure = screen.getByText(/1 outdated comment/).closest('details')
    expect(disclosure).not.toBeNull()
    expect(within(disclosure!).getByText('src/app.ts:41')).toBeTruthy()
    expect(within(disclosure!).getByText(/const stale = true/)).toBeTruthy()
    // The quoted hunk is a diff, so its lines carry the kind they were written as.
    expect(disclosure!.querySelector('.pr-context-outdated-hunk li[data-kind="header"]')?.textContent)
      .toBe('@@ -38,4 +38,5 @@')
    expect(disclosure!.querySelector('.pr-context-outdated-hunk li[data-kind="del"]')).not.toBeNull()
    expect(disclosure!.querySelector('.pr-context-outdated-thread')).not.toBeNull()
  })

  // Two reviews from one person: the latest is their position, the earlier one is
  // history and reads as history.
  test('dims a review superseded by a later one from the same author', () => {
    render(<PullRequestContext conversation={{
      ...conversation,
      reviews: [
        { id: 'r1', state: 'CHANGES_REQUESTED', body: '', authorLogin: 'fuadnafiz98', authorAvatarUrl: '', submittedAt: null },
        { id: 'r2', state: 'APPROVED', body: '', authorLogin: 'fuadnafiz98', authorAvatarUrl: '', submittedAt: null }
      ]
    }} />)

    const rows = [...document.querySelectorAll('.pr-context-review')]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.hasAttribute('data-superseded')).toBe(true)
    expect(rows[1]?.hasAttribute('data-superseded')).toBe(false)
  })

  // A bare "commented" review says only that someone opened the diff; whatever
  // they wrote is already on the lines it was about.
  test('drops an empty commented review', () => {
    render(<PullRequestContext conversation={{
      ...conversation,
      body: 'Body so the section still renders.',
      reviews: [
        { id: 'r1', state: 'COMMENTED', body: '', authorLogin: 'reviewer', authorAvatarUrl: '', submittedAt: null }
      ]
    }} />)

    expect(document.querySelector('.pr-context-review')).toBeNull()
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

  // Arriving above a diff the reader has started is the layout shift; holding
  // the strip from the first paint is what prevents it.
  test('holds its place with a placeholder while a pull request conversation loads', async () => {
    const { rerender } = render(<PullRequestContext conversation={null} pullRequest />)

    expect(screen.getByRole('button', { name: 'Pull request context' })).toBeTruthy()
    const section = screen.getByRole('region', { name: 'Pull request context' })
    expect(within(section).getByRole('status').textContent).toBe('Loading pull request context…')
    expect(document.querySelectorAll('.pr-context-ghost i')).toHaveLength(3)

    rerender(<PullRequestContext conversation={conversation} pullRequest />)

    // The placeholder outlives the fetch until the markdown renderer is here too,
    // so the description paints once, formatted, instead of reflowing.
    await waitFor(() => expect(document.querySelector('.pr-context-ghost')).toBeNull())
    expect(screen.getByText('reviewer')).toBeTruthy()
    expect(document.querySelector('.github-markdown-fallback')).toBeNull()
  })

  test('keeps the reserved strip when the pull request has nothing to show', () => {
    render(<PullRequestContext conversation={{ ...conversation, reviews: [] }} pullRequest />)

    expect(screen.getByText('No description')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Pull request context' })).toBeNull()
    expect(document.querySelector('.pr-context-body')?.hasAttribute('data-collapsed')).toBe(true)
  })

  test('stays away outside a pull request review', () => {
    render(<PullRequestContext conversation={null} />)

    expect(document.querySelector('.pr-context')).toBeNull()
  })

  test('a long description folds behind a chevron whose label follows the state', () => {
    const body = Array.from({ length: 14 }, (_unused, index) => `Line ${index + 1}`).join('\n\n')
    render(<PullRequestContext conversation={{ ...conversation, body }} />)
    const summary = screen.getByText('Show description')
    const details = summary.closest('details')!

    expect(summary.querySelector('.pr-context-disclosure-chevron')).toBeTruthy()

    details.open = true
    fireEvent(details, new Event('toggle'))

    expect(screen.getByText('Hide description')).toBeTruthy()
  })
})

