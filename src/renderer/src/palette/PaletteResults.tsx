import { useMemo, type PointerEvent, type Ref } from 'react'
import { IconInReview, IconSearch } from '@pierre/icons'

import type { PaletteAction } from './paletteActions'
import { groupPaletteEntries, type PaletteEntry, type PaletteGroup } from './paletteCommands'
import { pullRequestNumber } from './paletteQuery'
import { PaletteRow } from './PaletteRow'

export interface PaletteResultsProps {
  results: readonly PaletteAction[]
  /** The row the keyboard is on; `null` when the list is empty. */
  activeId: string | null
  filterQuery: string
  /** A parsed `#123` or pull request URL, which replaces the list with one row. */
  selector: number | string | null
  gitRepositoryOpen: boolean
  listRef: Ref<HTMLDivElement>
  onPointerMove(event: PointerEvent<HTMLDivElement>): void
  onDisplayPullRequest(): void
}

export function PaletteResults({
  results,
  activeId,
  filterQuery,
  selector,
  gitRepositoryOpen,
  listRef,
  onPointerMove,
  onDisplayPullRequest
}: PaletteResultsProps): React.JSX.Element {
  // Grouping keeps a running offset so `data-index` matches the flat list the
  // keyboard walks; the delegated pointer handler reads it back off the row.
  const groups = useMemo(() => {
    const sections: Array<{ group: PaletteGroup; entries: PaletteEntry[]; start: number }> = []
    let start = 0
    for (const section of groupPaletteEntries(results)) {
      sections.push({ group: section.group, entries: section.entries, start })
      start += section.entries.length
    }
    return sections
  }, [results])

  return (
    <div
      className="command-palette-results"
      aria-live="polite"
      ref={listRef}
      onPointerMove={onPointerMove}
    >
      {selector != null ? (
        <button type="button" className="primary-result" onClick={onDisplayPullRequest} disabled={!gitRepositoryOpen}>
          <span className="command-icon"><IconInReview /></span>
          <span>
            <strong>Display PR #{pullRequestNumber(selector)}</strong>
            <small>{gitRepositoryOpen ? 'Open the pull request in multi-file review' : 'Open a Git repository first'}</small>
          </span>
          <kbd>↵</kbd>
        </button>
      ) : results.length === 0 ? (
        <div className="command-palette-empty">
          <IconSearch aria-hidden="true" />
          <strong>No matching files or commands</strong>
          <span>Try a file name, a command, &gt; for commands only, a PR number such as #123, or a GitHub pull request URL.</span>
        </div>
      ) : groups.map(({ group, entries, start }) => (
        <div key={group}>
          <p>{group}</p>
          {entries.map((entry, offset) => {
            const action = entry as PaletteAction
            return (
              <PaletteRow
                key={action.id}
                action={action}
                index={start + offset}
                active={action.id === activeId}
                filterQuery={filterQuery}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}
