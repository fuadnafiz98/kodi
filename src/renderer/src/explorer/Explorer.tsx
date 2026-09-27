import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { FileTree as FileTreeModel } from '@pierre/trees'
import { FileTree } from '@pierre/trees/react'
import {
  IconBranch,
  IconChevronsClose,
  IconExpandAll,
  IconSidebarLeft,
  IconX
} from '@pierre/icons'

import { getDirectoryPaths, setAllDirectoriesExpanded } from './treeExpansion'
import { getEditorThemeType, type EditorTheme } from '../settings/preferences'
import {
  EMPTY_REVIEW_FILE_FILTER,
  isApiFilePath,
  isTestFilePath,
  reviewFileFilterIsActive,
  type ReviewFileFilter
} from '../review/reviewFileFilter'

// ~5 ms of regular expressions per idle slice.
const HIDDEN_COUNT_SLICE = 8_000

function scheduleIdle(callback: () => void): number {
  return typeof window.requestIdleCallback === 'function'
    ? window.requestIdleCallback(callback, { timeout: 1_000 })
    : window.setTimeout(callback, 0)
}

function cancelIdle(handle: number): void {
  if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(handle)
  else window.clearTimeout(handle)
}

interface ExplorerProps {
  filePaths: readonly string[]
  model: FileTreeModel
  theme: EditorTheme
  sidebarVisible: boolean
  onSidebarToggle(): void
  sidebarShortcut: string
  isGit: boolean
  /**
   * Whether the tree lists a review's changed files rather than the whole
   * working tree. On the desk the folder dot is the only sign of which
   * directories hold uncommitted work; in a review every folder holds a change,
   * so the same dot says nothing.
   */
  reviewMode: boolean
  branchName: string | null
  onBranchesOpen(): void
  onRowActivate(path: string): void
  fileFilter?: ReviewFileFilter
  onFileFilterChange?(filter: ReviewFileFilter): void
  /** Every path before the filter ran, so each chip can say what it hides. */
  unfilteredFilePaths: readonly string[]
}

export const Explorer = memo(function Explorer({
  filePaths,
  model,
  theme,
  sidebarVisible,
  onSidebarToggle,
  sidebarShortcut,
  isGit,
  reviewMode,
  branchName,
  onBranchesOpen,
  onRowActivate,
  fileFilter = EMPTY_REVIEW_FILE_FILTER,
  onFileFilterChange,
  unfilteredFilePaths
}: ExplorerProps) {
  const directoryPaths = useMemo(() => getDirectoryPaths(filePaths), [filePaths])
  const unfilteredFileCount = unfilteredFilePaths.length
  const visibleFileCount = filePaths.length
  const themeType = getEditorThemeType(theme)
  // The rows live in a shadow root, but custom properties inherit across it, so
  // the `--trees-*` overrides belong in the stylesheet on the host — see
  // `.project-tree`. Only the colour scheme has to travel inline, because the
  // library reads it per host.
  const treeStyle = useMemo(
    () => ({ height: '100%', colorScheme: themeType }) as React.CSSProperties,
    [themeType]
  )
  // A chip that hides nothing is a control with no effect, so it says how many
  // it would take and goes quiet when that is none. Counting is four regular
  // expressions per path and a repository opens with forty thousand of them, so
  // it runs in idle slices after the tree has painted rather than as one long
  // task in front of it — at 100k paths that task was up to 150 ms on every new
  // file. Until it lands the chips show no number and stay live, which is the
  // honest reading of "not counted yet".
  const [hiddenCounts, setHiddenCounts] = useState<{ tests: number; api: number } | null>(null)
  useEffect(() => {
    let tests = 0
    let api = 0
    let index = 0
    let handle = 0
    const slice = (): void => {
      const end = Math.min(unfilteredFilePaths.length, index + HIDDEN_COUNT_SLICE)
      for (; index < end; index += 1) {
        const path = unfilteredFilePaths[index]!
        if (isTestFilePath(path)) tests += 1
        if (isApiFilePath(path)) api += 1
      }
      if (index < unfilteredFilePaths.length) handle = scheduleIdle(slice)
      else setHiddenCounts({ tests, api })
    }
    handle = scheduleIdle(slice)
    return () => cancelIdle(handle)
  }, [unfilteredFilePaths])

  // Whichever of expand-all and collapse-all matches the tree in front of you is
  // the only one you can press meaningfully, so there is one control and the
  // tree decides which way it goes — including when a folder was opened by hand,
  // which is why this tracks the tree rather than the last press.
  const [allFoldersExpanded, setAllFoldersExpanded] = useState(false)
  // Only directories the model actually holds can answer; a path it has not
  // built a handle for is unknown, not open, and a tree that knows of none is
  // not an expanded tree.
  const readAllExpanded = useCallback(() => {
    let known = 0
    for (const directoryPath of directoryPaths) {
      const item = model.getItem(directoryPath)
      if (item == null || !('isExpanded' in item)) continue
      if (!item.isExpanded()) return false
      known += 1
    }
    return known > 0
  }, [directoryPaths, model])

  // The tree notifies on every selection and scroll as well; only a change in
  // how many rows it shows can mean a folder opened or closed, and reading every
  // folder back on each of those cost ~10 ms at 6k folders while scrolling a review.
  useEffect(() => {
    let visibleCount = -1
    const sync = (): void => {
      const nextVisibleCount = model.getVisibleCount()
      if (nextVisibleCount === visibleCount) return
      visibleCount = nextVisibleCount
      setAllFoldersExpanded(readAllExpanded())
    }
    sync()
    return model.subscribe(sync)
  }, [model, readAllExpanded])

  const toggleAllFolders = useCallback(() => {
    setAllDirectoriesExpanded(model, filePaths, directoryPaths, !readAllExpanded())
  }, [directoryPaths, filePaths, model, readAllExpanded])

  // The tree reports selection *changes*, so clicking the row that is already
  // selected reports nothing. Rows are read straight off the click instead, which
  // makes every click a navigation request.
  const activateClickedRow = useCallback((event: React.MouseEvent<HTMLElement>) => {
    const row = event.nativeEvent.composedPath().find(
      (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute('data-item-path')
    )
    const path = row?.getAttribute('data-item-path')
    if (path == null || row?.getAttribute('data-item-type') !== 'file') return
    onRowActivate(path)
  }, [onRowActivate])

  return (
    <aside className="sidebar" id="repository-explorer">
      <div className="sidebar-heading">
        <div className="sidebar-heading-identity">
          {/* One glyph in both states. A control pressed a hundred times a day
              is found by muscle memory, and a button that redraws itself when it
              is pressed is a button you have to look at. */}
          <button
            className="sidebar-toggle"
            type="button"
            aria-label="Toggle explorer"
            aria-expanded={sidebarVisible}
            aria-controls="repository-explorer"
            title={`${sidebarVisible ? 'Hide' : 'Show'} Explorer (${sidebarShortcut})`}
            onClick={onSidebarToggle}
          >
            <IconSidebarLeft />
          </button>
          {isGit ? (
            <button
              className="chrome-branch-button"
              type="button"
              onClick={onBranchesOpen}
              aria-label={`Switch branch. Current branch: ${branchName ?? 'detached HEAD'}`}
              title="Switch branch"
            >
              <IconBranch />
              <span>{branchName ?? 'Detached HEAD'}</span>
            </button>
          ) : null}
        </div>
        <div className="sidebar-heading-actions">
          <span className="sidebar-file-count">
            {unfilteredFileCount != null && unfilteredFileCount !== visibleFileCount
              ? `${visibleFileCount.toLocaleString()} of ${unfilteredFileCount.toLocaleString()}`
              : `${visibleFileCount.toLocaleString()} files`}
          </span>
          <button
            type="button"
            aria-label={allFoldersExpanded ? 'Collapse all folders' : 'Expand all folders'}
            title={allFoldersExpanded ? 'Collapse all folders' : 'Expand all folders'}
            onClick={toggleAllFolders}
          >
            <span className="icon-swap" data-state={allFoldersExpanded ? 'alt' : 'base'}>
              <IconExpandAll /><IconChevronsClose />
            </span>
          </button>
        </div>
      </div>
      {onFileFilterChange == null ? null : (
        <div className="sidebar-file-filter">
          <input
            type="search"
            name="file-filter"
            value={fileFilter.query}
            placeholder="Filter files, e.g. /api/* or *.test.ts"
            aria-label="Filter files"
            onChange={(event) => onFileFilterChange({ ...fileFilter, query: event.target.value })}
          />
          {/* One line that scrolls, not a block that reflows: a wrapped chip row
              changes the tree's height as you type, which moves the rows you are
              reading. */}
          <div className="filter-chips" role="group" aria-label="Hide file groups">
            <button
              type="button"
              className="filter-chip"
              aria-pressed={fileFilter.hideTests}
              disabled={hiddenCounts?.tests === 0}
              onClick={() => onFileFilterChange({ ...fileFilter, hideTests: !fileFilter.hideTests })}
            >
              Hide tests
              {hiddenCounts == null ? null : <span className="filter-chip-count">{hiddenCounts.tests}</span>}
            </button>
            <button
              type="button"
              className="filter-chip"
              aria-pressed={fileFilter.hideApi}
              disabled={hiddenCounts?.api === 0}
              onClick={() => onFileFilterChange({ ...fileFilter, hideApi: !fileFilter.hideApi })}
            >
              Hide API
              {hiddenCounts == null ? null : <span className="filter-chip-count">{hiddenCounts.api}</span>}
            </button>
            {reviewFileFilterIsActive(fileFilter) ? (
              <button
                type="button"
                className="filter-clear"
                aria-label="Clear filters"
                title="Clear filters"
                onClick={() => onFileFilterChange(EMPTY_REVIEW_FILE_FILTER)}
              >
                <IconX />
              </button>
            ) : null}
          </div>
        </div>
      )}
      <FileTree className="project-tree" data-review-mode={reviewMode ? 'true' : undefined}
        model={model} style={treeStyle} onClick={activateClickedRow} />
    </aside>
  )
})
