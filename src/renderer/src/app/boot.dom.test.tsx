import { afterEach, expect, mock, test } from 'bun:test'
import { act } from '@testing-library/react'

import type { RepositoryApi, RepositorySnapshot } from '../../../shared/contracts'
import { WORKSPACE_CACHE_VERSION, type WorkspaceCache } from '../../../shared/workspaceCache'

const preloadOrder: string[] = []

mock.module('./App', () => ({
  App: () => <main data-testid="boot-app" />
}))

// Both preloads stay pending for the whole test: a boot that waits for the
// workspace chunks before rendering can never satisfy these assertions.
mock.module('./workspaceBoot', () => ({
  preloadWorkspaceRoot: () => {
    preloadOrder.push('root')
    return new Promise<never>(() => undefined)
  },
  preloadWorkspaceViewer: (view: string) => {
    preloadOrder.push(`viewer:${view}`)
    return new Promise<never>(() => undefined)
  },
  preloadMultiFileReview: () => {
    preloadOrder.push('multi-file-review')
    return new Promise<never>(() => undefined)
  }
}))

const snapshot: RepositorySnapshot = {
  root: '/repo',
  name: 'repo',
  kind: 'git',
  branch: 'main',
  head: 'head',
  paths: ['src/a.ts', 'src/b.ts'],
  statuses: [{ path: 'src/a.ts', status: 'modified' }]
}

const cachedWorkspace: WorkspaceCache = {
  version: WORKSPACE_CACHE_VERSION,
  lastRoot: '/repo',
  snapshot,
  selectedPath: 'src/a.ts',
  workspaceView: 'multi',
  fileText: null,
  savedAt: 0
}

function mountPoint(): HTMLElement {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
  preloadOrder.length = 0
  delete window.repository
})

test('renders before the cached workspace chunks resolve', async () => {
  const root = mountPoint()
  window.repository = {
    cachedWorkspace,
    setStartupPreferences: () => Promise.resolve()
  } as unknown as RepositoryApi
  const { mountApp } = await import('./boot')

  let mounted: void | undefined
  await act(async () => {
    mounted = mountApp(Promise.resolve(null))
  })

  expect(mounted).toBeUndefined()
  expect(root.querySelector('[data-testid="boot-app"]')).not.toBeNull()
  expect(preloadOrder).toEqual(['root', 'viewer:multi'])
})

test('renders before the restored snapshot picks a viewer', async () => {
  const root = mountPoint()
  window.repository = {
    setStartupPreferences: () => Promise.resolve()
  } as unknown as RepositoryApi
  const { mountApp } = await import('./boot')

  await act(async () => {
    mountApp(Promise.resolve(snapshot))
  })

  expect(root.querySelector('[data-testid="boot-app"]')).not.toBeNull()
  expect(preloadOrder).toEqual(['root', 'viewer:multi'])
})

test('preloads the review viewer when the launch is a pull request open', async () => {
  const root = mountPoint()
  window.repository = {
    cachedWorkspace,
    restoreHint: {
      lastRoot: '/repo',
      restoreLastFolder: true,
      themeType: 'dark',
      folderPresent: true,
      restoring: true,
      pendingPullRequestUrl: 'https://github.com/acme/app/pull/717'
    },
    setStartupPreferences: () => Promise.resolve()
  } as unknown as RepositoryApi
  const { mountApp } = await import('./boot')

  await act(async () => {
    mountApp(Promise.resolve(null))
  })

  expect(root.querySelector('[data-testid="boot-app"]')).not.toBeNull()
  // The cached desk's own viewer chunk is not what this window is about to show.
  expect(preloadOrder).toEqual(['multi-file-review', 'root'])
})
