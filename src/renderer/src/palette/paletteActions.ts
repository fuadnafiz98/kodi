import { useMemo } from 'react'
import {
  IconBranch,
  IconCollapsedRow,
  IconFileCode,
  IconFolder,
  IconGear,
  IconSearch,
  IconSidebar,
  IconSparkles,
  IconTerminalFill,
  IconTypeWord
} from '@pierre/icons'

import type { ContentSearchResult } from '../../../shared/contracts'
import type { RankedPath } from './fileSearch'
import {
  KEYBINDING_COMMANDS,
  formatKeybinding,
  formatTerminalToggleShortcut,
  type AppCommand,
  type KeybindingMap
} from '../settings/keybindings'
import { requestReveal } from '../app/revealLocation'
import { fileNameFromPath } from './paletteQuery'
import { rankPaletteEntries, type PaletteEntry } from './paletteCommands'

const MAX_RESULTS = 30
const MAX_SEARCH_FILES = 12
const MAX_CONTENT_RESULTS = 8
const MAX_BRANCH_RESULTS = 5
// With no query the palette is a directory of the project, so the file list gets
// the room and the commands collapse to a hint that `>` opens all of them.
const MAX_EMPTY_QUERY_FILES = 30
const COLLAPSED_COMMAND_ROWS = 3

const COMMAND_ICONS: Record<AppCommand, React.ComponentType> = {
  openFolder: IconFolder,
  openCommandPalette: IconSearch,
  goToFile: IconSearch,
  searchContent: IconSearch,
  toggleSidebar: IconSidebar,
  toggleWordWrap: IconTypeWord,
  toggleFoldUnchanged: IconCollapsedRow,
  toggleTerminal: IconTerminalFill,
  openSettings: IconGear,
  toggleReviewGuide: IconSparkles,
  openInEditor: IconFileCode
}

const PROJECT_COMMANDS = new Set<AppCommand>([
  'toggleSidebar',
  'toggleWordWrap',
  'toggleFoldUnchanged',
  'toggleTerminal',
  'toggleReviewGuide',
  'openInEditor'
])

const PALETTE_ONLY_COMMANDS = new Set<AppCommand>([
  'openCommandPalette',
  'goToFile',
  'searchContent'
])

export interface PaletteAction extends PaletteEntry {
  icon: React.ComponentType
  preview?: string
  previewPath?: string
  run(): void
}

export interface PaletteActionsOptions {
  /** The query with any `>` marker stripped — what the ranker matches on. */
  filterQuery: string
  commandOnly: boolean
  /** A PR selector takes the whole panel, so no rows are built for it. */
  hasPullRequestSelector: boolean
  fileResults: readonly RankedPath[]
  /** The line the query names (`src/app.ts:42`, or `:42` alone for the open file). */
  line: number | null
  /** The file in front, which a bare `:42` goes to. */
  currentPath?: string | null
  contentResults: readonly ContentSearchResult[]
  branches?: readonly string[]
  keybindings: KeybindingMap
  gitRepositoryOpen: boolean
  projectOpen: boolean
  onClose(): void
  onOpenRepository(): void
  onOpenSettings(): void
  onToggleTerminal(): void
  onRunCommand?(command: AppCommand): void
  onOpenFile?(path: string): void
  onSwitchBranch?(branch: string): void
  onDrillIntoDirectory(path: string): void
  onShowAllCommands(): void
}

/**
 * The rows the palette shows, built once per result set so the render allocates
 * no closures per row.
 */
export function usePaletteActions({
  filterQuery,
  commandOnly,
  hasPullRequestSelector,
  fileResults,
  line,
  currentPath,
  contentResults,
  branches,
  keybindings,
  gitRepositoryOpen,
  projectOpen,
  onClose,
  onOpenRepository,
  onOpenSettings,
  onToggleTerminal,
  onRunCommand,
  onOpenFile,
  onSwitchBranch,
  onDrillIntoDirectory,
  onShowAllCommands
}: PaletteActionsOptions): readonly PaletteAction[] {
  const moreCommandsAction = useMemo<PaletteAction>(() => ({
    id: 'commands-more',
    group: 'Commands',
    title: 'More commands…',
    subtitle: 'List every command',
    keybinding: '>',
    icon: IconSearch,
    run: onShowAllCommands
  }), [onShowAllCommands])

  const commandActions = useMemo<PaletteAction[]>(() => {
    const runAndClose = (run: () => void) => () => {
      onClose()
      run()
    }
    const entries: PaletteAction[] = [{
      id: 'open-repository',
      group: 'Commands',
      title: 'Open repository',
      subtitle: 'Branches, commits, remotes, and pull requests',
      icon: IconBranch,
      disabledReason: gitRepositoryOpen ? undefined : 'Open a Git repository first',
      run: runAndClose(onOpenRepository)
    }]

    for (const { command, label, description } of KEYBINDING_COMMANDS) {
      if (PALETTE_ONLY_COMMANDS.has(command)) continue
      const dedicated = command === 'openSettings'
        ? onOpenSettings
        : command === 'toggleTerminal' ? onToggleTerminal : null
      const run = dedicated ?? (onRunCommand == null ? null : () => onRunCommand(command))
      if (run == null) continue
      entries.push({
        id: `command:${command}`,
        group: 'Commands',
        title: label,
        subtitle: description,
        keybinding: command === 'toggleTerminal'
          ? formatTerminalToggleShortcut()
          : formatKeybinding(keybindings[command]),
        icon: COMMAND_ICONS[command],
        disabledReason: PROJECT_COMMANDS.has(command) && !projectOpen ? 'Open a project first' : undefined,
        run: runAndClose(run)
      })
    }

    if (onSwitchBranch != null) {
      for (const branch of (branches ?? []).slice(0, MAX_BRANCH_RESULTS)) {
        entries.push({
          id: `branch:${branch}`,
          group: 'Branches',
          title: branch,
          subtitle: 'Switch to this branch',
          icon: IconBranch,
          run: runAndClose(() => onSwitchBranch(branch))
        })
      }
    }

    return entries
  }, [
    branches, gitRepositoryOpen, keybindings, onClose, onOpenRepository, onOpenSettings,
    onRunCommand, onSwitchBranch, onToggleTerminal, projectOpen
  ])

  const fileActions = useMemo<PaletteAction[]>(() => {
    if (onOpenFile == null) return []
    return fileResults.map((result) => ({
      id: `${result.kind}:${result.path}`,
      group: 'Files' as const,
      title: fileNameFromPath(result.path),
      subtitle: line == null || result.kind === 'dir' ? result.path : `${result.path}:${line}`,
      icon: result.kind === 'dir' ? IconFolder : IconFileCode,
      // A folder is a place to look, not a thing to open: selecting one narrows
      // the query to its contents and leaves the palette up.
      run: result.kind === 'dir'
        ? () => onDrillIntoDirectory(result.path)
        : () => {
            onClose()
            openFileAt(onOpenFile, result.path, line)
          }
    }))
  }, [fileResults, line, onClose, onDrillIntoDirectory, onOpenFile])

  const goToLineAction = useMemo<PaletteAction | null>(() => {
    if (onOpenFile == null || line == null || currentPath == null) return null
    return {
      id: `line:${currentPath}:${line}`,
      group: 'Files' as const,
      title: `Go to line ${line}`,
      subtitle: currentPath,
      icon: IconFileCode,
      run: () => {
        onClose()
        openFileAt(onOpenFile, currentPath, line)
      }
    }
  }, [currentPath, line, onClose, onOpenFile])

  const contentActions = useMemo<PaletteAction[]>(() => {
    if (onOpenFile == null) return []
    return contentResults.slice(0, MAX_CONTENT_RESULTS).map((result, index) => ({
      id: `content:${result.path}:${result.line}:${result.column}:${index}`,
      group: 'Content' as const,
      title: fileNameFromPath(result.path),
      subtitle: `${result.path}:${result.line}:${result.column}`,
      icon: IconFileCode,
      preview: result.preview,
      previewPath: result.path,
      run: () => {
        onClose()
        openFileAt(onOpenFile, result.path, result.line)
      }
    }))
  }, [contentResults, onClose, onOpenFile])

  return useMemo<PaletteAction[]>(() => {
    if (hasPullRequestSelector) return []
    if (commandOnly) {
      return rankPaletteEntries(commandActions, filterQuery, MAX_RESULTS) as PaletteAction[]
    }
    // `:42` on its own: the open file, at that line.
    if (goToLineAction != null && filterQuery.trim().startsWith(':')) return [goToLineAction]
    if (filterQuery.trim() === '') {
      return [
        ...fileActions.slice(0, MAX_EMPTY_QUERY_FILES),
        ...commandActions.slice(0, COLLAPSED_COMMAND_ROWS),
        moreCommandsAction
      ]
    }
    const matched = rankPaletteEntries(commandActions, filterQuery, MAX_RESULTS) as PaletteAction[]
    return [...fileActions.slice(0, MAX_SEARCH_FILES), ...contentActions, ...matched].slice(0, MAX_RESULTS)
  }, [
    commandActions, commandOnly, contentActions, fileActions, filterQuery, goToLineAction,
    hasPullRequestSelector, moreCommandsAction
  ])
}

/** Opens a file, landing on `line` when the reader named one. */
export function openFileAt(onOpenFile: (path: string) => void, path: string, line: number | null): void {
  if (line != null) requestReveal({ path, line })
  onOpenFile(path)
}
