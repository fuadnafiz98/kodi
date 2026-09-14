import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'

import type { RepositoryApi, RepositorySnapshot } from '../../../shared/contracts'
import { CommandPalette, type CommandPaletteProps } from './CommandPalette'
import { DEFAULT_KEYBINDINGS } from '../settings/keybindings'
import { clearSearchResults } from './searchResultsStore'

const snapshot: RepositorySnapshot = {
  root: '/repo',
  name: 'repo',
  kind: 'git',
  branch: 'main',
  head: 'head',
  paths: ['src/app.ts', 'src/other.ts', 'docs/guide.md'],
  statuses: [{ path: 'src/other.ts', status: 'modified' }]
}

beforeEach(() => {
  window.repository = {
    cancelContentSearch: () => {},
    searchContent: async () => []
  } as unknown as RepositoryApi
})

afterEach(() => {
  cleanup()
  clearSearchResults()
  delete window.repository
})

type HarnessProps = Partial<CommandPaletteProps> & {
  onClose?(): void
}

/** The host owns visibility, so a test that asserts "closed" has to unmount it. */
function PaletteHarness({ onClose, ...props }: HarnessProps): React.JSX.Element | null {
  const [open, setOpen] = useState(true)
  if (!open) return null
  return (
    <CommandPalette
      snapshot={snapshot}
      keybindings={DEFAULT_KEYBINDINGS}
      onError={() => {}}
      onOpenPullRequest={() => {}}
      onOpenRepository={() => {}}
      onOpenSettings={() => {}}
      onToggleTerminal={() => {}}
      {...props}
      onClose={() => {
        setOpen(false)
        onClose?.()
      }}
    />
  )
}

function paletteInput(): HTMLElement {
  return screen.getByPlaceholderText('Search files, commands, or a pull request')
}

describe('CommandPalette', () => {
  test('runs application commands and closes', () => {
    const onRunCommand = mock(() => {})
    render(<PaletteHarness onRunCommand={onRunCommand} />)

    fireEvent.click(screen.getByRole('button', { name: /Toggle explorer/ }))

    expect(onRunCommand).toHaveBeenCalledWith('toggleSidebar')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('does not run project commands when no project is open', () => {
    const onRunCommand = mock(() => {})
    render(<PaletteHarness snapshot={null} onRunCommand={onRunCommand} />)

    const button = screen.getByRole('button', { name: /Toggle explorer/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onRunCommand).not.toHaveBeenCalled()
  })

  test('clamps the active row when the result list shrinks', () => {
    const recentFiles = Array.from({ length: 5 }, (_, index) => `src/file-${index}.ts`)
    render(<PaletteHarness recentFiles={recentFiles} onOpenFile={() => {}} />)

    const input = paletteInput()
    for (let step = 0; step < 40; step += 1) {
      fireEvent.keyDown(input, { key: 'ArrowDown' })
    }
    fireEvent.change(input, { target: { value: 'zzzz-no-palette-match' } })
    expect(screen.getByText('No matching files or commands')).toBeTruthy()
    fireEvent.change(input, { target: { value: '' } })
    expect(document.querySelector('.primary-result')).toBeTruthy()
  })

  test('lists repository file matches while typing', async () => {
    const onOpenFile = mock(() => {})
    render(<PaletteHarness onOpenFile={onOpenFile} />)

    fireEvent.change(paletteInput(), { target: { value: 'app' } })
    const row = await screen.findByRole('button', { name: /app\.ts/ })
    fireEvent.click(row)
    expect(onOpenFile).toHaveBeenCalledWith('src/app.ts')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('adopts the query the shell collected before the chunk arrived', async () => {
    render(<PaletteHarness initialQuery="app" onOpenFile={() => {}} />)

    expect((paletteInput() as HTMLInputElement).value).toBe('app')
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /app\.ts/ })).toBeTruthy()
    })
  })

  test('a leading > keeps the palette on commands', async () => {
    render(<PaletteHarness onRunCommand={() => {}} onOpenFile={() => {}} />)

    fireEvent.change(paletteInput(), { target: { value: '>wrap' } })
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Toggle word wrap/ })).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: /app\.ts/ })).toBeNull()
  })

  test('offers files, folders and three commands before anything is typed', () => {
    render(<PaletteHarness recentFiles={['docs/guide.md']} onRunCommand={() => {}} onOpenFile={() => {}} />)

    const groups = [...document.querySelectorAll('.command-palette-results > div > p')]
      .map((heading) => heading.textContent)
    expect(groups).toEqual(['Files', 'Commands'])

    const rows = [...document.querySelectorAll('.command-palette-results button')]
    expect(rows[0]?.textContent).toContain('guide.md')
    expect(screen.getByRole('button', { name: /other\.ts/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^src/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /More commands/ })).toBeTruthy()
  })

  test('More commands switches the palette to the command list', () => {
    render(<PaletteHarness onRunCommand={() => {}} onOpenFile={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: /More commands/ }))

    expect((paletteInput() as HTMLInputElement).value).toBe('>')
    expect(screen.queryByRole('button', { name: /More commands/ })).toBeNull()
    expect(screen.getByRole('button', { name: /Toggle word wrap/ })).toBeTruthy()
  })

  test('selecting a folder narrows the query instead of opening a file', async () => {
    const onOpenFile = mock(() => {})
    render(<PaletteHarness onOpenFile={onOpenFile} />)

    fireEvent.change(paletteInput(), { target: { value: 'docs' } })
    const folderRow = await screen.findByRole('button', { name: /^docs/ })
    fireEvent.click(folderRow)

    expect(onOpenFile).not.toHaveBeenCalled()
    expect((paletteInput() as HTMLInputElement).value).toBe('docs/')
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  test('selecting a folder also reveals it in the explorer', async () => {
    const onRevealDirectory = mock(() => {})
    render(<PaletteHarness onOpenFile={() => {}} onRevealDirectory={onRevealDirectory} />)

    fireEvent.change(paletteInput(), { target: { value: 'docs' } })
    fireEvent.click(await screen.findByRole('button', { name: /^docs/ }))

    expect(onRevealDirectory).toHaveBeenCalledWith('docs')
    expect((paletteInput() as HTMLInputElement).value).toBe('docs/')
  })

  test('ghost text completes the top path match and Tab accepts it', async () => {
    render(<PaletteHarness onOpenFile={() => {}} />)

    fireEvent.change(paletteInput(), { target: { value: 'src/a' } })
    await waitFor(() => {
      expect(document.querySelector('.command-palette-ghost')?.textContent).toBe('src/app.ts')
    })

    fireEvent.keyDown(paletteInput(), { key: 'Tab' })
    expect((paletteInput() as HTMLInputElement).value).toBe('src/app.ts')
    expect(document.querySelector('.command-palette-ghost')).toBeNull()
  })

  test('drops the opening hint once the panel has settled', async () => {
    render(<PaletteHarness />)
    const panel = document.querySelector('.command-palette')

    expect(panel?.getAttribute('data-opening')).toBe('true')
    await waitFor(() => {
      expect(panel?.hasAttribute('data-opening')).toBe(false)
    })
  })

  test('one delegated pointer handler makes the row under the cursor active', () => {
    render(<PaletteHarness onRunCommand={() => {}} onOpenFile={() => {}} />)

    const row = screen.getByRole('button', { name: /Toggle explorer/ })
    expect(row.className ?? '').not.toContain('primary-result')
    // Fire on a child: the handler lives on the list, not on the row.
    fireEvent.pointerMove(row.querySelector('strong')!)

    expect(row.className).toContain('primary-result')
    expect(row.getAttribute('data-index')).not.toBeNull()
  })

  test('a pointer down on the backdrop closes the palette', () => {
    render(<PaletteHarness />)

    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.pointerDown(screen.getByRole('dialog'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('clicking the dimmed overlay closes the palette', () => {
    render(<PaletteHarness />)

    fireEvent.click(screen.getByRole('button', { name: 'Close command palette' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  test('paints one screenful of rows first and the rest a frame later', async () => {
    const manyPaths: RepositorySnapshot = {
      ...snapshot,
      paths: Array.from({ length: 30 }, (_, index) => `src/file-${index}.ts`)
    }
    render(<PaletteHarness snapshot={manyPaths} onRunCommand={() => {}} onOpenFile={() => {}} />)

    const rows = (): number => document.querySelectorAll('.command-palette-results button').length
    expect(rows()).toBe(12)
    // The row the reader lands on is on screen, not in the batch still to come.
    expect(document.querySelector('.primary-result')?.getAttribute('data-index')).toBe('0')

    await waitFor(() => {
      expect(rows()).toBeGreaterThan(12)
    })
  })
})
