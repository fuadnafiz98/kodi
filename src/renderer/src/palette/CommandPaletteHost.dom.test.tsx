import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createRef, memo, useEffect } from 'react'

import type { RepositoryApi, RepositorySnapshot } from '../../../shared/contracts'
import {
  CommandPaletteHost,
  CommandPaletteShell,
  PALETTE_OPEN_MEASURE,
  type CommandPaletteHandle
} from './CommandPaletteHost'
import { fileSearchIndexBuilds, isFileSearchIndexWarm } from './fileSearch'
import { DEFAULT_KEYBINDINGS } from '../settings/keybindings'
import { clearSearchResults } from './searchResultsStore'
import { markWorkspaceRender } from '../perf/workspaceRenderMetric'

const snapshot: RepositorySnapshot = {
  root: '/repo',
  name: 'repo',
  kind: 'git',
  branch: 'main',
  head: 'head',
  paths: ['src/app.ts', 'src/other.ts'],
  statuses: []
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
  performance.clearMeasures(PALETTE_OPEN_MEASURE)
  delete window.repository
  delete window.__kodiMetrics
})

function paletteInput(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>('#command-palette-input')
}

function hostProps(): Omit<React.ComponentProps<typeof CommandPaletteHost>, 'ref'> {
  return {
    snapshot,
    keybindings: DEFAULT_KEYBINDINGS,
    onError: () => {},
    onRunCommand: () => {},
    onOpenPullRequest: () => {},
    onOpenRepository: () => {},
    onOpenSettings: () => {},
    onToggleTerminal: () => {},
    onOpenFile: () => {}
  }
}

test('the shell shows a focused input with no palette chunk loaded', () => {
  const onChange = mock(() => {})
  const { container } = render(
    <CommandPaletteShell keybinding="⌘P" value="ap" onChange={onChange} onClose={() => {}} />
  )

  const input = paletteInput()
  expect(input?.value).toBe('ap')
  expect(document.activeElement).toBe(input)
  // Nothing from the palette chunk is on screen: no rows, no result list content.
  expect(container.querySelectorAll('button')).toHaveLength(0)
  expect(container.querySelector('.command-palette-results')?.textContent).toBe('')

  fireEvent.change(input!, { target: { value: 'app' } })
  expect(onChange).toHaveBeenCalledWith('app')
})

test('the shell closes on cancel', () => {
  const onClose = mock(() => {})
  render(<CommandPaletteShell keybinding="⌘P" value="" onChange={() => {}} onClose={onClose} />)

  fireEvent.pointerDown(screen.getByRole('dialog'))
  expect(onClose).toHaveBeenCalled()
})

test('open focuses an input on the spot and the palette adopts what was typed', async () => {
  const ref = createRef<CommandPaletteHandle>()
  render(<CommandPaletteHost ref={ref} {...hostProps()} />)

  act(() => ref.current?.open())
  expect(document.activeElement).toBe(paletteInput())

  fireEvent.change(paletteInput()!, { target: { value: 'app' } })

  await waitFor(() => {
    expect(screen.getByRole('button', { name: /app\.ts/ })).toBeTruthy()
  })
  expect(paletteInput()?.value).toBe('app')
})

const WorkspaceStandIn = memo(function WorkspaceStandIn(): React.JSX.Element {
  useEffect(markWorkspaceRender)
  return <div data-testid="workspace" />
})

test('the open frame looks the index up and leaves the panel to the next one', async () => {
  const ref = createRef<CommandPaletteHandle>()
  render(
    <>
      <CommandPaletteHost ref={ref} {...hostProps()} />
      <WorkspaceStandIn />
    </>
  )

  // Mounting the host warms the index for the snapshot it was handed, off the
  // path Cmd+P takes.
  await waitFor(() => {
    expect(isFileSearchIndexWarm(snapshot.paths)).toBe(true)
  })
  const builds = fileSearchIndexBuilds()
  const renders = window.__kodiMetrics?.workspaceRenders ?? 0

  act(() => ref.current?.open())

  expect(document.activeElement).toBe(paletteInput())
  expect(fileSearchIndexBuilds()).toBe(builds)
  // Nothing the panel costs — rows, icons, ranking — is on the open frame, and
  // the workspace behind it does not render at all.
  expect(document.querySelectorAll('.command-palette-results button')).toHaveLength(0)
  expect(window.__kodiMetrics?.workspaceRenders ?? 0).toBe(renders)

  await waitFor(() => {
    expect(screen.getByRole('button', { name: /app\.ts/ })).toBeTruthy()
  })
  expect(fileSearchIndexBuilds()).toBe(builds)
  expect(document.activeElement).toBe(paletteInput())
  expect(window.__kodiMetrics?.workspaceRenders ?? 0).toBe(renders)
})

test('opening records how long the app took to focus the input', () => {
  const ref = createRef<CommandPaletteHandle>()
  render(<CommandPaletteHost ref={ref} {...hostProps()} />)

  act(() => ref.current?.open())

  const measures = performance.getEntriesByName(PALETTE_OPEN_MEASURE)
  expect(measures).toHaveLength(1)
  expect(measures[0]!.duration).toBeGreaterThanOrEqual(0)
})

test('toggle and close drive the palette without remounting the host', async () => {
  const ref = createRef<CommandPaletteHandle>()
  render(<CommandPaletteHost ref={ref} {...hostProps()} />)

  expect(ref.current?.close()).toBe(false)
  act(() => ref.current?.toggle())
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /Toggle explorer/ })).toBeTruthy()
  })

  act(() => { ref.current?.close() })
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('typing in the palette does not re-render the workspace', async () => {
  const ref = createRef<CommandPaletteHandle>()
  render(
    <>
      <CommandPaletteHost ref={ref} {...hostProps()} />
      <WorkspaceStandIn />
    </>
  )

  act(() => ref.current?.open())
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /Toggle explorer/ })).toBeTruthy()
  })

  const before = window.__kodiMetrics?.workspaceRenders ?? 0
  const input = paletteInput()!
  for (const query of ['a', 'ap', 'app', 'app.', 'app.t', 'app.ts']) {
    fireEvent.change(input, { target: { value: query } })
  }
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /app\.ts/ })).toBeTruthy()
  })

  expect(window.__kodiMetrics?.workspaceRenders).toBe(before)
})
