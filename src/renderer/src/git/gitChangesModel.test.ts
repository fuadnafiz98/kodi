import { describe, expect, test } from 'bun:test'

import type { RepositoryStatusEntry } from '../../../shared/contracts'
import {
  commitButtonLabel,
  groupChanges,
  looksSensitive,
  rangeBetween,
  sensitiveNewFiles,
  splitRepositoryPath,
  statusLetter
} from './gitChangesModel'

const statuses: RepositoryStatusEntry[] = [
  { path: 'src/staged.ts', status: 'modified', staged: 'all' },
  { path: 'src/partial.ts', status: 'modified', staged: 'partial' },
  { path: 'src/edited.ts', status: 'modified' },
  { path: 'notes.md', status: 'untracked' }
]

const paths = (entries: readonly RepositoryStatusEntry[]): string[] => entries.map((entry) => entry.path)

describe('groupChanges', () => {
  test('lists a partially staged file in both groups', () => {
    const groups = groupChanges(statuses, new Map())
    expect(paths(groups.staged)).toEqual(['src/staged.ts', 'src/partial.ts'])
    expect(paths(groups.unstaged)).toEqual(['src/partial.ts', 'src/edited.ts', 'notes.md'])
  })

  test('moves a pending file to where the click sent it', () => {
    const groups = groupChanges(statuses, new Map([
      ['notes.md', 'staged'],
      ['src/staged.ts', 'unstaged'],
      ['src/partial.ts', 'staged']
    ]))
    expect(paths(groups.staged)).toEqual(['src/partial.ts', 'notes.md'])
    expect(paths(groups.unstaged)).toEqual(['src/staged.ts', 'src/edited.ts'])
  })
})

describe('change labels', () => {
  test('splits a path into its name and directory', () => {
    expect(splitRepositoryPath('apps/web/page.tsx')).toEqual({ name: 'page.tsx', directory: 'apps/web' })
    expect(splitRepositoryPath('README.md')).toEqual({ name: 'README.md', directory: '' })
  })

  test('uses the letters VS Code shows', () => {
    expect(statusLetter('untracked')).toBe('U')
    expect(statusLetter('deleted')).toBe('D')
  })

  test('says Commit All when nothing is staged', () => {
    expect(commitButtonLabel(0, 3, false)).toBe('Commit All')
    expect(commitButtonLabel(2, 3, false)).toBe('Commit')
    expect(commitButtonLabel(0, 0, true)).toBe('Amend')
    expect(commitButtonLabel(0, 0, false)).toBe('Nothing to Commit')
  })
})

describe('secret guard', () => {
  test('flags credential-shaped names but not their templates', () => {
    for (const path of ['.env', 'apps/api/.env.local', '.env.op', 'deploy/server.pem', 'id_ed25519', '.npmrc', 'gcp/credentials.json']) {
      expect(looksSensitive(path)).toBe(true)
    }
    for (const path of ['.env.example', 'apps/.env.sample', 'env.ts', 'keyboard.tsx', 'src/key.ts', 'README.md']) {
      expect(looksSensitive(path)).toBe(false)
    }
  })

  test('only warns about files git has never tracked', () => {
    const entries: RepositoryStatusEntry[] = [
      { path: '.env.op', status: 'modified' },
      { path: 'apps/.env.local', status: 'untracked' },
      { path: 'notes.md', status: 'untracked' }
    ]
    expect(sensitiveNewFiles(entries)).toEqual(['apps/.env.local'])
    expect(sensitiveNewFiles(entries, new Set(['notes.md']))).toEqual([])
  })
})

describe('rangeBetween', () => {
  const order = ['a', 'b', 'c', 'd']
  test('selects inclusively in either direction', () => {
    expect(rangeBetween(order, 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeBetween(order, 'd', 'b')).toEqual(['b', 'c', 'd'])
  })
  test('falls back to the clicked row without an anchor', () => {
    expect(rangeBetween(order, null, 'c')).toEqual(['c'])
    expect(rangeBetween(order, 'gone', 'c')).toEqual(['c'])
  })
})
