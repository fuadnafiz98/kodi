import { afterEach, expect, test } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'

import { loadRecentFiles, useRecentFiles } from './recentFiles'

afterEach(() => {
  cleanup()
  localStorage.clear()
})

test('records every opened file and reloads the list for the root', () => {
  const { rerender, result } = renderHook(
    ({ root, path }: { root: string | null; path: string | null }) => useRecentFiles(root, path),
    { initialProps: { root: '/repo', path: null as string | null } }
  )

  rerender({ root: '/repo', path: 'src/a.ts' })
  rerender({ root: '/repo', path: 'src/b.ts' })

  expect(result.current).toEqual(['src/b.ts', 'src/a.ts'])
  expect(loadRecentFiles('/repo')).toEqual(['src/b.ts', 'src/a.ts'])
})

test('switching roots never writes one project history under the other key', () => {
  const { rerender, result } = renderHook(
    ({ root, path }: { root: string | null; path: string | null }) => useRecentFiles(root, path),
    { initialProps: { root: '/one', path: 'src/one.ts' as string | null } }
  )
  expect(result.current).toEqual(['src/one.ts'])

  rerender({ root: '/two', path: 'src/one.ts' })

  expect(loadRecentFiles('/one')).toEqual(['src/one.ts'])
  expect(loadRecentFiles('/two')).toEqual(['src/one.ts'])

  rerender({ root: '/two', path: 'src/two.ts' })
  expect(result.current).toEqual(['src/two.ts', 'src/one.ts'])
  expect(loadRecentFiles('/one')).toEqual(['src/one.ts'])
})

test('restores a stored list when the root comes back', () => {
  const { rerender, result } = renderHook(
    ({ root, path }: { root: string | null; path: string | null }) => useRecentFiles(root, path),
    { initialProps: { root: '/repo' as string | null, path: 'src/a.ts' as string | null } }
  )
  rerender({ root: null, path: null })
  expect(result.current).toEqual([])

  rerender({ root: '/repo', path: null })
  expect(result.current).toEqual(['src/a.ts'])
})
