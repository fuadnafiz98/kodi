import { afterEach, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { FileTree as FileTreeModel } from '@pierre/trees'

// The tree is a custom element that registers a constructable stylesheet on
// definition, which happy-dom has no HTMLStyleElement for. The sidebar chrome
// around it is what these cover, so the widget stands in as an empty host.
mock.module('@pierre/trees/react', () => ({
  FileTree: () => null
}))

import { Explorer } from './Explorer'
import { EMPTY_REVIEW_FILE_FILTER, type ReviewFileFilter } from '../review/reviewFileFilter'

afterEach(cleanup)

const model = {
  getItem: () => null,
  getVisibleCount: () => 0,
  subscribe: () => () => {},
  scrollToPath: () => {}
} as unknown as FileTreeModel

const paths = [
  'src/app.ts',
  'src/app.test.ts',
  'src/api/users.ts',
  'README.md'
]

function Harness({
  fileFilter = EMPTY_REVIEW_FILE_FILTER,
  onFileFilterChange = () => {},
  filePaths = paths,
  unfilteredFilePaths = paths
}: {
  fileFilter?: ReviewFileFilter
  onFileFilterChange?(filter: ReviewFileFilter): void
  filePaths?: readonly string[]
  unfilteredFilePaths?: readonly string[]
}): React.JSX.Element {
  return (
    <Explorer filePaths={filePaths} model={model} theme="pierre-dark"
      sidebarVisible onSidebarToggle={() => {}} sidebarShortcut="⌘B"
      isGit reviewMode={false} branchName="main" onBranchesOpen={() => {}}
      onRowActivate={() => {}} fileFilter={fileFilter}
      onFileFilterChange={onFileFilterChange} unfilteredFilePaths={unfilteredFilePaths} />
  )
}

// A chip with no state to read is the complaint these replaced: the count says
// what it would take, and pressing it says so again in the fill.
test('filter chips report what they hide and carry their pressed state', async () => {
  const onFileFilterChange = mock(() => {})
  render(<Harness onFileFilterChange={onFileFilterChange} />)

  const tests = screen.getByRole('button', { name: /Hide tests/ })
  expect(tests.getAttribute('aria-pressed')).toBe('false')
  // Counted in idle slices after the tree paints, so the number arrives later.
  await waitFor(() => {
    expect(tests.querySelector('.filter-chip-count')?.textContent).toBe('1')
  })

  fireEvent.click(tests)
  expect(onFileFilterChange).toHaveBeenCalledWith({ ...EMPTY_REVIEW_FILE_FILTER, hideTests: true })
})

test('a pressed chip reads as pressed', () => {
  render(<Harness fileFilter={{ ...EMPTY_REVIEW_FILE_FILTER, hideApi: true }} />)

  expect(screen.getByRole('button', { name: /Hide API/ }).getAttribute('aria-pressed')).toBe('true')
})

// A control that would take nothing is a control with no effect.
test('a chip with nothing to hide is disabled', async () => {
  render(<Harness filePaths={['README.md']} unfilteredFilePaths={['README.md']} />)

  await waitFor(() => {
    expect(screen.getByRole('button', { name: /Hide tests/ }).hasAttribute('disabled')).toBe(true)
  })
  expect(screen.getByRole('button', { name: /Hide API/ }).hasAttribute('disabled')).toBe(true)
})

test('Clear appears only once a filter is doing something', () => {
  const onFileFilterChange = mock(() => {})
  const { rerender } = render(<Harness onFileFilterChange={onFileFilterChange} />)
  expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull()

  rerender(<Harness fileFilter={{ ...EMPTY_REVIEW_FILE_FILTER, hideTests: true }}
    onFileFilterChange={onFileFilterChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  expect(onFileFilterChange).toHaveBeenCalledWith(EMPTY_REVIEW_FILE_FILTER)
})

// One glyph, one name, in the heading and in the toolbar alike: a control
// reached this often is found by muscle memory, not by reading it.
test('the sidebar toggle names itself the same in both states', () => {
  render(<Harness />)

  const toggle = screen.getByRole('button', { name: 'Toggle explorer' })
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(toggle.getAttribute('aria-controls')).toBe('repository-explorer')
})

test('folders collapse and expand from one control', () => {
  render(<Harness />)

  expect(screen.getByRole('button', { name: 'Expand all folders' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Collapse all folders' })).toBeNull()
})
