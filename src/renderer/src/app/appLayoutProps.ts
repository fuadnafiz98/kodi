import type { FileComparison, RepositoryChangeEvent, RepositorySnapshot } from '../../../shared/contracts'
import type { DiffStyle, WorkspaceView } from './AppView'
import type { CommandPaletteHandle } from '../palette/CommandPaletteHost'
import type { ConfirmRequest } from './ConfirmDialog'
import type { AppCommand } from '../settings/keybindings'
import type { AppPreferences } from '../settings/preferences'
import type { RecentFolder } from '../explorer/recentFolders'
import type { TerminalDockHandle } from '../terminal/TerminalDock'
import type { useGitWorkflow } from '../git/useGitWorkflow'
import type { getLoadedWorkspaceRoot } from './workspaceBoot'

// Everything the app shell hands down. Its own module so the chrome and the
// workspace stage can be their own components without importing App.tsx.
export interface AppLayoutProps {
  WorkspaceRoot: ReturnType<typeof getLoadedWorkspaceRoot>
  snapshot: RepositorySnapshot | null
  selectedPath: string | null
  comparison: FileComparison | null
  repositoryChange: RepositoryChangeEvent | null
  opening: boolean
  openingRecentPath: string | null
  loadingDiff: boolean
  error: string | null
  sidebarVisible: boolean
  diffStyle: DiffStyle
  workspaceView: WorkspaceView
  terminalOpen: boolean
  terminalMounted: boolean
  terminalHeight: number
  terminalResizing: boolean
  preferences: AppPreferences
  settingsOpen: boolean
  recentFolders: RecentFolder[]
  commandPaletteRef: React.RefObject<CommandPaletteHandle | null>
  terminalDockRef: React.RefObject<TerminalDockHandle | null>
  gitWorkflow: ReturnType<typeof useGitWorkflow>
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>
  setError: React.Dispatch<React.SetStateAction<string | null>>
  setRecentFolders: React.Dispatch<React.SetStateAction<RecentFolder[]>>
  setPreferences: React.Dispatch<React.SetStateAction<AppPreferences>>
  selectPath(path: string | null): void
  onComparisonSaved(comparison: FileComparison): void
  setDiffStyle: React.Dispatch<React.SetStateAction<DiffStyle>>
  setWorkspaceView(view: WorkspaceView): void
  setTerminalHeight: React.Dispatch<React.SetStateAction<number>>
  setTerminalResizing: React.Dispatch<React.SetStateAction<boolean>>
  toggleSidebar(): void
  toggleTerminal(): void
  closeTerminal(): void
  commitTerminalHeight(height: number): void
  openFolder(): Promise<void>
  openFolderFromPicker(path: string): Promise<void>
  openRecentFolder(folder: RecentFolder): Promise<void>
  folderPickerOpen: boolean
  openFolderPicker(): void
  closeFolderPicker(): boolean
  toggleFolderPicker(): void
  openPullRequestFromPalette(selector: number | string): void
  openCommandPalette(): void
  openSettings(): void
  runCommand(command: AppCommand): void
  recentFiles: readonly string[]
  restorePending: boolean
  restoreRoot: string | null
  confirmRequest: ConfirmRequest | null
  confirm(request: ConfirmRequest): Promise<boolean>
  resolveConfirm(confirmed: boolean): void
}

/** The shell minus the two refs App keeps out of the object it spreads. */
export type WorkspaceLayoutProps = Omit<AppLayoutProps, 'commandPaletteRef' | 'terminalDockRef'>
