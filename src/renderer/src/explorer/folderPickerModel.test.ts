import { describe, expect, test } from 'bun:test'

import type { FolderCandidate } from '../../../shared/contracts'
import { buildFolderPickerRows, rankFolderCandidates } from './folderPickerModel'
import type { RecentFolder } from './recentFolders'

const recents: RecentFolder[] = [
  { name: 'instranslate', path: '/Users/me/Developer/vibes/instranslate', lastOpenedAt: 2 },
  { name: 'kodi', path: '/Users/me/Developer/vibes/kodi', lastOpenedAt: 1 }
]

const catalog: FolderCandidate[] = [
  { name: 'echo', path: '/Users/me/Developer/personal/echo', displayPath: '~/Developer/personal/echo' },
  { name: 'echo', path: '/Users/me/Developer/vibes/echo', displayPath: '~/Developer/vibes/echo' },
  { name: 'echo-old', path: '/Users/me/Developer/vibes/echo-old', displayPath: '~/Developer/vibes/echo-old' },
  { name: 'instranslate', path: '/Users/me/Developer/vibes/instranslate', displayPath: '~/Developer/vibes/instranslate' }
]

describe('buildFolderPickerRows', () => {
  test('lists recents and the native picker when the query is empty', () => {
    const rows = buildFolderPickerRows(recents, catalog, '', '/Users/me')
    expect(rows.map((row) => row.kind)).toEqual(['folder', 'folder', 'native'])
    expect(rows[0]).toMatchObject({
      kind: 'folder',
      group: 'Recents',
      folder: { displayPath: '~/Developer/vibes/instranslate' }
    })
  })

  test('ranks typed matches and keeps the native picker last', () => {
    const rows = buildFolderPickerRows(recents, catalog, 'echo', '/Users/me')
    expect(rows.filter((row) => row.kind === 'folder').map((row) => {
      return row.kind === 'folder' ? row.folder.displayPath : ''
    })).toEqual([
      '~/Developer/personal/echo',
      '~/Developer/vibes/echo',
      '~/Developer/vibes/echo-old'
    ])
    expect(rows.at(-1)?.kind).toBe('native')
  })
})

describe('rankFolderCandidates', () => {
  test('a folder name beats a later path substring', () => {
    expect(rankFolderCandidates(catalog, 'echo').map((folder) => folder.path)).toEqual([
      '/Users/me/Developer/personal/echo',
      '/Users/me/Developer/vibes/echo',
      '/Users/me/Developer/vibes/echo-old'
    ])
  })
})
