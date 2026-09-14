import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { IconRefresh, IconSearch } from '@pierre/icons'

import type { RepositoryReview, RepositorySnapshot } from '../../../shared/contracts'
import { formatKeybinding, type AppCommand, type KeybindingMap } from '../settings/keybindings'
import { nextPaletteIndex } from './paletteCommands'
import { usePaletteActions, type PaletteAction } from './paletteActions'
import {
  isCommandOnlyQuery,
  paletteFilterQuery,
  pathCompletion,
  searchQueryForRepository
} from './paletteQuery'
import { PaletteResults } from './PaletteResults'
import { parsePullRequestSelector } from '../github/pullRequestSelector'
import { useRepositorySearch } from './useRepositorySearch'

// One screenful of rows, which is all the panel can show at its 560px cap. The
// rest arrive a frame later, so the keystroke that opened the palette pays for
// twelve rows and twelve icons instead of thirty-four.
const FIRST_PAINT_ROWS = 12
// Matches --duration-instant, the scrim fade the panel is composited through.
const PALETTE_OPENING_MS = 80

export interface CommandPaletteProps {
  /** What the pre-chunk shell had collected by the time this component mounted. */
  initialQuery?: string
  snapshot: RepositorySnapshot | null
  repositoryReview?: Pick<RepositoryReview, 'files'> | null
  keybindings: KeybindingMap
  recentFiles?: readonly string[]
  branches?: readonly string[]
  onClose(): void
  onError(message: string): void
  onOpenPullRequest(selector: number | string): void
  onOpenRepository(): void
  onOpenSettings(): void
  onToggleTerminal(): void
  onRunCommand?(command: AppCommand): void
  onOpenFile?(path: string): void
  /** Moves the explorer to a directory row the reader picked. */
  onRevealDirectory?(path: string): void
  onSwitchBranch?(branch: string): void
}

export const CommandPalette = memo(function CommandPalette({
  initialQuery = '',
  snapshot,
  repositoryReview = null,
  keybindings,
  recentFiles,
  branches,
  onClose,
  onError,
  onOpenPullRequest,
  onOpenRepository,
  onOpenSettings,
  onToggleTerminal,
  onRunCommand,
  onOpenFile,
  onRevealDirectory,
  onSwitchBranch
}: CommandPaletteProps): React.JSX.Element {
  // Search state lives here, not in the app layout: a keystroke must re-render
  // the palette and nothing else.
  const { changeQuery, contentResults, fileResults, flushContentSearch, searchingContent } =
    useRepositorySearch(snapshot, onError, repositoryReview, recentFiles)
  const gitRepositoryOpen = snapshot?.kind === 'git'
  const projectOpen = snapshot != null
  const [query, setQuery] = useState(initialQuery)
  const [activeIndex, setActiveIndex] = useState(0)
  const [opening, setOpening] = useState(true)
  const [rowsSettled, setRowsSettled] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const scrollActiveRowRef = useRef(false)
  const selector = parsePullRequestSelector(query)
  const filterQuery = paletteFilterQuery(query)
  const commandOnly = isCommandOnlyQuery(query)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog != null && !dialog.open) dialog.showModal()
    inputRef.current?.focus()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => setOpening(false), PALETTE_OPENING_MS)
    return () => window.clearTimeout(timer)
  }, [])

  // Everything below the fold waits for the frame after the mount. Only the first
  // commit is on the reader's keystroke; the tail is not.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setRowsSettled(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])

  // The shell that stood in for this chunk kept the reader's keystrokes; the
  // search they asked for has to start now that the real palette is here.
  const adoptInitialQuery = useEffectEvent(() => {
    if (initialQuery === '') return
    changeQuery(searchQueryForRepository(initialQuery))
  })
  useEffect(() => adoptInitialQuery(), [])

  const updateQuery = useCallback((next: string): void => {
    setQuery(next)
    setActiveIndex(0)
    startTransition(() => {
      changeQuery(searchQueryForRepository(next))
    })
  }, [changeQuery])

  const drillIntoDirectory = useCallback((path: string): void => {
    onRevealDirectory?.(path)
    updateQuery(`${path}/`)
    inputRef.current?.focus()
  }, [onRevealDirectory, updateQuery])

  const showAllCommands = useCallback((): void => updateQuery('>'), [updateQuery])

  const results = usePaletteActions({
    filterQuery,
    commandOnly,
    hasPullRequestSelector: selector != null,
    fileResults,
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
    onDrillIntoDirectory: drillIntoDirectory,
    onShowAllCommands: showAllCommands
  })

  // The rendered list, which is the whole list from the second frame onwards.
  // Selection, grouping and `data-index` all read this one so the keyboard can
  // never land on a row that is not on screen yet.
  const visibleResults = useMemo(
    () => rowsSettled || results.length <= FIRST_PAINT_ROWS
      ? results
      : results.slice(0, FIRST_PAINT_ROWS),
    [results, rowsSettled]
  )

  const clampedIndex = visibleResults.length === 0
    ? 0
    : Math.min(activeIndex, visibleResults.length - 1)
  const activeAction: PaletteAction | undefined = visibleResults[clampedIndex]

  useLayoutEffect(() => {
    if (!scrollActiveRowRef.current) return
    scrollActiveRowRef.current = false
    resultsRef.current
      ?.querySelector(`[data-index="${clampedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [clampedIndex])

  const moveActive = (direction: 1 | -1): void => {
    scrollActiveRowRef.current = true
    setActiveIndex(nextPaletteIndex(clampedIndex, direction, visibleResults.length))
  }

  const displayPullRequest = (): void => {
    if (!gitRepositoryOpen || selector == null) return
    onClose()
    onOpenPullRequest(selector)
  }

  const runActive = (): void => {
    if (selector != null) {
      displayPullRequest()
      return
    }
    if (activeAction != null && activeAction.disabledReason == null) {
      activeAction.run()
      return
    }
    // Nothing here to open, so the reader is waiting on the content search.
    // Enter means "stop waiting", not "do nothing".
    flushContentSearch()
  }

  const completion = commandOnly || selector != null
    ? null
    : pathCompletion(query, fileResults[0]?.path)

  const acceptCompletion = (): void => {
    if (completion == null) return
    updateQuery(`${query}${completion}`)
  }

  // One handler for the whole list instead of one closure per row: crossing the
  // results with the pointer used to set state once per row it passed over.
  const trackPointer = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!(event.target instanceof HTMLElement)) return
    const row = event.target.closest<HTMLElement>('[data-index]')
    if (row == null) return
    const index = Number(row.dataset.index)
    if (Number.isNaN(index) || index === clampedIndex) return
    setActiveIndex(index)
  }

  return (
    <dialog
      ref={dialogRef}
      className="command-palette-layer"
      aria-labelledby="command-palette-title"
      closedby="any"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        onClose()
      }}
    >
      <button
        type="button"
        className="command-palette-backdrop"
        tabIndex={-1}
        aria-label="Close command palette"
        onClick={onClose}
      />
      <section className="command-palette" data-opening={opening ? 'true' : undefined}>
        <form onSubmit={(event) => {
          event.preventDefault()
          runActive()
        }}>
          <IconSearch aria-hidden="true" />
          <label className="sr-only" id="command-palette-title" htmlFor="command-palette-input">Command palette</label>
          <div className="command-palette-input">
            <input
              ref={inputRef}
              id="command-palette-input"
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Tab' && completion != null) {
                  event.preventDefault()
                  acceptCompletion()
                  return
                }
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                event.preventDefault()
                moveActive(event.key === 'ArrowDown' ? 1 : -1)
              }}
              placeholder="Search files, commands, or a pull request"
              spellCheck={false}
              autoCapitalize="none"
            />
            {completion == null ? null : (
              <span className="command-palette-ghost" aria-hidden="true">
                <span>{query}</span>{completion}
              </span>
            )}
          </div>
          {searchingContent ? <IconRefresh className="spin search-spinner" aria-hidden="true" /> : null}
          <kbd>{formatKeybinding(keybindings.openCommandPalette)}</kbd>
        </form>

        <PaletteResults
          results={visibleResults}
          activeId={activeAction?.id ?? null}
          filterQuery={filterQuery}
          selector={selector}
          gitRepositoryOpen={gitRepositoryOpen}
          listRef={resultsRef}
          onPointerMove={trackPointer}
          onDisplayPullRequest={displayPullRequest}
        />

        <footer>
          <span><kbd>↑↓</kbd> Select</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>&gt;</kbd> Commands</span>
          <span><kbd>esc</kbd> Close</span>
        </footer>
      </section>
    </dialog>
  )
})
