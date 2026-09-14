import { useEffect, useState } from 'react'
import { IconBolt, IconCodeSearch, IconFile, IconFolder, IconRefresh, IconX } from '@pierre/icons'

import kodiIcon from '../assets/kodi-icon.png'
import type { RecentFolder } from '../explorer/recentFolders'
import { FolderPicker } from '../explorer/FolderPicker'
import { preloadFolderCatalog } from '../explorer/folderPickerModel'
import { formatKeybinding, type KeybindingMap } from '../settings/keybindings'
import { RemoteAvatar } from '../github/RemoteAvatar'
import { formatCommentAge } from '../github/RemoteReviewThreads'
import {
  readWelcomeInboxCache,
  touchWelcomeInboxCache,
  WELCOME_INBOX_TAG,
  welcomeInboxExpectedRows,
  welcomeInboxIsStale,
  welcomeInboxRepos,
  welcomeInboxRows,
  writeWelcomeInboxCache,
  type WelcomeInboxRow
} from './welcomeInbox'

interface ShortcutHintProps {
  keys: string
  label: string
}

function ShortcutHint({ keys, label }: ShortcutHintProps): React.JSX.Element {
  return <kbd className="shortcut-hint" aria-label={label}>{keys}</kbd>
}

const WELCOME_RECENT_FOLDER_LIMIT = 4

// Uneven bar widths so the placeholder reads as a list of pull requests rather
// than a table. Title first, then the repo line, as fractions of the column.
const PLACEHOLDER_BARS: readonly [number, number][] = [[0.52, 0.78], [0.36, 0.66], [0.64, 0.83], [0.44, 0.71], [0.58, 0.74]]

function InboxPlaceholder({ rows }: { rows: number }): React.JSX.Element {
  return (
    <>
      <span className="sr-only" role="status">Loading pull requests…</span>
      {Array.from({ length: rows }, (_unused, index) => {
        const [title, meta] = PLACEHOLDER_BARS[index % PLACEHOLDER_BARS.length]!
        return (
          <div className="welcome-pr-ghost" key={index} aria-hidden="true">
            <span className="welcome-ghost-avatar" />
            <span className="welcome-ghost-lines">
              <i style={{ width: `${Math.round(title * 100)}%` }} />
              <i style={{ width: `${Math.round(meta * 100)}%` }} />
            </span>
            <span className="welcome-ghost-tag" />
          </div>
        )
      })}
    </>
  )
}

// The staged entrance runs once per app session, not on every return from Settings.
let welcomeEntranceShown = false

interface WelcomeProps {
  opening: boolean
  openingRecentPath: string | null
  recentFolders: readonly RecentFolder[]
  keybindings: KeybindingMap
  /** `owner/name` allow-list for the inbox; empty fetches everything GitHub has. */
  inboxRepos: readonly string[]
  onOpen(): Promise<void>
  onOpenPickedFolder(path: string): void
  onRecentOpen(folder: RecentFolder): Promise<void>
  onRecentRemove(path: string): void
  onOpenPullRequest(url: string): Promise<unknown>
}

/** The parent directory name — enough to tell same-named checkouts apart. */
function recentFolderHint(path: string, name: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const parent = trimmed.slice(0, trimmed.length - name.length).replace(/\/+$/, '')
  const segments = parent.split('/').filter((segment) => segment !== '')
  return segments.at(-1) ?? path
}

export function Welcome({
  onOpen,
  onOpenPickedFolder,
  opening,
  openingRecentPath,
  recentFolders,
  keybindings,
  inboxRepos,
  onRecentOpen,
  onRecentRemove,
  onOpenPullRequest
}: WelcomeProps): React.JSX.Element {
  const [animateEntrance] = useState(() => !welcomeEntranceShown)
  const [pickerOpen, setPickerOpen] = useState(false)
  const inboxScope = inboxRepos.join(' ')
  const [inboxRows, setInboxRows] = useState<WelcomeInboxRow[]>(() => readWelcomeInboxCache(inboxScope))
  const [inboxLoading, setInboxLoading] = useState(() => welcomeInboxIsStale(inboxScope))
  const [openingPullRequestUrl, setOpeningPullRequestUrl] = useState<string | null>(null)

  useEffect(() => {
    welcomeEntranceShown = true
  }, [])

  useEffect(() => {
    const repository = window.repository
    if (repository == null || !welcomeInboxIsStale(inboxScope)) {
      setInboxLoading(false)
      return
    }
    setInboxLoading(true)
    let cancelled = false
    // Derived from the scope rather than the prop so a new array identity on an
    // unrelated re-render cannot restart the fetch.
    const repos = inboxScope === '' ? [] : inboxScope.split(' ')
    void repository.getGlobalPullRequestInbox(repos).then((snapshot) => {
      if (cancelled) return
      if (snapshot.available) {
        const rows = welcomeInboxRows(snapshot)
        writeWelcomeInboxCache(rows, welcomeInboxRepos(snapshot), inboxScope)
        setInboxRows(rows)
      } else {
        touchWelcomeInboxCache(inboxScope)
      }
      setInboxLoading(false)
    }, () => {
      if (cancelled) return
      touchWelcomeInboxCache(inboxScope)
      setInboxLoading(false)
    })
    return () => { cancelled = true }
  }, [inboxScope])

  // Placeholders only stand in for rows nobody has seen yet: a cached inbox
  // paints its real rows immediately and revalidates underneath.
  const ghostRows = inboxLoading && inboxRows.length === 0 ? welcomeInboxExpectedRows() : 0

  const openPullRequest = (row: WelcomeInboxRow): void => {
    if (openingPullRequestUrl != null) return
    setOpeningPullRequestUrl(row.url)
    void Promise.resolve(onOpenPullRequest(row.url)).finally(() => setOpeningPullRequestUrl(null))
  }

  const shownFolders = recentFolders.slice(0, WELCOME_RECENT_FOLDER_LIMIT)
  return (
    <section className="welcome" data-entrance={animateEntrance ? 'run' : 'off'}>
      <div className="welcome-layout">
        <header className="welcome-intro">
          <div className="welcome-identity"><img className="welcome-app-icon" src={kodiIcon} alt="" /><span>Kodi</span></div>
          <h1>Your project tree,<br />built for review.</h1>
          <p className="welcome-copy">
            Open a folder or a pull request — read any file, or compare a working copy with HEAD.
          </p>
          <div className="folder-picker-host welcome-open-host">
            <button
              className="welcome-open"
              type="button"
              onClick={() => setPickerOpen((open) => !open)}
              onMouseEnter={preloadFolderCatalog}
              onFocus={preloadFolderCatalog}
              disabled={opening}
              aria-expanded={pickerOpen}
              aria-haspopup="dialog"
            >
              {opening ? <IconRefresh className="spin" /> : <IconFolder />}
              Open Folder
            </button>
            {pickerOpen ? (
              <FolderPicker
                recentFolders={recentFolders}
                openingPath={openingRecentPath}
                onClose={() => setPickerOpen(false)}
                onSelect={(path) => {
                  setPickerOpen(false)
                  onOpenPickedFolder(path)
                }}
                onUseExisting={() => {
                  setPickerOpen(false)
                  void onOpen()
                }}
              />
            ) : null}
          </div>
          <div className="welcome-keys" role="group" aria-label="Keyboard shortcuts">
            <div className="welcome-key"><IconFolder /><span>Open folder</span><ShortcutHint keys={formatKeybinding(keybindings.openFolder)} label="Open folder shortcut" /></div>
            <div className="welcome-key"><IconBolt /><span>Command palette</span><ShortcutHint keys={formatKeybinding(keybindings.openCommandPalette)} label="Command palette shortcut" /></div>
            <div className="welcome-key"><IconFile /><span>Go to file</span><ShortcutHint keys={formatKeybinding(keybindings.goToFile)} label="Go to file shortcut" /></div>
            <div className="welcome-key"><IconCodeSearch /><span>Search contents</span><ShortcutHint keys={formatKeybinding(keybindings.searchContent)} label="Search contents shortcut" /></div>
          </div>
        </header>

        <div className="welcome-activity">
          {inboxRows.length > 0 || ghostRows > 0 ? (
            <section className="welcome-group welcome-inbox" aria-labelledby="welcome-inbox-title">
              <div className="welcome-group-heading">
                <strong id="welcome-inbox-title">Pull requests</strong>
                <span>{ghostRows > 0 ? '' : inboxRows.length}</span>
              </div>
              <div className="welcome-group-list" aria-busy={ghostRows > 0}>
                {ghostRows > 0 ? <InboxPlaceholder rows={ghostRows} /> : null}
                {inboxRows.map((row) => (
                  <button
                    className="welcome-pr"
                    key={row.url}
                    type="button"
                    title={row.url}
                    disabled={openingPullRequestUrl != null}
                    onClick={() => openPullRequest(row)}
                  >
                    <RemoteAvatar url={row.authorAvatarUrl} login={row.authorLogin} />
                    <span className="welcome-pr-main">
                      <strong>{row.title}</strong>
                      <small>{row.repo === '' ? '' : `${row.repo} `}#{row.number} · {formatCommentAge(row.updatedAt, Date.now())}{row.isDraft ? ' · draft' : ''}</small>
                    </span>
                    {openingPullRequestUrl === row.url
                      ? <IconRefresh className="spin welcome-pr-spinner" />
                      : <span className="welcome-pr-tag" data-tone={row.key}>{WELCOME_INBOX_TAG[row.key]}</span>}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <section className="welcome-group recent-folders" aria-labelledby="recent-folders-title">
            <div className="welcome-group-heading">
              <strong id="recent-folders-title">Recent folders</strong>
              {shownFolders.length > 0 ? <span>{shownFolders.length}</span> : null}
            </div>
            {shownFolders.length > 0 ? (
              <div className="welcome-group-list">
                {shownFolders.map((folder) => (
                  <div className="recent-folder" key={folder.path}>
                    <button className="recent-folder-open" type="button" title={folder.path} onClick={() => void onRecentOpen(folder)} disabled={openingRecentPath != null}>
                      {openingRecentPath === folder.path ? <IconRefresh className="spin" /> : <IconFolder />}
                      <span><strong>{folder.name}</strong><small>{recentFolderHint(folder.path, folder.name)}</small></span>
                    </button>
                    <button className="recent-folder-remove" type="button" onClick={() => onRecentRemove(folder.path)} aria-label={`Remove ${folder.name} from recent folders`} title="Remove from recent folders">
                      <IconX />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="recent-folders-empty">
                <IconFolder />
                <div><strong>No recent folders</strong><span>Folders you open will appear here.</span></div>
              </div>
            )}
          </section>
        </div>
      </div>
      <footer className="welcome-footer"><span>Git is optional</span><span>Local files only</span></footer>
    </section>
  )
}
