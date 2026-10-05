import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { RepositoryApi } from '../../../shared/contracts'
import { FindBar } from './FindBar'

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
