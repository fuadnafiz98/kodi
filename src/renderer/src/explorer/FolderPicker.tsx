import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { IconFolder, IconRefresh } from '@pierre/icons'

import type { FolderPickerCatalog } from '../../../shared/contracts'
import { highlightPathMatches } from '../../../shared/folderPath'
import { OPEN_SPINNER_DELAY_MS } from './folderOpenSettle'
import { buildFolderPickerRows, preloadFolderCatalog, type FolderPickerRow } from './folderPickerModel'
import { nextPaletteIndex } from '../palette/paletteCommands'
import { getErrorMessage, requireRepositoryApi } from './repositoryApi'
import type { RecentFolder } from './recentFolders'

const EMPTY_CATALOG: FolderPickerCatalog = { home: '', folders: [] }

interface FolderChromeButtonProps {
  opening: boolean
  open: boolean
  shortcut: string
  recentFolders: readonly RecentFolder[]
  openingPath: string | null
  onToggle(): void
  onClose(): void
  onSelect(path: string): void
  onUseExisting(): void
}

export function FolderChromeButton({
  opening,
  open,
  shortcut,
  recentFolders,
  openingPath,
  onToggle,
  onClose,
  onSelect,
  onUseExisting
}: FolderChromeButtonProps): React.JSX.Element {
  return (
    <div className="folder-picker-host">
      <button
        className={`icon-button ${open ? 'active' : ''}`}
        type="button"
        onClick={onToggle}
        onMouseEnter={preloadFolderCatalog}
        onFocus={preloadFolderCatalog}
        disabled={opening}
        aria-label="Open folder"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`Open Folder (${shortcut})`}
      >
        {opening ? <IconRefresh className="spin" /> : <IconFolder />}
      </button>
      {open ? (
        <FolderPicker
          recentFolders={recentFolders}
          openingPath={openingPath}
          onClose={onClose}
          onSelect={onSelect}
          onUseExisting={onUseExisting}
        />
      ) : null}
    </div>
  )
}

interface FolderPickerProps {
  recentFolders: readonly RecentFolder[]
  openingPath: string | null
  dialogLabel?: string
  inputId?: string
  onClose(): void
  onSelect(path: string): void
  onUseExisting(): void
}

function PathHighlight({ text, query }: { text: string; query: string }): React.JSX.Element {
  return (
    <>
      {highlightPathMatches(text, query).map((part, index) => (
        <span key={`${index}:${part.text}`} data-match={part.match ? 'true' : undefined}>{part.text}</span>
      ))}
    </>
  )
}

function FolderRow({
  row,
  active,
  query,
  opening,
  disabled,
  buttonRef,
  onPointerEnter,
  onSelect
}: {
  row: Extract<FolderPickerRow, { kind: 'folder' }>
  active: boolean
  query: string
  opening: boolean
  disabled: boolean
  buttonRef(node: HTMLButtonElement | null): void
  onPointerEnter(): void
  onSelect(): void
}): React.JSX.Element {
  return (
    <button
      ref={buttonRef}
      id={row.id}
      type="button"
      role="option"
      aria-label={row.folder.displayPath}
      aria-selected={active}
      className={active ? 'primary-result' : undefined}
      disabled={disabled}
      onPointerEnter={onPointerEnter}
      onClick={onSelect}
    >
      {opening ? <IconRefresh className="spin" aria-hidden="true" /> : <IconFolder aria-hidden="true" />}
      <span>
        <strong>
          <PathHighlight text={row.folder.displayPath} query={query} />
        </strong>
      </span>
    </button>
  )
}

export function FolderPicker({
  recentFolders,
  openingPath,
  dialogLabel = 'Open folder',
  inputId = 'folder-picker-input',
  onClose,
  onSelect,
  onUseExisting
}: FolderPickerProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [catalog, setCatalog] = useState<FolderPickerCatalog>(EMPTY_CATALOG)
  const [catalogError, setCatalogError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void requireRepositoryApi().listFolderCandidates()
      .then((next) => {
        if (!cancelled) setCatalog(next)
      })
      .catch((error: unknown) => {
        if (!cancelled) setCatalogError(getErrorMessage(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.folder-picker-host') != null) return
      onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [onClose])

  // Non-modal: the picker is anchored under its button, not a centred sheet, and
  // the top layer would take it out of that anchor. `show()` still gives screen
  // readers the native dialog role; Escape and outside clicks are handled below,
  // because a non-modal dialog fires no `cancel`.
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog != null && !dialog.open) dialog.show()
    inputRef.current?.focus()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  const rows = useMemo(
    () => buildFolderPickerRows(recentFolders, catalog.folders, query, catalog.home),
    [catalog.folders, catalog.home, query, recentFolders]
  )
  const folderRows = rows.filter((row): row is Extract<FolderPickerRow, { kind: 'folder' }> => row.kind === 'folder')
  const clampedIndex = rows.length === 0 ? 0 : Math.min(activeIndex, rows.length - 1)
  const activeRow = rows[clampedIndex]
  const searching = query.trim() !== ''
  const busy = openingPath != null

  // Most folders open inside a frame or two. Marking the row immediately turns
  // every ⌘O into a spinner blink, so the row only spins once the open is slow
  // enough to be worth reporting.
  const [openingSlowly, setOpeningSlowly] = useState(false)
  useEffect(() => {
    if (openingPath == null) return
    const timer = setTimeout(() => setOpeningSlowly(true), OPEN_SPINNER_DELAY_MS)
    return () => {
      clearTimeout(timer)
      setOpeningSlowly(false)
    }
  }, [openingPath])

  useLayoutEffect(() => {
    rowRefs.current[clampedIndex]?.scrollIntoView({ block: 'nearest' })
  }, [clampedIndex, query])

  const moveActive = (delta: number): void => {
    setActiveIndex((current) => nextPaletteIndex(current, delta, rows.length))
  }

  const runActive = (): void => {
    if (activeRow == null || busy) return
    if (activeRow.kind === 'native') {
      onUseExisting()
      return
    }
    onSelect(activeRow.folder.path)
  }

  const updateQuery = (next: string): void => {
    setQuery(next)
    setActiveIndex(0)
  }

  const groups = searching
    ? [{ label: 'Folders', items: folderRows }]
    : [{ label: 'Recents', items: folderRows }]

  return (
    <dialog
      ref={dialogRef}
      className="folder-picker"
      aria-label={dialogLabel}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          runActive()
        }}
      >
        <label className="sr-only" htmlFor={inputId}>Search folders</label>
        <input
          ref={inputRef}
          id={inputId}
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              onClose()
              return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            moveActive(event.key === 'ArrowDown' ? 1 : -1)
          }}
          placeholder="Search folders..."
          spellCheck={false}
          autoCapitalize="none"
          autoComplete="off"
          aria-controls="folder-picker-results"
          aria-activedescendant={activeRow?.id}
        />
      </form>

      <div id="folder-picker-results" className="folder-picker-results" role="listbox" aria-label="Folders">
        {folderRows.length === 0 ? (
          <div className="folder-picker-empty">
            <IconFolder aria-hidden="true" />
            <strong>{searching ? 'No matching folders' : 'No recent folders'}</strong>
            <span>
              {catalogError ?? (searching
                ? 'Try another name, or use the macOS picker below.'
                : 'Folders you open will appear here.')}
            </span>
          </div>
        ) : groups.map((group) => (
          group.items.length === 0 ? null : (
            <div key={group.label}>
              <p>{group.label}</p>
              {group.items.map((row) => {
                const index = rows.indexOf(row)
                return (
                  <FolderRow
                    key={row.id}
                    row={row}
                    active={row.id === activeRow?.id}
                    query={query.trim()}
                    opening={openingSlowly && openingPath === row.folder.path}
                    disabled={busy}
                    buttonRef={(node) => { rowRefs.current[index] = node }}
                    onPointerEnter={() => setActiveIndex(index)}
                    onSelect={() => onSelect(row.folder.path)}
                  />
                )
              })}
            </div>
          )
        ))}
      </div>

      <div className="folder-picker-footer">
        <button
          ref={(node) => { rowRefs.current[rows.length - 1] = node }}
          id="native"
          type="button"
          role="option"
          aria-selected={activeRow?.kind === 'native'}
          className={activeRow?.kind === 'native' ? 'primary-result' : undefined}
          disabled={busy}
          onPointerEnter={() => setActiveIndex(rows.length - 1)}
          onClick={onUseExisting}
        >
          <IconFolder aria-hidden="true" />
          <span>Use Existing…</span>
          <span className="folder-picker-chevron" aria-hidden="true">›</span>
        </button>
      </div>
    </dialog>
  )
}
