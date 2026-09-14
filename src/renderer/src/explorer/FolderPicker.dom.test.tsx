import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import type { FolderPickerCatalog, RepositoryApi } from '../../../shared/contracts'
import { FolderChromeButton, FolderPicker } from './FolderPicker'
import type { RecentFolder } from './recentFolders'

afterEach(() => {
  cleanup()
  delete window.repository
})

const recents: RecentFolder[] = [
  { name: 'instranslate', path: '/Users/me/Developer/vibes/instranslate', lastOpenedAt: 2 }
]

const catalog: FolderPickerCatalog = {
  home: '/Users/me',
  folders: [
    { name: 'echo', path: '/Users/me/Developer/personal/echo', displayPath: '~/Developer/personal/echo' },
    { name: 'echo-old', path: '/Users/me/Developer/vibes/echo-old', displayPath: '~/Developer/vibes/echo-old' }
  ]
}

function mockRepository(next = catalog): void {
  window.repository = {
    listFolderCandidates: async () => next
  } as unknown as RepositoryApi
}

test('FolderChromeButton toggles the picker instead of the native dialog', () => {
  let toggled = false
  let native = false
  render(<FolderChromeButton opening={false} open={false} shortcut="⌘O" recentFolders={[]}
    openingPath={null} onToggle={() => { toggled = true }} onClose={() => {}}
    onSelect={() => {}} onUseExisting={() => { native = true }} />)

  screen.getByRole('button', { name: 'Open folder' }).click()
  expect(toggled).toBe(true)
  expect(native).toBe(false)
})

describe('FolderPicker', () => {
  test('lists recents and opens the native picker from the footer', async () => {
    mockRepository()
    const onSelect = mock(() => {})
    const onUseExisting = mock(() => {})
    render(<FolderPicker recentFolders={recents} openingPath={null}
      onClose={() => {}} onSelect={onSelect} onUseExisting={onUseExisting} />)

    expect(await screen.findByRole('option', { name: /instranslate/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('option', { name: /Use Existing/ }))
    expect(onUseExisting).toHaveBeenCalledTimes(1)
    expect(onSelect).not.toHaveBeenCalled()
  })

  test('filters catalog folders as the query is typed', async () => {
    mockRepository()
    const onSelect = mock(() => {})
    render(<FolderPicker recentFolders={recents} openingPath={null}
      onClose={() => {}} onSelect={onSelect} onUseExisting={() => {}} />)

    await screen.findByRole('option', { name: /instranslate/ })
    fireEvent.change(screen.getByLabelText('Search folders'), { target: { value: 'echo' } })
    expect(screen.getByRole('option', { name: '~/Developer/personal/echo' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '~/Developer/vibes/echo-old' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /instranslate/ })).toBeNull()

    fireEvent.click(screen.getByRole('option', { name: '~/Developer/personal/echo' }))
    expect(onSelect).toHaveBeenCalledWith('/Users/me/Developer/personal/echo')
  })

  test('the picked row waits ~80ms before it spins, so a fast open never blinks', async () => {
    mockRepository()
    const { rerender } = render(<FolderPicker recentFolders={recents} openingPath={null}
      onClose={() => {}} onSelect={() => {}} onUseExisting={() => {}} />)
    await screen.findByRole('option', { name: /instranslate/ })

    rerender(<FolderPicker recentFolders={recents} openingPath={recents[0]!.path}
      onClose={() => {}} onSelect={() => {}} onUseExisting={() => {}} />)
    expect(document.querySelector('.spin')).toBeNull()

    await waitFor(() => expect(document.querySelector('.spin')).toBeTruthy())
  })

  test('Enter opens the highlighted folder', async () => {
    mockRepository()
    const onSelect = mock(() => {})
    render(<FolderPicker recentFolders={recents} openingPath={null}
      onClose={() => {}} onSelect={onSelect} onUseExisting={() => {}} />)

    const input = await screen.findByLabelText('Search folders')
    fireEvent.change(input, { target: { value: 'echo-old' } })
    await waitFor(() => expect(screen.getByRole('option', { name: /echo-old/ })).toBeTruthy())
    fireEvent.submit(input.closest('form')!)
    expect(onSelect).toHaveBeenCalledWith('/Users/me/Developer/vibes/echo-old')
  })
})
