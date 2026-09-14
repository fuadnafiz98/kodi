import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_SESSION_STATE,
  flushSessionState,
  loadSessionState,
  MAX_PULL_REQUEST_FOLDERS,
  parseSessionState,
  rememberPullRequestFolder,
  rememberedPullRequestFolder,
  saveSessionState
} from './sessionStore.js'

describe('parseSessionState', () => {
  it('reads a complete record', () => {
    expect(parseSessionState({ lastRoot: '/work/kodi', approvedRoots: ['/work/kodi'], restoreLastFolder: false, themeType: 'light' })).toEqual({
      lastRoot: '/work/kodi',
      approvedRoots: ['/work/kodi'],
      restoreLastFolder: false,
      themeType: 'light',
      windowBackground: null,
      pullRequestFolders: {}
    })
  })

  it('falls back to the defaults field by field', () => {
    expect(parseSessionState({})).toEqual(DEFAULT_SESSION_STATE)
    expect(parseSessionState({ lastRoot: '' }).lastRoot).toBeNull()
    expect(parseSessionState({ lastRoot: 7 }).lastRoot).toBeNull()
    expect(parseSessionState({ restoreLastFolder: 'yes' }).restoreLastFolder).toBe(true)
    expect(parseSessionState({ themeType: 'sepia' }).themeType).toBe('dark')
    expect(parseSessionState({ lastRoot: '/work/kodi' }).approvedRoots).toEqual(['/work/kodi'])
    expect(parseSessionState({
      pullRequestFolders: {
        'Acme/App': '/Users/me/Developer/app',
        '../escape': '/tmp/nope',
        'bad': 'relative'
      }
    }).pullRequestFolders).toEqual({
      'acme/app': '/Users/me/Developer/app'
    })
  })

  it('survives a corrupt record', () => {
    expect(parseSessionState(null)).toEqual(DEFAULT_SESSION_STATE)
    expect(parseSessionState('{"lastRoot":"/work"}')).toEqual(DEFAULT_SESSION_STATE)
  })
})

describe('loadSessionState', () => {
  it('round-trips through disk and defaults when the file is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-session-'))
    try {
      expect(loadSessionState(directory)).toEqual(DEFAULT_SESSION_STATE)
      await saveSessionState(directory, {
        lastRoot: '/work/kodi',
        approvedRoots: ['/work/kodi'],
        restoreLastFolder: false,
        themeType: 'light',
        pullRequestFolders: { 'acme/app': '/Users/me/Developer/app' }
      })
      expect(loadSessionState(directory)).toEqual({
        lastRoot: '/work/kodi',
        approvedRoots: ['/work/kodi'],
        restoreLastFolder: false,
        themeType: 'light',
        windowBackground: null,
        pullRequestFolders: { 'acme/app': '/Users/me/Developer/app' }
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('serializes rapid saves in call order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-session-order-'))
    try {
      const first = saveSessionState(directory, {
        lastRoot: '/work/first',
        approvedRoots: ['/work/first'],
        restoreLastFolder: true,
        themeType: 'dark',
        pullRequestFolders: {}
      })
      const second = saveSessionState(directory, {
        lastRoot: '/work/second',
        approvedRoots: ['/work/first', '/work/second'],
        restoreLastFolder: false,
        themeType: 'light',
        pullRequestFolders: {}
      })
      await Promise.all([first, second])

      expect(loadSessionState(directory)).toEqual({
        lastRoot: '/work/second',
        approvedRoots: ['/work/first', '/work/second'],
        restoreLastFolder: false,
        themeType: 'light',
        windowBackground: null,
        pullRequestFolders: {}
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('flushes the in-flight write before quit', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-session-flush-'))
    try {
      void saveSessionState(directory, {
        lastRoot: '/work/quit',
        approvedRoots: ['/work/quit'],
        restoreLastFolder: true,
        themeType: 'dark',
        pullRequestFolders: {}
      })
      await flushSessionState()
      expect(loadSessionState(directory).lastRoot).toBe('/work/quit')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('rememberPullRequestFolder', () => {
  it('stores the latest checkout for a slug and drops the oldest when full', () => {
    let state = DEFAULT_SESSION_STATE
    for (let index = 0; index < MAX_PULL_REQUEST_FOLDERS; index += 1) {
      state = rememberPullRequestFolder(state, `acme/repo-${index}`, `/Users/me/repo-${index}`)
    }
    expect(Object.keys(state.pullRequestFolders)).toHaveLength(MAX_PULL_REQUEST_FOLDERS)
    state = rememberPullRequestFolder(state, 'acme/newest', '/Users/me/newest')
    expect(rememberedPullRequestFolder(state, 'acme/repo-0')).toBeNull()
    expect(rememberedPullRequestFolder(state, 'acme/newest')).toBe('/Users/me/newest')
    expect(rememberPullRequestFolder(state, 'acme/newest', '/Users/me/newest')).toBe(state)
  })
})
