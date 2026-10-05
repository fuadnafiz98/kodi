import { useEffect, useRef, useState } from 'react'
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
  readWelcomeInboxSyncedAt,
  touchWelcomeInboxCache,
  WELCOME_INBOX_POLL_MS,
  WELCOME_INBOX_TAG,
  WELCOME_INBOX_WAKE_MS,
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

/** Past the first minute the label steps in whole minutes; before it, in tens of seconds. */
export function formatInboxFreshness(syncedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - syncedAt) / 1000))
  if (seconds < 10) return 'Updated just now'
  if (seconds < 60) return `Updated ${Math.floor(seconds / 10) * 10}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `Updated ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Updated ${hours}h ago`
  return `Updated ${Math.floor(hours / 24)}d ago`
}

const FRESHNESS_TICK_MS = 5_000

/** Owns its clock, so the ticking label re-renders itself rather than the Welcome tree. */
function InboxFreshness({ syncedAt, refreshing }: { syncedAt: number | null; refreshing: boolean }): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    const tick = window.setInterval(() => setNow(Date.now()), FRESHNESS_TICK_MS)
    return () => window.clearInterval(tick)
  }, [syncedAt])
  const label = refreshing ? 'Updating…' : syncedAt == null ? null : formatInboxFreshness(syncedAt, now)
  if (label == null) return null
  return (
    // Keyed on the phase so each swap fades in instead of the text jumping.
    <span
      className="welcome-inbox-freshness"
      key={refreshing ? 'updating' : 'updated'}
      title={syncedAt == null ? undefined : `Last updated at ${new Date(syncedAt).toLocaleTimeString()}`}
    >
      {label}
    </span>
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
  const [openingPullRequestUrl, setOpeningPullRequestUrl] = useState<string | null>(null)

  useEffect(() => {
    welcomeEntranceShown = true
  }, [])

  const {
    inboxRows,
    inboxLoading,
    inboxRefreshing,
    inboxSyncedAt,
    refreshSpinning,
    setRefreshSpinning,
    freshInboxUrls,
    refreshInbox
  } = useWelcomeInbox(inboxRepos.join(' '))

  // Placeholders only stand in for rows nobody has seen yet: a cached inbox
  // paints its real rows immediately and revalidates underneath.
  const ghostRows = inboxLoading && inboxRows.length === 0 ? welcomeInboxExpectedRows() : 0

  const openPullRequest = (row: WelcomeInboxRow): void => {
    if (openingPullRequestUrl != null) return
    setOpeningPullRequestUrl(row.url)
    void Promise.resolve(onOpenPullRequest(row.url)).finally(() => setOpeningPullRequestUrl(null))
  }

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
                <span className="welcome-inbox-status">
                  <InboxFreshness syncedAt={inboxSyncedAt} refreshing={inboxRefreshing} />
                  <button
                    className="welcome-inbox-refresh"
                    type="button"
                    onClick={() => refreshInbox.current?.()}
                    data-spinning={refreshSpinning ? 'true' : undefined}
                    onAnimationIteration={() => { if (!inboxRefreshing) setRefreshSpinning(false) }}
                    aria-busy={inboxRefreshing}
                    aria-label="Refresh pull requests"
                    title="Refresh pull requests"
                  >
                    <IconRefresh className={refreshSpinning ? 'spin' : undefined} />
                  </button>
                </span>
              </div>
              <div className="welcome-group-list" aria-busy={ghostRows > 0}>
                {ghostRows > 0 ? <InboxPlaceholder rows={ghostRows} /> : null}
                {inboxRows.map((row) => (
                  <button
                    className="welcome-pr"
                    key={row.url}
                    data-fresh={freshInboxUrls.has(row.url) ? 'true' : undefined}
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

          <RecentFoldersSection
            recentFolders={recentFolders}
            openingRecentPath={openingRecentPath}
            onRecentOpen={onRecentOpen}
            onRecentRemove={onRecentRemove}
          />
        </div>
      </div>
      <footer className="welcome-footer"><span>Git is optional</span><span>Local files only</span></footer>
    </section>
  )
}

function useWelcomeInbox(inboxScope: string) {
  const [inboxRows, setInboxRows] = useState<WelcomeInboxRow[]>(() => readWelcomeInboxCache(inboxScope))
  const [inboxLoading, setInboxLoading] = useState(() => welcomeInboxIsStale(inboxScope))
  const [inboxRefreshing, setInboxRefreshing] = useState(false)
  const [inboxSyncedAt, setInboxSyncedAt] = useState(() => readWelcomeInboxSyncedAt(inboxScope))
  // Outlives the fetch until the current turn completes, so a quick answer
  // still reads as one full rotation instead of the icon snapping back.
  const [refreshSpinning, setRefreshSpinning] = useState(false)
  // Rows that arrived with a refresh rather than the first paint — the ones
  // someone just asked you about, so they get a brief highlight.
  const [freshInboxUrls, setFreshInboxUrls] = useState<ReadonlySet<string>>(() => new Set())
  const refreshInbox = useRef<(() => void) | null>(null)

  useEffect(() => {
    const repository = window.repository
    if (repository == null) {
      setInboxLoading(false)
      return
    }
    setInboxSyncedAt(readWelcomeInboxSyncedAt(inboxScope))
    let cancelled = false
    let inFlight = false
    // Derived from the scope rather than the prop so a new array identity on an
    // unrelated re-render cannot restart the fetch.
    const repos = inboxScope === '' ? [] : inboxScope.split(' ')
    const settle = (): void => {
      inFlight = false
      if (cancelled) return
      setInboxRefreshing(false)
      setInboxLoading(false)
    }
    const fetchInbox = (): void => {
      if (inFlight) return
      inFlight = true
      setInboxRefreshing(true)
      setRefreshSpinning(true)
      const shownUrls = new Set(readWelcomeInboxCache(inboxScope).map((row) => row.url))
      void repository.getGlobalPullRequestInbox(repos).then((snapshot) => {
        if (cancelled) return
        if (snapshot.available) {
          const rows = welcomeInboxRows(snapshot)
          writeWelcomeInboxCache(rows, welcomeInboxRepos(snapshot), inboxScope)
          setInboxSyncedAt(readWelcomeInboxSyncedAt(inboxScope))
          setFreshInboxUrls(shownUrls.size === 0 ? new Set() : new Set(rows.map((row) => row.url).filter((url) => !shownUrls.has(url))))
          setInboxRows(rows)
        } else {
          touchWelcomeInboxCache(inboxScope)
        }
        settle()
      }, () => {
        if (cancelled) return
        touchWelcomeInboxCache(inboxScope)
        settle()
      })
    }
    refreshInbox.current = fetchInbox

    if (welcomeInboxIsStale(inboxScope)) {
      setInboxLoading(true)
      fetchInbox()
    } else {
      setInboxLoading(false)
    }

    // A hidden window has nobody to show new rows to; it catches up on return.
    const fetchIfOlderThan = (maxAgeMs: number): void => {
      if (document.visibilityState === 'visible' && welcomeInboxIsStale(inboxScope, Date.now(), maxAgeMs)) fetchInbox()
    }
    // Ticks faster than the poll so the cadence tracks the last fetch, whoever
    // started it, instead of stacking a timer fetch on top of a manual one.
    const poll = window.setInterval(() => fetchIfOlderThan(WELCOME_INBOX_POLL_MS), WELCOME_INBOX_WAKE_MS)
    const wake = (): void => fetchIfOlderThan(WELCOME_INBOX_WAKE_MS)
    window.addEventListener('focus', wake)
    document.addEventListener('visibilitychange', wake)
    return () => {
      cancelled = true
      refreshInbox.current = null
      window.clearInterval(poll)
      window.removeEventListener('focus', wake)
      document.removeEventListener('visibilitychange', wake)
    }
  }, [inboxScope])

  return {
    inboxRows,
    inboxLoading,
    inboxRefreshing,
    inboxSyncedAt,
    refreshSpinning,
    setRefreshSpinning,
    freshInboxUrls,
    refreshInbox
  }
}

function RecentFoldersSection({
  recentFolders,
  openingRecentPath,
  onRecentOpen,
  onRecentRemove
}: Pick<WelcomeProps, 'recentFolders' | 'openingRecentPath' | 'onRecentOpen' | 'onRecentRemove'>): React.JSX.Element {
  const shownFolders = recentFolders.slice(0, WELCOME_RECENT_FOLDER_LIMIT)
  return (
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
  )
}
