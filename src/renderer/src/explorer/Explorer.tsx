import { memo, useCallback, useMemo } from 'react'
import type { FileTree as FileTreeModel } from '@pierre/trees'
import { FileTree, useFileTreeSearch } from '@pierre/trees/react'
import {
  IconBranch,
  IconChevronsClose,
  IconExpandAll,
  IconSearch,
  IconSidebarLeft,
  IconSidebarLeftOpen,
  IconX
} from '@pierre/icons'

import { getDirectoryPaths } from './treeExpansion'
import { getEditorThemeType, type EditorTheme } from '../settings/preferences'
import {
  EMPTY_REVIEW_FILE_FILTER,
  reviewFileFilterIsActive,
  type ReviewFileFilter
} from '../review/reviewFileFilter'
import { treeStylesFor } from '../settings/themePalette'

interface ExplorerProps {
  filePaths: readonly string[]
  model: FileTreeModel
  theme: EditorTheme
  sidebarVisible: boolean
  onSidebarToggle(): void
  sidebarShortcut: string
  isGit: boolean
  branchName: string | null
  onBranchesOpen(): void
  onRowActivate(path: string): void
  fileFilter?: ReviewFileFilter
  onFileFilterChange?(filter: ReviewFileFilter): void
  unfilteredFileCount?: number
}

export const Explorer = memo(function Explorer({
  filePaths,
  model,
  theme,
  sidebarVisible,
  onSidebarToggle,
  sidebarShortcut,
  isGit,
  branchName,
  onBranchesOpen,
  onRowActivate,
  fileFilter = EMPTY_REVIEW_FILE_FILTER,
  onFileFilterChange,
  unfilteredFileCount
}: ExplorerProps) {
  const search = useFileTreeSearch(model)
  const directoryPaths = useMemo(() => getDirectoryPaths(filePaths), [filePaths])
  const visibleFileCount = search.value.length > 0 ? search.matchingPaths.length : filePaths.length
  const themeType = getEditorThemeType(theme)
  const themeStyles = treeStylesFor(theme)
  const treeStyle = useMemo(() => ({
    ...themeStyles,
    height: '100%',
    colorScheme: themeType,
    // TREE_STYLES only reaches [data-type="item"], so the library's sticky row
    // and context-menu trigger keep their 6px unless the variable is overridden.
    '--trees-border-radius-override': 'var(--corner-compact)'
  }) as React.CSSProperties, [themeStyles, themeType])

  const expandAll = useCallback(() => {
    for (const directoryPath of directoryPaths) {
      const item = model.getItem(directoryPath)
      if (item != null && 'expand' in item) item.expand()
    }
  }, [directoryPaths, model])

  const collapseAll = useCallback(() => {
    for (const directoryPath of [...directoryPaths].reverse()) {
      const item = model.getItem(directoryPath)
      if (item != null && 'collapse' in item) item.collapse()
    }
  }, [directoryPaths, model])

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
          <button
            type="button"
            aria-label={sidebarVisible ? 'Hide explorer' : 'Show explorer'}
            title={`${sidebarVisible ? 'Hide' : 'Show'} Explorer (${sidebarShortcut})`}
            onClick={onSidebarToggle}
          >
            <span className="icon-swap sidebar-icon-swap" data-state={sidebarVisible ? 'base' : 'alt'}>
              <IconSidebarLeft /><IconSidebarLeftOpen />
            </span>
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
          <button type="button" aria-label="Expand all folders" title="Expand all folders" onClick={expandAll}>
            <IconExpandAll />
          </button>
          <button type="button" aria-label="Collapse all folders" title="Collapse all folders" onClick={collapseAll}>
            <IconChevronsClose />
          </button>
          <button
            type="button"
            aria-label={search.isOpen ? 'Close file search' : 'Search files in explorer'}
            aria-pressed={search.isOpen}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => search.isOpen ? search.close() : search.open()}
          >
            {search.isOpen ? <IconX /> : <IconSearch />}
          </button>
        </div>
      </div>
      {onFileFilterChange == null ? null : (
        <div className="sidebar-file-filter">
          {/* No magnifier here: the heading's search button already carries one,
              and two of them a row apart read as two different searches. */}
          <div className="sidebar-file-filter-field">
            <input
              type="search"
              name="file-filter"
              value={fileFilter.query}
              placeholder="Filter files"
              aria-label="Filter files, for example /api/* or *.test.ts"
              onChange={(event) => onFileFilterChange({ ...fileFilter, query: event.target.value })}
            />
          </div>
          <div className="sidebar-file-filter-chips" role="group" aria-label="Hide file groups">
            <button
              type="button"
              aria-pressed={fileFilter.hideTests}
              onClick={() => onFileFilterChange({ ...fileFilter, hideTests: !fileFilter.hideTests })}
            >
              Hide tests
            </button>
            <button
              type="button"
              aria-pressed={fileFilter.hideApi}
              onClick={() => onFileFilterChange({ ...fileFilter, hideApi: !fileFilter.hideApi })}
            >
              Hide API
            </button>
            <button
              type="button"
              aria-pressed={fileFilter.query.trim() === '/api/*'}
              onClick={() => onFileFilterChange({
                ...fileFilter,
                query: fileFilter.query.trim() === '/api/*' ? '' : '/api/*'
              })}
            >
              /api/*
            </button>
            {reviewFileFilterIsActive(fileFilter) ? (
              <button
                type="button"
                className="sidebar-file-filter-clear"
                onClick={() => onFileFilterChange(EMPTY_REVIEW_FILE_FILTER)}
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      )}
      <FileTree className="project-tree" model={model} style={treeStyle} onClick={activateClickedRow} />
    </aside>
  )
})
