import { describe, expect, it } from 'bun:test'

import {
  firstTreePath,
  getDirectoryPaths,
  getTreeFollowBehavior,
  orderPathsForTree,
  treeContentSyncMode
} from './treeExpansion'

describe('treeContentSyncMode', () => {
  const root = '/repo'
  const paths = ['src/a.ts', 'src/b.ts']
  const statuses = [{ path: 'src/a.ts', status: 'modified' }]
  const applied = { root, paths, statuses }

  it('skips work when the tree already has this content', () => {
    expect(treeContentSyncMode(applied, root, paths, statuses)).toBe('skip')
  })

  it('updates decorations without resetting when only statuses change', () => {
    const nextStatuses = [{ path: 'src/a.ts', status: 'added' }]
    expect(treeContentSyncMode(applied, root, paths, nextStatuses)).toBe('status')
  })

  it('resets when the path list itself changes', () => {
    expect(treeContentSyncMode(applied, root, [...paths, 'src/c.ts'], statuses)).toBe('reset')
  })

  it('adopts the first content without a collapse pass', () => {
    expect(treeContentSyncMode(null, root, paths, statuses)).toBe('adopt')
  })

  it('adopts content for a different root', () => {
    expect(treeContentSyncMode(applied, '/other', paths, statuses)).toBe('adopt')
  })

  it('adopts the git snapshot that replaces an empty skeleton listing', () => {
    expect(treeContentSyncMode({ root, paths: [], statuses: [] }, root, paths, statuses))
      .toBe('adopt')
  })
})

describe('getTreeFollowBehavior', () => {
  it('centers the active file instantly when the review scroll drives the tree', () => {
    expect(getTreeFollowBehavior('review-scroll')).toEqual({ offset: 'center', animate: false })
  })

  it('does not recenter the tree during direct navigation', () => {
    expect(getTreeFollowBehavior('direct-navigation')).toEqual({ offset: 'nearest', animate: false })
  })
})

describe('firstTreePath', () => {
  it('picks the folders-first file, not the byte-sorted path', () => {
    expect(firstTreePath([
      'apps/web/src/chat/ChatMessageItem.tsx',
      'apps/web/src/chat/PromptAttachmentControls.tsx',
      'apps/web/src/chat/attachment-preview/AttachmentPreviewChips.tsx'
    ])).toBe('apps/web/src/chat/attachment-preview/AttachmentPreviewChips.tsx')
  })

  it('returns null for an empty list', () => {
    expect(firstTreePath([])).toBeNull()
  })
})

describe('orderPathsForTree', () => {
  it('matches the tree natural folders-first order', () => {
    expect(orderPathsForTree([
      'src/page10.tsx',
      'README.md',
      'app/page.tsx',
      'src/page2.tsx',
      'package.json'
    ])).toEqual([
      'app/page.tsx',
      'src/page2.tsx',
      'src/page10.tsx',
      'package.json',
      'README.md'
    ])
  })
})

describe('getDirectoryPaths', () => {
  it('returns each parent directory once from shallowest to deepest', () => {
    expect(getDirectoryPaths([
      'src/renderer/App.tsx',
      'src/main/index.ts',
      'README.md'
    ])).toEqual([
      'src',
      'src/main',
      'src/renderer'
    ])
  })

  it('returns no directories for root files', () => {
    expect(getDirectoryPaths(['README.md', 'package.json'])).toEqual([])
  })

  it('lists every parent before its children', () => {
    const directoryPaths = getDirectoryPaths([
      'a/b/c/deep.ts',
      'a/other.ts',
      'z/top.ts'
    ])
    expect(directoryPaths).toEqual(['a', 'z', 'a/b', 'a/b/c'])
    for (const directoryPath of directoryPaths) {
      const parent = directoryPath.slice(0, directoryPath.lastIndexOf('/'))
      if (parent === '') continue
      expect(directoryPaths.indexOf(parent)).toBeLessThan(directoryPaths.indexOf(directoryPath))
    }
  })

  it('deduplicates repeated ancestors across files', () => {
    expect(getDirectoryPaths(['src/a.ts', 'src/b.ts', 'src/nested/c.ts']))
      .toEqual(['src', 'src/nested'])
  })

  it('returns the same array for the same input identity', () => {
    const filePaths = ['src/a.ts', 'src/nested/b.ts']
    expect(getDirectoryPaths(filePaths)).toBe(getDirectoryPaths(filePaths))
    expect(getDirectoryPaths([...filePaths])).toEqual(getDirectoryPaths(filePaths))
  })
})
