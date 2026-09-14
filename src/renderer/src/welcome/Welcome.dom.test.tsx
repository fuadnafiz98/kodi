import { afterEach, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { PullRequestInboxSnapshot, RepositoryApi } from '../../../shared/contracts'
import { DEFAULT_KEYBINDINGS } from '../settings/keybindings'
import type { RecentFolder } from '../explorer/recentFolders'
import { Welcome } from './Welcome'
import { resetWelcomeInboxCacheForTests, writeWelcomeInboxCache } from './welcomeInbox'

const recentFolders: readonly RecentFolder[] = [
  { name: 'kodi', path: '/Users/reader/kodi', lastOpenedAt: 2 },
  { name: 'core-3', path: '/Users/reader/core-3', lastOpenedAt: 1 }
]

const inbox: PullRequestInboxSnapshot = {
  available: true,
  message: null,
  sections: [{
    key: 'review-requested',
    title: 'Needs your review',
    pullRequests: [{
      number: 759,
      title: 'chore: rubber vocab update',
      url: 'https://github.com/acme/core/pull/759',
      state: 'open',
      isDraft: false,
      author: { login: 's-a-tanjim' },
      updatedAt: new Date().toISOString()
    }]
  }]
}

const previousRepository = window.repository

afterEach(() => {
  cleanup()
  window.repository = previousRepository
  resetWelcomeInboxCacheForTests()
  localStorage.clear()
})

function renderWelcome(overrides: Partial<React.ComponentProps<typeof Welcome>> = {}): void {
  render(<Welcome
    opening={false}
    openingRecentPath={null}
    recentFolders={recentFolders}
    keybindings={DEFAULT_KEYBINDINGS}
    inboxRepos={[]}
    onOpen={async () => {}}
    onOpenPickedFolder={() => {}}
    onRecentOpen={async () => {}}
    onRecentRemove={() => {}}
    onOpenPullRequest={async () => true}
    {...overrides}
  />)
}

function stubInbox(snapshot: PullRequestInboxSnapshot) {
  const getGlobalPullRequestInbox = mock(async () => snapshot)
  window.repository = { getGlobalPullRequestInbox } as unknown as RepositoryApi
  return getGlobalPullRequestInbox
}

test('lists recent folders and opens the one that is clicked', () => {
  const onRecentOpen = mock(async () => {})
  renderWelcome({ onRecentOpen })

  expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
  fireEvent.click(screen.getByTitle('/Users/reader/core-3'))

  expect(onRecentOpen).toHaveBeenCalledWith(recentFolders[1])
})

test('removes a recent folder without opening it', () => {
  const onRecentOpen = mock(async () => {})
  const onRecentRemove = mock(() => {})
  renderWelcome({ onRecentOpen, onRecentRemove })

  fireEvent.click(screen.getByLabelText('Remove kodi from recent folders'))

  expect(onRecentRemove).toHaveBeenCalledWith('/Users/reader/kodi')
  expect(onRecentOpen).not.toHaveBeenCalled()
})

test('shows the empty state when there is no history', () => {
  renderWelcome({ recentFolders: [] })

  expect(screen.getByText('No recent folders')).toBeTruthy()
})

test('shows pull requests that need attention and opens one on click', async () => {
  stubInbox(inbox)
  const onOpenPullRequest = mock(async () => true)
  renderWelcome({ onOpenPullRequest })

  const row = await screen.findByTitle('https://github.com/acme/core/pull/759')
  expect(row.textContent).toContain('chore: rubber vocab update')
  expect(row.textContent).toContain('acme/core #759')
  expect(row.textContent).toContain('Review')

  await act(async () => { fireEvent.click(row) })
  expect(onOpenPullRequest).toHaveBeenCalledWith('https://github.com/acme/core/pull/759')
})

test('renders the cached inbox instantly without refetching a fresh entry', async () => {
  writeWelcomeInboxCache([{
    key: 'assigned',
    url: 'https://github.com/acme/core/pull/88',
    number: 88,
    title: 'cached pull request',
    repo: 'acme/core',
    isDraft: false,
    authorLogin: 'octocat',
    authorAvatarUrl: '',
    updatedAt: new Date().toISOString()
  }])
  const getGlobalPullRequestInbox = stubInbox(inbox)
  renderWelcome()

  expect(await screen.findByTitle('https://github.com/acme/core/pull/88')).toBeTruthy()
  await Bun.sleep(30)
  expect(getGlobalPullRequestInbox).not.toHaveBeenCalled()
})

test('keeps the inbox section hidden when GitHub is unavailable', async () => {
  let release = (_snapshot: PullRequestInboxSnapshot) => {}
  window.repository = {
    getGlobalPullRequestInbox: () => new Promise<PullRequestInboxSnapshot>((resolve) => { release = resolve })
  } as unknown as RepositoryApi
  renderWelcome()

  await act(async () => { release({ available: false, message: 'gh is not installed', sections: [] }) })

  expect(document.querySelector('.welcome-inbox')).toBeNull()
  expect(screen.getByText('Recent folders')).toBeTruthy()
})

test('sends the configured repo scope with the inbox fetch', async () => {
  const getGlobalPullRequestInbox = stubInbox(inbox)
  renderWelcome({ inboxRepos: ['acme/core'] })

  await waitFor(() => expect(getGlobalPullRequestInbox).toHaveBeenCalledWith(['acme/core']))
})

// The point of the placeholder is that the rows land in the space it already
// reserved, so the row count has to match before and after the fetch resolves.
test('reserves the row count while loading and fills it without changing it', async () => {
  writeWelcomeInboxCache([]) // one prior fetch, so the expected count is known
  writeWelcomeInboxCache([{
    key: 'review-requested',
    url: 'https://github.com/acme/core/pull/1',
    number: 1,
    title: 'seen last time',
    repo: 'acme/core',
    isDraft: false,
    authorLogin: 'octocat',
    authorAvatarUrl: '',
    updatedAt: new Date(0).toISOString()
  }], [], 'acme/core') // stored under another scope, so these rows do not paint
  resetWelcomeInboxCacheForTests()

  let release = (_snapshot: PullRequestInboxSnapshot) => {}
  window.repository = {
    getGlobalPullRequestInbox: () => new Promise<PullRequestInboxSnapshot>((resolve) => { release = resolve })
  } as unknown as RepositoryApi
  renderWelcome()

  const list = await waitFor(() => {
    const found = document.querySelector('.welcome-inbox .welcome-group-list')
    if (found == null) throw new Error('inbox never reserved its space')
    return found
  })
  expect(list.getAttribute('aria-busy')).toBe('true')
  expect(list.querySelector('[role="status"]')?.textContent).toBe('Loading pull requests…')
  expect(list.querySelectorAll('.welcome-pr-ghost')).toHaveLength(1)

  await act(async () => { release(inbox) })

  expect(list.querySelectorAll('.welcome-pr-ghost')).toHaveLength(0)
  expect(list.querySelectorAll('.welcome-pr')).toHaveLength(1)
  expect(list.getAttribute('aria-busy')).toBe('false')
})

test('paints cached rows straight away instead of a placeholder', async () => {
  writeWelcomeInboxCache([{
    key: 'assigned',
    url: 'https://github.com/acme/core/pull/88',
    number: 88,
    title: 'cached pull request',
    repo: 'acme/core',
    isDraft: false,
    authorLogin: 'octocat',
    authorAvatarUrl: '',
    updatedAt: new Date(0).toISOString()
  }], [], '', 0) // fetched long ago: shown immediately, revalidated underneath
  resetWelcomeInboxCacheForTests()
  stubInbox(inbox)
  renderWelcome()

  expect(document.querySelectorAll('.welcome-pr-ghost')).toHaveLength(0)
  expect(screen.getByTitle('https://github.com/acme/core/pull/88')).toBeTruthy()
  await waitFor(() => expect(screen.getByTitle('https://github.com/acme/core/pull/759')).toBeTruthy())
})

test('stays away entirely when the last fetch found no pull requests', async () => {
  writeWelcomeInboxCache([])
  resetWelcomeInboxCacheForTests()
  stubInbox({ available: true, message: null, sections: [] })
  renderWelcome()

  expect(document.querySelector('.welcome-inbox')).toBeNull()
  await waitFor(() => expect(screen.getByText('Recent folders')).toBeTruthy())
  expect(document.querySelector('.welcome-inbox')).toBeNull()
})
