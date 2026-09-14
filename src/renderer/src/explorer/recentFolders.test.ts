import { describe, expect, test } from 'bun:test'

import type { RepositorySnapshot } from '../../../shared/contracts'
import { rememberRecentFolder, type RecentFolder } from './recentFolders'

function snapshot(root: string, name: string): RepositorySnapshot {
  return { root, name, kind: 'folder', branch: null, head: null, paths: [], statuses: [] }
}

describe('rememberRecentFolder', () => {
  test('moves an opened folder to the front without duplicates', () => {
    const current: RecentFolder[] = [
      { name: 'One', path: '/one', lastOpenedAt: 1 },
      { name: 'Two', path: '/two', lastOpenedAt: 2 }
    ]

    expect(rememberRecentFolder(current, snapshot('/two', 'Two'), 3)).toEqual([
      { name: 'Two', path: '/two', lastOpenedAt: 3 },
      { name: 'One', path: '/one', lastOpenedAt: 1 }
    ])
  })

  test('keeps only the eight latest folders', () => {
    const current = Array.from({ length: 8 }, (_, index) => ({
      name: `Folder ${index}`,
      path: `/folder-${index}`,
      lastOpenedAt: index
    }))

    const result = rememberRecentFolder(current, snapshot('/new', 'New'), 9)
    expect(result).toHaveLength(8)
    expect(result[0]?.path).toBe('/new')
    expect(result.some((folder) => folder.path === '/folder-7')).toBe(false)
  })
})
