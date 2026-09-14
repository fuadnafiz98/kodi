import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react'

import type { FileComparison, RepositoryApi } from '../../../shared/contracts'
import { shouldAutosaveOnBlur, useFileEditing } from './useFileEditing'

afterEach(() => {
  cleanup()
  localStorage.clear()
  delete window.repository
})

function comparison(contents: string, cacheKey: string): FileComparison {
  return {
    path: 'src/app.ts',
    mode: 'diff',
    status: 'modified',
    oldFile: { name: 'src/app.ts', contents: 'const value = 0\n', cacheKey: 'old' },
    newFile: { name: 'src/app.ts', contents, cacheKey },
    binary: false,
    oversized: false
  }
}

function options(current: FileComparison, onComparisonChange = mock(() => {})) {
  return {
    root: '/work/kodi',
    comparison: current,
    selectedPath: current.path,
    workspaceView: 'file' as const,
    repositoryReview: null,
    autosaveOnBlur: false,
    onWorkspaceViewChange: mock(() => {}),
    onSelectPath: mock(() => {}),
    onComparisonChange,
    onError: mock(() => {})
  }
}

describe('useFileEditing', () => {
  test('saves with the keyboard and keeps the session alive', async () => {
    const initial = comparison('const value = 1\n', 'one')
    const saved = comparison('const value = 2\n', 'two')
    const saveWorkingFile = mock(async () => saved)
    window.repository = { saveWorkingFile } as unknown as RepositoryApi
    const { result } = renderHook(() => useFileEditing(options(initial)))

    act(() => result.current.controls.onStart())
    await waitFor(() => expect(result.current.activeSession).not.toBeNull())
    act(() => result.current.updateDraftFile({
      name: initial.path,
      contents: 'const value = 2\n',
      cacheKey: 'one'
    }))
    await waitFor(() => expect(result.current.controls.dirty).toBe(true))
    fireEvent.keyDown(window, { key: 's', metaKey: true })

    await waitFor(() => expect(saveWorkingFile).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.controls.dirty).toBe(false))
    expect(result.current.activeSession).not.toBeNull()
  })

  test('offers both disk-conflict decisions', async () => {
    const initial = comparison('const value = 1\n', 'one')
    const props = options(initial)
    const { result, rerender } = renderHook(
      ({ current }) => useFileEditing({ ...props, comparison: current }),
      { initialProps: { current: initial } }
    )
    act(() => result.current.controls.onStart())
    await waitFor(() => expect(result.current.activeSession).not.toBeNull())
    act(() => result.current.updateDraftFile({
      name: initial.path,
      contents: 'my draft\n',
      cacheKey: 'one'
    }))
    rerender({ current: comparison('external edit\n', 'external') })
    await waitFor(() => expect(result.current.conflict).not.toBeNull())

    act(() => result.current.keepDraft())
    await waitFor(() => expect(result.current.conflict).toBeNull())
    rerender({ current: comparison('another edit\n', 'another') })
    await waitFor(() => expect(result.current.conflict).not.toBeNull())
    act(() => result.current.reloadFromDisk())
    await waitFor(() => expect(result.current.controls.dirty).toBe(false))
  })
})

test('autosave requires an enabled dirty conflict-free session', () => {
  expect(shouldAutosaveOnBlur({ enabled: true, dirty: true, saving: false, conflict: false })).toBe(true)
  expect(shouldAutosaveOnBlur({ enabled: false, dirty: true, saving: false, conflict: false })).toBe(false)
  expect(shouldAutosaveOnBlur({ enabled: true, dirty: true, saving: false, conflict: true })).toBe(false)
})
