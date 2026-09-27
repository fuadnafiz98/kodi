import { lazy, memo, Suspense } from 'react'
import { IconBranch, IconGear, IconSearch, IconTerminal } from '@pierre/icons'

import type { RepositorySnapshot } from '../../../shared/contracts'
import type { RecentFolder } from '../explorer/recentFolders'
import { ReviewLocator } from '../review/ReviewLocator'
import { IconSparklesOutline } from './IconSparklesOutline'
import { formatKeybinding, formatTerminalToggleShortcut, type KeybindingMap } from '../settings/keybindings'

// The HUD samples the main process and draws a chart; nothing about it is worth
// a byte of the chunk that runs before the first paint.
const PerformanceHud = lazy(async () => ({
  default: (await import('../perf/PerformanceHud')).PerformanceHud
}))

const NOOP = (): void => {}
// A fresh `[]` default would be a new identity on every render, which defeats the
// `memo` around Titlebar for every caller that omits the prop.
const NO_RECENT_FOLDERS: readonly RecentFolder[] = []

interface TitlebarProps {
  snapshot: RepositorySnapshot | null
  keybindings: KeybindingMap
  newTab: boolean
  locator: string
  locatorBusy: boolean
  reviewFolderName?: string | null
  reviewFolderPath?: string | null
  recentFolders?: readonly RecentFolder[]
  onReviewFolderSelect?(path: string): void
  onReviewFolderChooseExisting?(): void
  onLocatorChange(locator: string): void
  onLocatorSubmit(): void
  onSearchOpen(): void
  onSettingsOpen(): void
  agentOpen: boolean
  onAgentToggle(): void
  terminalOpen: boolean
  onTerminalToggle(): void
  onSourceControlOpen?(): void
  onSourceControlPreload?(): void
}

export const Titlebar = memo(function Titlebar({
  snapshot,
  keybindings,
  newTab,
  locator,
  locatorBusy,
  reviewFolderName = null,
  reviewFolderPath = null,
  recentFolders = NO_RECENT_FOLDERS,
  onReviewFolderSelect = NOOP,
  onReviewFolderChooseExisting = NOOP,
  onLocatorChange,
  onLocatorSubmit,
  onSearchOpen,
  onSettingsOpen,
  agentOpen,
  onAgentToggle,
  terminalOpen,
  onTerminalToggle,
  onSourceControlOpen,
  onSourceControlPreload = NOOP
}: TitlebarProps): React.JSX.Element {
  return (
    <div className="titlebar">
      <div className="titlebar-find">
        {newTab ? (
          <ReviewLocator
            locator={locator}
            busy={locatorBusy}
            folderName={reviewFolderName}
            folderPath={reviewFolderPath}
            recentFolders={recentFolders}
            onChange={onLocatorChange}
            onSubmit={onLocatorSubmit}
            onFolderSelect={onReviewFolderSelect}
            onFolderChooseExisting={onReviewFolderChooseExisting}
          />
        ) : null}
      </div>

      <div className="titlebar-trailing">
        {snapshot != null ? (
          <div className="titlebar-status">
            <Suspense fallback={null}>
              <PerformanceHud />
            </Suspense>
          </div>
        ) : null}
        <div className="titlebar-actions">
          <div className="titlebar-action-cluster">
            {newTab ? null : (
              <button
                className="icon-button"
                type="button"
                onClick={onSearchOpen}
                aria-label="Search files and commands"
                title={`Search files and commands (${formatKeybinding(keybindings.goToFile)})`}
              >
                <IconSearch />
              </button>
            )}
            {snapshot?.kind === 'git' && onSourceControlOpen != null ? (
              <button
                className="icon-button source-control-titlebar-button"
                type="button"
                onClick={onSourceControlOpen}
                onPointerEnter={onSourceControlPreload}
                onFocus={onSourceControlPreload}
                aria-label={snapshot.statuses.length === 0
                  ? 'Source control'
                  : `Source control, ${snapshot.statuses.length} changed ${snapshot.statuses.length === 1 ? 'file' : 'files'}`}
                title="Source Control"
              >
                <IconBranch />
                {snapshot.statuses.length === 0 ? null : (
                  <span className="source-control-badge" aria-hidden="true">
                    {snapshot.statuses.length > 99 ? '99+' : snapshot.statuses.length}
                  </span>
                )}
              </button>
            ) : null}
            <button className="icon-button" type="button" onClick={onSettingsOpen} aria-label="Open settings" title="Settings">
              <IconGear />
            </button>
            {snapshot != null ? (
              <>
                <button
                  className={`icon-button terminal-titlebar-button ${terminalOpen ? 'active' : ''}`}
                  type="button"
                  aria-label={terminalOpen ? 'Hide terminal' : 'Show terminal'}
                  aria-pressed={terminalOpen}
                  title={`Toggle Terminal (${formatTerminalToggleShortcut()})`}
                  onClick={onTerminalToggle}
                >
                  <IconTerminal />
                </button>
                <button
                  className={`icon-button agent-titlebar-button ${agentOpen ? 'active' : ''}`}
                  type="button"
                  aria-label={agentOpen ? 'Close agent' : 'Ask agent'}
                  aria-pressed={agentOpen}
                  title={agentOpen ? 'Close Agent' : 'Ask Agent'}
                  onClick={onAgentToggle}
                >
                  <IconSparklesOutline />
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
})
