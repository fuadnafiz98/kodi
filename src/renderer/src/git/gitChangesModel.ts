import type { RepositoryFileStatus, RepositoryStatusEntry } from '../../../shared/contracts'

/** Where a click just sent a file, shown before the index confirms it. */
export type PendingPlacement = 'staged' | 'unstaged'

export interface ChangeGroups {
  staged: RepositoryStatusEntry[]
  unstaged: RepositoryStatusEntry[]
}

/**
 * A partially staged file sits in both lists, like VS Code's Source Control.
 * `pending` overrides the index for files whose stage/unstage is still in
 * flight, so a click moves the row on the frame it happens.
 */
export function groupChanges(
  statuses: readonly RepositoryStatusEntry[],
  pending: ReadonlyMap<string, PendingPlacement>
): ChangeGroups {
  const staged: RepositoryStatusEntry[] = []
  const unstaged: RepositoryStatusEntry[] = []
  for (const entry of statuses) {
    const placement = pending.get(entry.path)
    if (placement === 'staged') {
      staged.push(entry)
      continue
    }
    if (placement === 'unstaged') {
      unstaged.push(entry)
      continue
    }
    if (entry.staged != null) staged.push(entry)
    if (entry.staged == null || entry.staged === 'partial') unstaged.push(entry)
  }
  return { staged, unstaged }
}

const STATUS_LETTERS: Record<RepositoryFileStatus, string> = {
  added: 'A',
  conflicted: 'C',
  deleted: 'D',
  modified: 'M',
  renamed: 'R',
  untracked: 'U'
}

const STATUS_LABELS: Record<RepositoryFileStatus, string> = {
  added: 'Added',
  conflicted: 'Conflicted',
  deleted: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  untracked: 'Untracked'
}

export function statusLetter(status: RepositoryFileStatus): string {
  return STATUS_LETTERS[status]
}

export function statusLabel(status: RepositoryFileStatus): string {
  return STATUS_LABELS[status]
}

export function splitRepositoryPath(path: string): { name: string; directory: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1
    ? { name: path, directory: '' }
    : { name: path.slice(slash + 1), directory: path.slice(0, slash) }
}

/**
 * The label always says what the click will do: with nothing staged the commit
 * takes every change, so the button has to say so rather than fail.
 */
export function commitButtonLabel(stagedCount: number, changeCount: number, amend: boolean): string {
  if (amend) return 'Amend'
  if (changeCount === 0) return 'Nothing to Commit'
  return stagedCount > 0 ? 'Commit' : 'Commit All'
}

export { looksSensitive, sensitiveNewFiles } from './sensitiveFiles'

/** The rows between the anchor and the clicked row, inclusive, in list order. */
export function rangeBetween(order: readonly string[], anchor: string | null, target: string): string[] {
  const end = order.indexOf(target)
  if (end === -1) return []
  const start = anchor == null ? -1 : order.indexOf(anchor)
  if (start === -1) return [target]
  return order.slice(Math.min(start, end), Math.max(start, end) + 1)
}
