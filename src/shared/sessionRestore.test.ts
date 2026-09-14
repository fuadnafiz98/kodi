import { describe, expect, it } from 'bun:test'

import {
  applyRestoreHintToDocument,
  effectiveLastRoot,
  EMPTY_RESTORE_HINT,
  encodeRestoreHintArgument,
  isPrematureSessionError,
  parseRestoreHint,
  RESTORE_HINT_ARG_PREFIX,
  restoreHintFromArgv,
  restorePendingFromHint,
  sessionRestoreExpected,
  sessionWorkspaceStage,
  shouldRestoreLastFolder,
  shouldReportRestoreFailure,
  startupSnapshotAction
} from './sessionRestore.js'

const restoring = {
  lastRoot: '/work/kodi',
  restoreLastFolder: true,
  themeType: 'light' as const,
  canvasColor: null,
  folderPresent: true,
  restoring: true,
  pendingPullRequestUrl: null
}

describe('parseRestoreHint', () => {
  it('reads a complete hint', () => {
    expect(parseRestoreHint(restoring)).toEqual(restoring)
  })

  it('carries a pending pull request URL and rejects anything else', () => {
    expect(parseRestoreHint({
      ...restoring,
      pendingPullRequestUrl: 'https://github.com/acme/app/pull/717?files=1'
    }).pendingPullRequestUrl).toBe('https://github.com/acme/app/pull/717')
    expect(parseRestoreHint({ ...restoring, pendingPullRequestUrl: 'not a url' }).pendingPullRequestUrl).toBeNull()
    expect(parseRestoreHint({ ...restoring, pendingPullRequestUrl: 42 }).pendingPullRequestUrl).toBeNull()
    expect(EMPTY_RESTORE_HINT.pendingPullRequestUrl).toBeNull()
  })

  it('treats a missing folder as not restorable', () => {
    expect(parseRestoreHint({
      lastRoot: '/missing',
      restoreLastFolder: true,
      themeType: 'dark',
      folderPresent: false,
      restoring: true
    })).toEqual({
      lastRoot: '/missing',
      restoreLastFolder: true,
      themeType: 'dark',
      canvasColor: null,
      folderPresent: false,
      restoring: false,
      pendingPullRequestUrl: null
    })
    expect(sessionRestoreExpected(parseRestoreHint({
      lastRoot: '/missing',
      restoreLastFolder: true,
      folderPresent: false
    }))).toBe(false)
  })

  it('survives a corrupt payload', () => {
    expect(parseRestoreHint(null)).toEqual(EMPTY_RESTORE_HINT)
    expect(parseRestoreHint('{"lastRoot":"/work"}')).toEqual(EMPTY_RESTORE_HINT)
    expect(parseRestoreHint({ lastRoot: 7, restoreLastFolder: 'yes' })).toEqual(EMPTY_RESTORE_HINT)
  })
})

describe('shouldRestoreLastFolder', () => {
  it('restores a present last folder in a normal launch', () => {
    expect(shouldRestoreLastFolder({
      startHidden: false,
      restoreLastFolder: true,
      lastRoot: '/work/kodi',
      folderPresent: true
    })).toBe(true)
  })

  it('still restores when lastRoot is only on the workspace cache', () => {
    expect(shouldRestoreLastFolder({
      startHidden: false,
      restoreLastFolder: true,
      lastRoot: effectiveLastRoot(null, '/Users/fuadnafiz98/Developer/materialx/materialsx-core-3'),
      folderPresent: true
    })).toBe(true)
  })

  it('skips warmup, missing folders, and the user opt-out', () => {
    const ready = {
      startHidden: false,
      restoreLastFolder: true,
      lastRoot: '/work/kodi',
      folderPresent: true
    }
    expect(shouldRestoreLastFolder({ ...ready, startHidden: true })).toBe(false)
    expect(shouldRestoreLastFolder({ ...ready, folderPresent: false })).toBe(false)
    expect(shouldRestoreLastFolder({ ...ready, restoreLastFolder: false })).toBe(false)
    expect(shouldRestoreLastFolder({ ...ready, lastRoot: null })).toBe(false)
  })
})

describe('sessionRestoreExpected', () => {
  it('requires a present last folder and the restore preference', () => {
    expect(sessionRestoreExpected(restoring)).toBe(true)
    expect(sessionRestoreExpected({ ...restoring, restoring: false })).toBe(false)
    expect(sessionRestoreExpected({ ...restoring, restoreLastFolder: false, restoring: false })).toBe(false)
    expect(sessionRestoreExpected(null)).toBe(false)
  })
})

describe('restorePendingFromHint', () => {
  it('keeps chrome pending when the hint is missing so Welcome cannot win the first paint', () => {
    expect(restorePendingFromHint(null, true)).toBe(true)
    expect(restorePendingFromHint(EMPTY_RESTORE_HINT, true)).toBe(true)
    expect(restorePendingFromHint(EMPTY_RESTORE_HINT, false)).toBe(false)
  })

  it('does not hold Welcome back when the folder is gone', () => {
    expect(restorePendingFromHint({
      lastRoot: '/gone',
      restoreLastFolder: true,
      themeType: 'dark',
      folderPresent: false,
      restoring: false,
      pendingPullRequestUrl: null
    }, true)).toBe(false)
  })
})

describe('sessionWorkspaceStage', () => {
  it('paints the workspace chrome while restore is in flight', () => {
    expect(sessionWorkspaceStage({
      hasNewWorld: false,
      snapshot: null,
      restorePending: true,
      pullRequestPending: false
    })).toBe('opening')
  })

  it('does not let the default new-tab world flash Welcome during restore', () => {
    expect(sessionWorkspaceStage({
      hasNewWorld: true,
      snapshot: null,
      restorePending: true,
      pullRequestPending: false
    })).toBe('opening')
  })

  it('does not flash Welcome when a snapshot is already in hand', () => {
    expect(sessionWorkspaceStage({
      hasNewWorld: false,
      snapshot: { root: '/work/kodi' },
      restorePending: true,
      pullRequestPending: false
    })).toBe('workspace')
  })

  it('paints the cached workspace even if a synthetic new tab still exists', () => {
    expect(sessionWorkspaceStage({
      hasNewWorld: true,
      snapshot: { root: '/work/kodi' },
      restorePending: true,
      pullRequestPending: false
    })).toBe('workspace')
  })

  it('falls back to Welcome after an empty snapshot settles', () => {
    expect(sessionWorkspaceStage({
      hasNewWorld: false,
      snapshot: null,
      restorePending: false,
      pullRequestPending: false
    })).toBe('welcome')
  })

  it('keeps a deep-linked pull request on Welcome while restore is in flight', () => {
    expect(sessionWorkspaceStage({
      hasNewWorld: true,
      snapshot: null,
      restorePending: true,
      pullRequestPending: true
    })).toBe('welcome')
  })

  it('keeps a deep-linked pull request on Welcome even when a cached folder exists', () => {
    expect(sessionWorkspaceStage({
      hasNewWorld: true,
      snapshot: { root: '/work/kodi' },
      restorePending: true,
      pullRequestPending: true
    })).toBe('welcome')
  })

  it('keeps a missing-folder launch on Welcome', () => {
    expect(sessionWorkspaceStage({
      hasNewWorld: false,
      snapshot: null,
      restorePending: sessionRestoreExpected({
        lastRoot: '/gone',
        restoreLastFolder: true,
        themeType: 'dark',
        folderPresent: false,
        restoring: false,
        pendingPullRequestUrl: null
      }),
      pullRequestPending: false
    })).toBe('welcome')
  })
})

describe('startupSnapshotAction', () => {
  it('ignores a snapshot that arrives after the first effect was cancelled', () => {
    expect(startupSnapshotAction({
      cancelled: true,
      snapshot: { root: '/work/kodi' }
    })).toBe('ignore')
  })

  it('applies a late snapshot on the live effect', () => {
    expect(startupSnapshotAction({
      cancelled: false,
      snapshot: { root: '/work/kodi' }
    })).toBe('apply')
  })

  it('opens Welcome when restore settles empty', () => {
    expect(startupSnapshotAction({ cancelled: false, snapshot: null })).toBe('welcome')
  })

  it('does not treat a null live snapshot as failure when the cache already painted', () => {
    expect(startupSnapshotAction({
      cancelled: false,
      snapshot: null,
      paintedSnapshot: { root: '/Users/fuadnafiz98/Developer/materialx/materialsx-core-3' }
    })).toBe('ignore')
    expect(shouldReportRestoreFailure({
      action: 'ignore',
      restoreExpected: true
    })).toBe(false)
  })

  it('only reports reopen failure when restore was expected and nothing painted', () => {
    expect(shouldReportRestoreFailure({ action: 'welcome', restoreExpected: true })).toBe(true)
    expect(shouldReportRestoreFailure({ action: 'welcome', restoreExpected: false })).toBe(false)
    expect(shouldReportRestoreFailure({ action: 'apply', restoreExpected: true })).toBe(false)
  })
})

describe('restoreHintFromArgv', () => {
  it('round-trips a hint through the BrowserWindow argument', () => {
    expect(restoreHintFromArgv(['electron', encodeRestoreHintArgument(restoring)])).toEqual(restoring)
  })

  it('returns null for a missing or corrupt argument', () => {
    expect(restoreHintFromArgv(['electron'])).toBeNull()
    expect(restoreHintFromArgv([`${RESTORE_HINT_ARG_PREFIX}%`])).toBeNull()
  })
})

describe('effectiveLastRoot', () => {
  it('prefers the session last root and falls back to the cache', () => {
    expect(effectiveLastRoot('/work/session', '/work/cache')).toBe('/work/session')
    expect(effectiveLastRoot(null, '/work/cache')).toBe('/work/cache')
    expect(effectiveLastRoot('', '/work/cache')).toBe('/work/cache')
    expect(effectiveLastRoot(null, null)).toBeNull()
  })
})

describe('isPrematureSessionError', () => {
  it('recognizes the raw IPC error that became the Welcome toast', () => {
    expect(isPrematureSessionError(
      new Error("Error invoking remote method 'repository.get-comparison': Error: Open a repository before using this action.")
    )).toBe(true)
    expect(isPrematureSessionError(new Error('Open a repository before using this action.'))).toBe(true)
    expect(isPrematureSessionError(new Error('“Makefile” is no longer in the folder.'))).toBe(false)
  })
})

describe('applyRestoreHintToDocument', () => {
  it('marks the boot document for a restored folder', () => {
    const dataset: Record<string, string | undefined> = {}
    applyRestoreHintToDocument({ dataset }, restoring)
    expect(dataset.kodiTheme).toBe('light')
    expect(dataset.kodiRestore).toBe('folder')
  })

  it('marks Welcome when there is nothing to restore', () => {
    const dataset: Record<string, string | undefined> = {}
    applyRestoreHintToDocument({ dataset }, EMPTY_RESTORE_HINT)
    expect(dataset.kodiRestore).toBe('welcome')
  })
})
