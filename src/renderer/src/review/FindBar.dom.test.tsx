import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { parseDiffFromFile, type CodeView, type CodeViewItem } from '@pierre/diffs'

import type { RepositoryApi } from '../../../shared/contracts'
import { FindBar } from './FindBar'

function diffItem(path: string, after: string): CodeViewItem<unknown> {
  return {
    id: `review:${path}`,
    type: 'diff',
    fileDiff: parseDiffFromFile({ name: path, contents: 'a\nb\nc\n' }, { name: path, contents: after })
  } as CodeViewItem<unknown>
}

afterEach(() => {
  cleanup()
  delete window.repository
})

describe('FindBar', () => {
  test('draws nothing until ⌘F, then opens the panel with its input focused', async () => {
    const findInPage = mock(async () => {})
    window.repository = {
      findInPage,
      stopFindInPage: async () => {},
      onFoundInPage: () => () => {}
    } as unknown as RepositoryApi
    const { container } = render(<FindBar />)
    expect(container.innerHTML).toBe('')

    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    const input = await screen.findByLabelText('Find in current view')
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(container.querySelector('.find-bar[data-open]')).not.toBeNull()

    fireEvent.change(input, { target: { value: 'needle' } })
    await waitFor(() => expect(findInPage).toHaveBeenCalledWith('needle', true, false))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(container.querySelector('.find-bar[data-open]')).toBeNull())
  })

  test('over a review, counts matches in every file and moves the viewer to each', async () => {
    const findInPage = mock(async () => {})
    window.repository = {
      findInPage,
      stopFindInPage: async () => {},
      onFoundInPage: () => () => {}
    } as unknown as RepositoryApi
    const container = document.createElement('div')
    container.checkVisibility = () => true
    document.body.append(container)
    const scrollTo = mock(() => {})
    // Only the first file is drawn; the second exists in the model alone.
    const items = [diffItem('one.ts', 'a\nneedle\nc\n'), diffItem('two.ts', 'a\nb\nc\nlast needle\n')]
    const viewer = {
      getContainerElement: () => container,
      getItem: () => undefined,
      getRenderedItems: () => [],
      getScrollTop: () => 0,
      getTopForItem: () => undefined,
      subscribeToScroll: () => () => {},
      scrollTo
    } as unknown as CodeView<unknown>
    const source = { viewer: () => viewer, items: () => items, expand: () => {} }
    const sources = window.__kodiReviewFind ??= new Set()
    sources.add(source)
    const unpublish = (): void => { sources.delete(source) }
    try {
      render(<FindBar />)
      fireEvent.keyDown(window, { key: 'f', metaKey: true })
      const input = await screen.findByLabelText('Find in current view')
      fireEvent.change(input, { target: { value: 'needle' } })
      await waitFor(() => expect(document.querySelector('.find-count')?.textContent).toBe('1/2'))

      fireEvent.keyDown(input, { key: 'Enter' })
      await waitFor(() => expect(document.querySelector('.find-count')?.textContent).toBe('2/2'))
      await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({
        type: 'line', id: 'review:two.ts', lineNumber: 4, side: 'additions', align: 'center', behavior: 'instant'
      }))
      fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
      await waitFor(() => expect(document.querySelector('.find-count')?.textContent).toBe('1/2'))
      // ⌘G / ⇧⌘G step too, ahead of an app shortcut on the same chord (⇧⌘G
      // toggles the Guide), which then sees the key taken.
      fireEvent.keyDown(window, { key: 'g', metaKey: true })
      await waitFor(() => expect(document.querySelector('.find-count')?.textContent).toBe('2/2'))
      let appSawIt = false
      const appShortcut = (event: KeyboardEvent): void => { if (!event.defaultPrevented) appSawIt = true }
      window.addEventListener('keydown', appShortcut)
      fireEvent.keyDown(window, { key: 'G', metaKey: true, shiftKey: true })
      window.removeEventListener('keydown', appShortcut)
      await waitFor(() => expect(document.querySelector('.find-count')?.textContent).toBe('1/2'))
      expect(appSawIt).toBe(false)
      expect(findInPage).not.toHaveBeenCalled()
    } finally {
      unpublish()
      container.remove()
    }
  })

  test('leaves ⌘F to an editor that has the caret', () => {
    const editor = document.createElement('div')
    editor.contentEditable = 'true'
    document.body.append(editor)
    editor.focus()
    const { container } = render(<FindBar />)

    fireEvent.keyDown(window, { key: 'f', metaKey: true })
    expect(container.innerHTML).toBe('')
    editor.remove()
  })
})
