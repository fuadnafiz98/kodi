import { describe, expect, test } from 'bun:test'

import {
  includesPath,
  retainSnapshotIdentity,
  samePathList,
  sameStatusList,
  snapshotLooksUnchanged
} from './snapshotPaths'

describe('includesPath', () => {
  const paths = ['a.ts', 'src/App.tsx', 'src/b.ts', 'src/nested/c.ts', 'z.ts']

  test('finds every member of a sorted list', () => {
    for (const path of paths) expect(includesPath(paths, path)).toBe(true)
  })

  test('rejects paths that are not present', () => {
    expect(includesPath(paths, 'src/missing.ts')).toBe(false)
    expect(includesPath(paths, '')).toBe(false)
    expect(includesPath([], 'a.ts')).toBe(false)
  })

  test('still finds members when the list is not sorted', () => {
    const unsorted = ['z.ts', 'a.ts', 'src/b.ts']
    for (const path of unsorted) expect(includesPath(unsorted, path)).toBe(true)
    expect(includesPath(unsorted, 'q.ts')).toBe(false)
  })
})

describe('samePathList', () => {
  test('is true for the same identity', () => {
    const paths = ['a', 'b']
    expect(samePathList(paths, paths)).toBe(true)
  })

  test('is true for equal contents in equal order', () => {
    expect(samePathList(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(samePathList([], [])).toBe(true)
  })

  test('is false when length or contents differ', () => {
    expect(samePathList(['a'], ['a', 'b'])).toBe(false)
    expect(samePathList(['a', 'b'], ['a', 'c'])).toBe(false)
    expect(samePathList(['a', 'b'], ['b', 'a'])).toBe(false)
  })
})

describe('sameStatusList', () => {
  test('is true for equal contents in equal order', () => {
    const statuses = [{ path: 'a.ts', status: 'modified' }]
    expect(sameStatusList(statuses, statuses)).toBe(true)
    expect(sameStatusList(statuses, [{ path: 'a.ts', status: 'modified' }])).toBe(true)
  })

  test('is false when a status or rename changes', () => {
    expect(sameStatusList(
      [{ path: 'a.ts', status: 'modified' }],
      [{ path: 'a.ts', status: 'added' }]
    )).toBe(false)
    expect(sameStatusList(
      [{ path: 'a.ts', status: 'renamed', previousPath: 'b.ts' }],
      [{ path: 'a.ts', status: 'renamed', previousPath: 'c.ts' }]
    )).toBe(false)
  })
})

describe('retainSnapshotIdentity', () => {
  const snapshot = {
    root: '/repo',
    name: 'repo',
    kind: 'git' as const,
    branch: 'main',
    head: 'abc',
    paths: ['a.ts', 'b.ts'],
    statuses: [{ path: 'a.ts', status: 'modified' as const }]
  }

  test('reuses path and status arrays when a refresh only changes HEAD metadata', () => {
    const next = {
      ...snapshot,
      head: 'def',
      paths: [...snapshot.paths],
      statuses: [{ path: 'a.ts', status: 'modified' as const }]
    }
    const retained = retainSnapshotIdentity(snapshot, next)
    expect(retained.paths).toBe(snapshot.paths)
    expect(retained.statuses).toBe(snapshot.statuses)
    expect(retained.head).toBe('def')
  })

  test('keeps the selected path available after a status-only refresh', () => {
    const next = {
      ...snapshot,
      paths: [...snapshot.paths],
      statuses: [{ path: 'a.ts', status: 'modified' as const }, { path: 'b.ts', status: 'added' as const }]
    }
    const retained = retainSnapshotIdentity(snapshot, next)
    expect(retained.paths).toBe(snapshot.paths)
    expect(includesPath(retained.paths, 'a.ts')).toBe(true)
    expect(retained.statuses).toBe(next.statuses)
  })

  test('treats a retained no-op refresh as unchanged', () => {
    const next = retainSnapshotIdentity(snapshot, {
      ...snapshot,
      paths: [...snapshot.paths],
      statuses: [{ path: 'a.ts', status: 'modified' as const }]
    })
    expect(snapshotLooksUnchanged(snapshot, next)).toBe(true)
    expect(snapshotLooksUnchanged(snapshot, { ...next, head: 'zzz' })).toBe(false)
  })
})
