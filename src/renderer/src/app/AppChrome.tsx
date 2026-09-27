import type { WorkspaceLayoutProps } from './appLayoutProps'
import { FolderChromeButton } from '../explorer/FolderPicker'
import { formatKeybinding } from '../settings/keybindings'
import { Titlebar } from './Titlebar'
import type { NewWorld } from '../review/useReviewWorlds'
import { WorldStrip } from './WorldStrip'
import { preloadRepositoryPanel } from '../git/repositoryPanelChunk'

export interface AppChromeProps {
  view: WorkspaceLayoutProps
  /** Non-null on a blank tab, where the titlebar becomes a pull request locator. */
  activeNewWorld: NewWorld | null
  agentOpen: boolean
  onAgentToggle(): void
}

/** The window chrome: the world tabs and the titlebar under them. */
export function AppChrome({
  view,
  activeNewWorld,
  agentOpen,
  onAgentToggle
}: AppChromeProps): React.JSX.Element {
  const { gitWorkflow } = view
  return (
    <header className="app-chrome">
    <WorldStrip
      worlds={gitWorkflow.worlds}
      activeWorldId={gitWorkflow.activeWorld?.worldId ?? null}
      leadingAction={(
        <FolderChromeButton
          opening={view.opening}
          open={view.folderPickerOpen}
          shortcut={formatKeybinding(view.preferences.keybindings.openFolder)}
          recentFolders={view.recentFolders}
          openingPath={view.openingRecentPath}
          onToggle={view.toggleFolderPicker}
          onClose={() => { view.closeFolderPicker() }}
          onSelect={(path) => { void view.openFolderFromPicker(path) }}
          onUseExisting={() => {
            view.closeFolderPicker()
            void view.openFolder()
          }}
        />
      )}
      onFocus={gitWorkflow.focusWorld}
      onClose={gitWorkflow.closeReview}
      onNew={gitWorkflow.openNewWorld}
    />

    <Titlebar snapshot={activeNewWorld == null ? view.snapshot : null}
      newTab={activeNewWorld != null}
      locator={activeNewWorld?.locator ?? ''}
      locatorBusy={gitWorkflow.actionKey === 'resolve:pull-request'}
      reviewFolderName={gitWorkflow.reviewFolderName}
      reviewFolderPath={gitWorkflow.reviewFolderPath}
      recentFolders={view.recentFolders}
      onReviewFolderSelect={gitWorkflow.updateNewWorldRepositoryRoot}
      onReviewFolderChooseExisting={gitWorkflow.chooseReviewFolder}
      keybindings={view.preferences.keybindings}
      onSearchOpen={view.openCommandPalette}
      onLocatorChange={gitWorkflow.updateNewWorldLocator}
      onLocatorSubmit={() => {
        const locator = activeNewWorld?.locator.trim() ?? ''
        if (locator === '') return
        void gitWorkflow.openPullRequestFromLocator(locator)
      }}
      onSettingsOpen={view.openSettings}
      agentOpen={agentOpen} onAgentToggle={onAgentToggle}
      terminalOpen={view.terminalOpen} onTerminalToggle={view.toggleTerminal}
      onSourceControlOpen={gitWorkflow.openSourceControl}
      onSourceControlPreload={preloadRepositoryPanel} />
    </header>
  )
}
