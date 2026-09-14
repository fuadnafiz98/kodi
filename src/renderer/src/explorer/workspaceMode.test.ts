import { describe, expect, it } from 'bun:test'

import type { RepositoryReview } from '../../../shared/contracts'
import {
  automaticWorkspaceView,
  firstOpenPathForSnapshot,
  reviewPathsForSnapshot,
  workspaceViewForTreePath
} from './workspaceMode'

describe('automaticWorkspaceView', () => {
  it('uses one continuous review when the working tree has changes', () => {
    expect(automaticWorkspaceView({ kind: 'git', statuses: [{ path: 'src/app.ts', status: 'modified' }] }, null))
      .toBe('multi')
  })

  it('uses file preview for a clean repository or a plain folder', () => {
    expect(automaticWorkspaceView({ kind: 'git', statuses: [] }, null)).toBe('file')
    expect(automaticWorkspaceView({ kind: 'folder', statuses: [] }, null)).toBe('file')
  })

  it('keeps an external review in multi-file mode even when the working tree is clean', () => {
    expect(automaticWorkspaceView(
      { kind: 'git', statuses: [] },
      { kind: 'local' } as RepositoryReview
    )).toBe('multi')
  })
})

describe('workspaceViewForTreePath', () => {
  it('opens files outside the current review as full-file previews', () => {
    expect(workspaceViewForTreePath('multi', false, false)).toBe('file')
  })

  it('returns to the review when a changed file is selected', () => {
    expect(workspaceViewForTreePath('file', true, false)).toBe('multi')
  })

  it('does not interrupt an active edit session', () => {
    expect(workspaceViewForTreePath('file', true, true)).toBe('file')
  })
})

describe('reviewPathsForSnapshot', () => {
  it('uses the external review files when a review is open', () => {
    expect(reviewPathsForSnapshot(
      { kind: 'git', statuses: [{ path: 'local.ts', status: 'modified' }] },
      { files: [{ path: 'review.ts', additions: 1, deletions: 0 }] }
    )).toEqual(['review.ts'])
  })

  it('uses working-tree changes for a Git repository', () => {
    expect(reviewPathsForSnapshot({
      kind: 'git',
      statuses: [{ path: 'src/app.ts', status: 'modified' }]
    }, null)).toEqual(['src/app.ts'])
  })

  it('has no review paths for a plain folder', () => {
    expect(reviewPathsForSnapshot({ kind: 'folder', statuses: [] }, null)).toEqual([])
  })
})

describe('firstOpenPathForSnapshot', () => {
  it('opens the first explorer file, not the first byte-sorted status', () => {
    expect(firstOpenPathForSnapshot({
      kind: 'git',
      paths: [],
      statuses: [
        { path: 'apps/web/src/chat/ChatMessageItem.tsx', status: 'modified' },
        { path: 'apps/web/src/chat/attachment-preview/AttachmentPreviewChips.tsx', status: 'modified' }
      ]
    })).toBe('apps/web/src/chat/attachment-preview/AttachmentPreviewChips.tsx')
  })

  it('opens the first tree file in a plain folder', () => {
    expect(firstOpenPathForSnapshot({
      kind: 'folder',
      paths: ['readme.md', 'src/app.ts'],
      statuses: []
    })).toBe('src/app.ts')
  })
})
