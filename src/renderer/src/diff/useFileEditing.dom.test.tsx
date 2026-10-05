import { afterEach, describe, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, renderHook, waitFor } from '@testing-library/react'

import type { FileComparison, RepositoryApi } from '../../../shared/contracts'
import { comparisonFromCachedText } from '../../../shared/workspaceCache'
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

describe('editing on intent', () => {
  test('the text painted at launch is read until main sends the file, then edits tracked by path', async () => {
    const painted = comparisonFromCachedText({ path: 'src/app.ts', text: 'const value = 1\n' })!
    const live: FileComparison = { ...painted, newFile: { name: 'src/app.ts', contents: 'const value = 1\n', cacheKey: 'disk' } }
    const props = options(painted)
    const { result, rerender } = renderHook(
      ({ current }) => useFileEditing({ ...props, comparison: current }),
      { initialProps: { current: painted } }
    )
    // Typing into the stand-in went nowhere: its name was not the path, and its
    // key was not the disk's, so a save could only have failed.
    expect(result.current.controls.available).toBe(false)
    expect(result.current.controls.unavailableReason).toBeNull()
    act(() => result.current.controls.onStart({ lineNumber: 1, character: 2 }))
    await Promise.resolve()
    expect(result.current.hasSession).toBe(false)

    rerender({ current: live })
    act(() => result.current.controls.onStart({ lineNumber: 1, character: 2 }))
    await waitFor(() => expect(result.current.controls.mode).toBe('edit'))
    act(() => result.current.updateDraftFile({ name: 'src/app.ts', contents: 'const alue = 1\n', cacheKey: 'disk' }))
    await waitFor(() => expect(result.current.controls.dirty).toBe(true))
  })

  test('leaving the file ends the session and keeps the draft; coming back resumes it', async () => {
    const initial = comparison('const value = 1\n', 'one')
    const other: FileComparison = { ...comparison('other\n', 'other'), path: 'src/other.ts' }
    const props = options(initial)
    const { result, rerender } = renderHook(
      ({ current }) => useFileEditing({ ...props, comparison: current, selectedPath: current.path }),
      { initialProps: { current: initial } }
    )
    expect(result.current.controls.mode).toBe('read')
    act(() => result.current.controls.onStart({ lineNumber: 1, character: 6 }))
    await waitFor(() => expect(result.current.controls.mode).toBe('edit'))
    act(() => result.current.updateDraftFile({ name: initial.path, contents: 'my draft\n', cacheKey: 'one' }))
    await waitFor(() => expect(result.current.controls.dirty).toBe(true))

    rerender({ current: other })
    expect(result.current.hasSession).toBe(false)
    expect(result.current.controls.mode).toBe('read')
    expect(result.current.controls.unsavedPaths).toEqual([initial.path])

    // Back on the file: its draft is what opens, dirty, without a click.
    rerender({ current: initial })
    await waitFor(() => expect(result.current.controls.mode).toBe('edit'))
    expect(result.current.controls.dirty).toBe(true)
    expect(result.current.renderedComparison?.newFile?.contents).toBe('my draft\n')
  })

  test('disk coming back to a revision typed into renders a fresh document, not the typed one', async () => {
    const original = comparison('const value = 1\n', 'fresh-one')
    const saved = comparison('typed\n', 'fresh-two')
    window.repository = { saveWorkingFile: mock(async () => saved) } as unknown as RepositoryApi
    const props = options(original)
    const { result, rerender } = renderHook(
      ({ current }) => useFileEditing({ ...props, comparison: current }),
      { initialProps: { current: original } }
    )
    act(() => result.current.controls.onStart())
    await waitFor(() => expect(result.current.controls.mode).toBe('edit'))
    // Untouched, the session renders under the disk key: the highlight cache hits.
    expect(result.current.renderedComparison?.newFile?.cacheKey).toBe('fresh-one')
    act(() => result.current.updateDraftFile({ name: original.path, contents: 'typed\n', cacheKey: 'fresh-one' }))
    await waitFor(() => expect(result.current.controls.dirty).toBe(true))
    await act(async () => { result.current.controls.onSave() })
    await waitFor(() => expect(result.current.controls.dirty).toBe(false))
    rerender({ current: saved })
    // Put back from outside: the same content, so the same disk key, as at the start.
    rerender({ current: comparison('const value = 1\n', 'fresh-one') })
    await waitFor(() => expect(result.current.renderedComparison?.newFile?.contents).toBe('const value = 1\n'))
    // The clean session ended with the write; the next one must not reopen the
    // editor's document for "fresh-one", which holds the typed text.
    expect(result.current.controls.mode).toBe('read')
    act(() => result.current.controls.onStart())
    await waitFor(() => expect(result.current.controls.mode).toBe('edit'))
    expect(result.current.renderedComparison?.newFile?.cacheKey).not.toBe('fresh-one')
    expect(result.current.renderedComparison?.newFile?.contents).toBe('const value = 1\n')
  })

  test('a file in the review, binary, or under an open pull request is not offered', () => {
    const initial = comparison('const value = 1\n', 'one')
    const inReview = renderHook(() => useFileEditing({ ...options(initial), workspaceView: 'multi' }))
    expect(inReview.result.current.controls.available).toBe(false)
    const binary = renderHook(() => useFileEditing(options({ ...initial, binary: true })))
    expect(binary.result.current.controls.available).toBe(false)
    expect(binary.result.current.controls.unavailableReason).toBe('Binary files cannot be edited.')
  })
})

test('autosave requires an enabled dirty conflict-free session', () => {
  expect(shouldAutosaveOnBlur({ enabled: true, dirty: true, saving: false, conflict: false })).toBe(true)
  expect(shouldAutosaveOnBlur({ enabled: false, dirty: true, saving: false, conflict: false })).toBe(false)
  expect(shouldAutosaveOnBlur({ enabled: true, dirty: true, saving: false, conflict: true })).toBe(false)
})
