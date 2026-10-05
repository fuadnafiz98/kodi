import { useEffect, useMemo, useState } from 'react'
import { IconChevronSm, IconMinus, IconPlus, IconReply } from '@pierre/icons'
import './GitChangesTab.css'

import type { RepositoryStatusEntry } from '../../../shared/contracts'
import { GitCommitComposer } from './GitCommitComposer'
import {
  groupChanges,
  rangeBetween,
  splitRepositoryPath,
  statusLabel,
  statusLetter,
  type PendingPlacement
} from './gitChangesModel'
import type { CommitOptions } from './useGitWorkflow'

// Rows past this wait behind a button. A tree with an unignored build folder
// can list tens of thousands of files; mounting every one to show the first
// forty cost more than the rest of the panel together.
export const ROW_LIMIT = 400
// Each press reveals one more page, never the rest: revealing all of 24k rows
// at once left every later watcher tick reconciling 24k list items.
export const ROW_PAGE = 500

type Section = 'staged' | 'unstaged'

interface Selection {
  section: Section
  paths: ReadonlySet<string>
  /** Where a shift-click range starts. */
  anchor: string | null
}

export interface GitChangesTabProps {
  root: string
  branch: string | null
  statuses: readonly RepositoryStatusEntry[]
  lastCommitSubject: string | null
  committing: boolean
  blocked: boolean
  onConfirmStage(paths: readonly string[]): Promise<boolean>
  onStage(paths: readonly string[]): Promise<boolean>
  onUnstage(paths: readonly string[]): Promise<boolean>
  onDiscard(paths: readonly string[], untrackedCount: number): Promise<boolean>
  onCommit(options: CommitOptions): Promise<boolean>
  onOpenFile(path: string): void
}

export function GitChangesTab({
  root,
  branch,
  statuses,
  lastCommitSubject,
  committing,
  blocked,
  onConfirmStage,
  onStage,
  onUnstage,
  onDiscard,
  onCommit,
  onOpenFile
}: GitChangesTabProps): React.JSX.Element {
  const [pending, setPending] = useState<ReadonlyMap<string, PendingPlacement>>(() => new Map())
  const [collapsed, setCollapsed] = useState<ReadonlySet<Section>>(() => new Set())
  const [selection, setSelection] = useState<Selection | null>(null)
  // Rows that mount after the first paint are ones that just arrived, so only
  // they get the entrance; the tab opening shows its list at rest.
  const [settled, setSettled] = useState(false)
  useEffect(() => {
    const frame = requestAnimationFrame(() => setSettled(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  const groups = useMemo(() => groupChanges(statuses, pending), [pending, statuses])
  // A commit, push, pull or branch switch holds the index or HEAD. The index
  // queue would only defer a stage until it finished, and by then the reader's
  // selection and the rows under it may no longer mean what they did.
  const locked = blocked || committing

  const move = async (paths: readonly string[], placement: PendingPlacement): Promise<void> => {
    if (locked || paths.length === 0) return
    if (placement === 'staged' && !(await onConfirmStage(paths))) return
    setSelection(null)
    setPending((current) => {
      const next = new Map(current)
      for (const path of paths) next.set(path, placement)
      return next
    })
    const operation = placement === 'staged' ? onStage : onUnstage
    void operation(paths).finally(() => {
      setPending((current) => {
        const next = new Map(current)
        for (const path of paths) if (next.get(path) === placement) next.delete(path)
        return next
      })
    })
  }

  const discard = (entries: readonly RepositoryStatusEntry[]): void => {
    if (locked || entries.length === 0) return
    // An intent-to-add file (` A`, or ` R` when git pairs it with a deletion)
    // has nothing staged to go back to, so main deletes it like an untracked one.
    const untracked = entries.filter((entry) => entry.status === 'untracked'
      || (entry.staged == null && (entry.status === 'added' || entry.status === 'renamed'))).length
    void onDiscard(entries.map((entry) => entry.path), untracked).then((discarded) => {
      if (discarded) setSelection(null)
    })
  }

  const toggle = (section: Section): void => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }

  const selectedIn = (section: Section): ReadonlySet<string> | null =>
    selection?.section === section && selection.paths.size > 0 ? selection.paths : null

  const sectionProps = (section: Section, entries: readonly RepositoryStatusEntry[]) => {
    const selected = selectedIn(section)
    const primary = section === 'staged' ? 'unstaged' : 'staged'
    // An action on a selected row applies to the whole selection, the way VS
    // Code's does; on any other row it applies to that row alone.
    const targetsFor = (entry: RepositoryStatusEntry): RepositoryStatusEntry[] =>
      selected?.has(entry.path) === true ? entries.filter((candidate) => selected.has(candidate.path)) : [entry]
    return {
      section,
      entries,
      selected,
      collapsed: collapsed.has(section),
      settled,
      locked,
      onToggle: toggle,
      onOpenFile,
      onPrimary: (entry: RepositoryStatusEntry) => void move(targetsFor(entry).map((target) => target.path), primary),
      onDiscard: section === 'unstaged' ? (entry: RepositoryStatusEntry) => discard(targetsFor(entry)) : null,
      onSelect: (path: string, mode: 'toggle' | 'range' | 'all' | 'clear') => {
        if (mode === 'clear') {
          setSelection(null)
          return
        }
        if (mode === 'all') {
          setSelection({ section, paths: new Set(entries.map((entry) => entry.path)), anchor: path })
          return
        }
        setSelection((current) => {
          const same = current?.section === section ? current : null
          if (mode === 'range') {
            const order = entries.map((entry) => entry.path)
            return { section, paths: new Set(rangeBetween(order, same?.anchor ?? null, path)), anchor: same?.anchor ?? path }
          }
          const paths = new Set(same?.paths)
          if (paths.has(path)) paths.delete(path)
          else paths.add(path)
          return { section, paths, anchor: path }
        })
      }
    }
  }

  const stagedSelected = selectedIn('staged')
  const unstagedSelected = selectedIn('unstaged')
  const pick = (entries: readonly RepositoryStatusEntry[], selected: ReadonlySet<string> | null) =>
    selected == null ? entries : entries.filter((entry) => selected.has(entry.path))

  return (
    <section className="scm" aria-label="Source control">
      {/* Keyed so a draft typed in one repository never shows in another's composer. */}
      <GitCommitComposer
        key={root}
        root={root}
        branch={branch}
        stagedCount={groups.staged.length}
        changeCount={statuses.length}
        lastCommitSubject={lastCommitSubject}
        committing={committing}
        blocked={blocked}
        onCommit={onCommit}
      />
      {statuses.length === 0 ? (
        <div className="git-panel-state scm-empty">
          <strong>No changes</strong>
          <span>The working tree matches the last commit.</span>
        </div>
      ) : null}
      {groups.staged.length > 0 ? (
        <ChangeSection
          title="Staged Changes"
          {...sectionProps('staged', groups.staged)}
          headerActions={
            <StagedHeaderActions selected={stagedSelected} locked={locked}
              onUnstage={() => void move(pick(groups.staged, stagedSelected).map((entry) => entry.path), 'unstaged')} />
          }
        />
      ) : null}
      {groups.unstaged.length > 0 ? (
        <ChangeSection
          title="Changes"
          {...sectionProps('unstaged', groups.unstaged)}
          headerActions={
            <UnstagedHeaderActions selected={unstagedSelected} locked={locked}
              onDiscard={() => discard(pick(groups.unstaged, unstagedSelected))}
              onStage={() => void move(pick(groups.unstaged, unstagedSelected).map((entry) => entry.path), 'staged')} />
          }
        />
      ) : null}
      {statuses.length > 0 ? (
        <p className="scm-hint">⌘/⇧-click to select · Space to stage or unstage · ⌫ to discard</p>
      ) : null}
    </section>
  )
}

/** A section header's actions cover its selection when there is one, else every row. */
function StagedHeaderActions({ selected, locked, onUnstage }: {
  selected: ReadonlySet<string> | null
  locked: boolean
  onUnstage(): void
}): React.JSX.Element {
  return (
    <button type="button" className="scm-section-button" disabled={locked}
      title={selected == null ? 'Unstage every staged file' : 'Unstage the selected files'}
      onClick={onUnstage}>
      <IconMinus aria-hidden="true" />
      {selected == null ? 'Unstage All' : `Unstage ${selected.size}`}
    </button>
  )
}

function UnstagedHeaderActions({ selected, locked, onDiscard, onStage }: {
  selected: ReadonlySet<string> | null
  locked: boolean
  onDiscard(): void
  onStage(): void
}): React.JSX.Element {
  return (
    <>
      <button type="button" className="scm-icon-button" disabled={locked}
        aria-label={selected == null ? 'Discard all changes' : `Discard ${selected.size} selected`}
        title={selected == null ? 'Discard All Changes' : 'Discard Selected'}
        onClick={onDiscard}>
        <IconReply />
      </button>
      <button type="button" className="scm-section-button suggested" disabled={locked}
        title={selected == null ? 'Stage every change, new files included' : 'Stage the selected files'}
        onClick={onStage}>
        <IconPlus aria-hidden="true" />
        {selected == null ? 'Stage All' : `Stage ${selected.size}`}
      </button>
    </>
  )
}

interface ChangeSectionProps {
  title: string
  section: Section
  entries: readonly RepositoryStatusEntry[]
  selected: ReadonlySet<string> | null
  collapsed: boolean
  settled: boolean
  /** Row actions and their keys do nothing while another action holds the index. */
  locked: boolean
  headerActions: React.ReactNode
  onToggle(section: Section): void
  onOpenFile(path: string): void
  onPrimary(entry: RepositoryStatusEntry): void
  onDiscard: ((entry: RepositoryStatusEntry) => void) | null
  onSelect(path: string, mode: 'toggle' | 'range' | 'all' | 'clear'): void
}

function focusSibling(from: HTMLElement, step: 1 | -1): void {
  const rows = [...(from.closest('.scm')?.querySelectorAll<HTMLElement>('.scm-row-open') ?? [])]
  rows[rows.indexOf(from) + step]?.focus()
}

function ChangeSection({
  title,
  section,
  entries,
  selected,
  collapsed,
  settled,
  locked,
  headerActions,
  onToggle,
  onOpenFile,
  onPrimary,
  onDiscard,
  onSelect
}: ChangeSectionProps): React.JSX.Element {
  const [limit, setLimit] = useState(ROW_LIMIT)
  const listId = `scm-${section}`
  const visible = entries.length > limit ? entries.slice(0, limit) : entries
  const hidden = entries.length - visible.length
  const staged = section === 'staged'
  return (
    <div className="scm-section" data-section={section}>
      <div className="scm-section-header">
        <button type="button" className="scm-section-toggle" aria-expanded={!collapsed} aria-controls={listId}
          onClick={() => onToggle(section)}>
          <IconChevronSm className="scm-section-chevron" aria-hidden="true" />
          <span>{title}</span>
          <span className="scm-count">{entries.length}</span>
        </button>
        <div className="scm-section-actions">{headerActions}</div>
      </div>
      {/* A grid rather than a listbox: ARIA makes an option's children
          presentational, which flattens the stage and discard buttons inside it
          into the option's text. A row carries the selection just as well, and
          each of its parts is a cell — the open button is the one that takes focus.
          Divs, because a list's items cannot be rows; the class names carry the
          same box a `ul` of them did. */}
      {collapsed ? null : (
        <div id={listId} className="scm-list" role="grid" aria-multiselectable="true" aria-label={title}
          data-settled={settled ? '' : undefined}>
          {visible.map((entry) => {
            const { name, directory } = splitRepositoryPath(entry.path)
            const isSelected = selected?.has(entry.path) === true
            return (
              <div key={entry.path} className="scm-row" data-status={entry.status} role="row" aria-selected={isSelected}>
                <button type="button" className="scm-row-open" role="gridcell"
                  title={entry.previousPath == null ? entry.path : `${entry.previousPath} → ${entry.path}`}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey) {
                      onSelect(entry.path, 'toggle')
                      return
                    }
                    if (event.shiftKey) {
                      onSelect(entry.path, 'range')
                      return
                    }
                    if (selected != null) onSelect(entry.path, 'clear')
                    onOpenFile(entry.path)
                  }}
                  onKeyDown={(event) => {
                    const target = event.currentTarget
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault()
                      focusSibling(target, event.key === 'ArrowDown' ? 1 : -1)
                      return
                    }
                    if (event.key === ' ') {
                      // Swallowed even while locked, or the key would open the file instead.
                      event.preventDefault()
                      if (!locked) onPrimary(entry)
                      return
                    }
                    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
                      event.preventDefault()
                      onSelect(entry.path, 'all')
                      return
                    }
                    if ((event.key === 'Delete' || event.key === 'Backspace') && onDiscard != null) {
                      event.preventDefault()
                      if (!locked) onDiscard(entry)
                      return
                    }
                    // Escape clears a selection before it is allowed to close the panel.
                    if (event.key === 'Escape' && selected != null) {
                      event.preventDefault()
                      onSelect(entry.path, 'clear')
                    }
                  }}>
                  <span className="scm-row-name">{name}</span>
                  {directory === '' ? null : <span className="scm-row-directory">{directory}</span>}
                </button>
                <span className="scm-row-actions" role="gridcell">
                  {onDiscard == null ? null : (
                    <button type="button" className="scm-icon-button" tabIndex={-1} disabled={locked}
                      aria-label={`Discard changes to ${entry.path}`} title="Discard Changes"
                      onClick={() => onDiscard(entry)}>
                      <IconReply />
                    </button>
                  )}
                  <button type="button" className="scm-icon-button" tabIndex={-1} disabled={locked}
                    aria-label={`${staged ? 'Unstage' : 'Stage'} ${entry.path}`}
                    title={staged ? 'Unstage (Space)' : 'Stage (Space)'}
                    onClick={() => onPrimary(entry)}>
                    {staged ? <IconMinus /> : <IconPlus />}
                  </button>
                </span>
                <span className="scm-row-status" role="gridcell" title={statusLabel(entry.status)}
                  aria-label={statusLabel(entry.status)}>{statusLetter(entry.status)}</span>
              </div>
            )
          })}
          {hidden > 0 ? (
            <div className="scm-more">
              <button type="button" onClick={() => setLimit(visible.length + ROW_PAGE)}>
                {hidden > ROW_PAGE
                  ? `Show ${ROW_PAGE} more of ${hidden.toLocaleString()}`
                  : `Show ${hidden.toLocaleString()} more`}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
