import { useCallback, useRef, useState } from 'react'
import { IconCheck, IconChevronSm, IconRefresh } from '@pierre/icons'

import { usePopoverDismiss } from '../app/usePopoverDismiss'
import { commitButtonLabel } from './gitChangesModel'
import type { CommitOptions } from './useGitWorkflow'

// Kept outside React so typing a message never re-renders anything above the
// composer, and a half-written message survives closing the panel. One draft
// per repository, for the life of the window.
const drafts = new Map<string, string>()

export interface GitCommitComposerProps {
  root: string
  branch: string | null
  stagedCount: number
  changeCount: number
  lastCommitSubject: string | null
  committing: boolean
  /** Another action holds HEAD or the index. */
  blocked: boolean
  onCommit(options: CommitOptions): Promise<boolean>
}

export function GitCommitComposer({
  root,
  branch,
  stagedCount,
  changeCount,
  lastCommitSubject,
  committing,
  blocked,
  onCommit
}: GitCommitComposerProps): React.JSX.Element {
  const [message, setMessage] = useState(() => drafts.get(root) ?? '')
  const [amend, setAmend] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [needsMessage, setNeedsMessage] = useState(false)
  const splitRef = useRef<HTMLDivElement>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  usePopoverDismiss(menuOpen, splitRef, closeMenu)

  const hasMessage = message.trim() !== ''
  const hasWork = changeCount > 0 || amend
  // An empty message is not a reason to grey the button: pressing it points at
  // the field instead, so the control never looks dead while there is work.
  const available = !committing && !blocked && hasWork
  const label = commitButtonLabel(stagedCount, changeCount, amend)

  const updateMessage = (next: string): void => {
    setMessage(next)
    if (next.trim() !== '') setNeedsMessage(false)
    if (next === '') drafts.delete(root)
    else drafts.set(root, next)
  }

  const submit = async (push: boolean): Promise<void> => {
    setMenuOpen(false)
    if (!available) return
    if (!hasMessage && !amend) {
      setNeedsMessage(true)
      messageRef.current?.focus()
      return
    }
    const committed = await onCommit({
      message,
      amend,
      all: !amend && stagedCount === 0,
      push
    })
    if (!committed) return
    updateMessage('')
    setAmend(false)
  }

  const placeholder = amend
    ? `Leave empty to keep “${lastCommitSubject ?? 'the last message'}”`
    : `Message (⌘↵ to commit${branch == null ? '' : ` on “${branch}”`})`

  return (
    <form
      className="scm-composer"
      aria-label="Commit"
      onSubmit={(event) => {
        event.preventDefault()
        void submit(false)
      }}
    >
      {amend ? (
        <div className="scm-amend-note">
          <span>Amending <strong>{lastCommitSubject ?? 'the last commit'}</strong></span>
          <button type="button" onClick={() => setAmend(false)}>Cancel</button>
        </div>
      ) : null}
      <textarea
        ref={messageRef}
        name="commit-message"
        aria-label="Commit message"
        aria-invalid={needsMessage}
        aria-describedby={needsMessage ? 'scm-message-hint' : undefined}
        className="scm-message"
        rows={1}
        spellCheck
        placeholder={placeholder}
        value={message}
        onChange={(event) => updateMessage(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
          event.preventDefault()
          void submit(event.shiftKey)
        }}
      />
      {needsMessage ? (
        <p id="scm-message-hint" className="scm-message-hint" role="status">Write a message to commit.</p>
      ) : null}
      <div className="scm-commit-split" ref={splitRef}>
        <button className="scm-commit-button" type="submit" disabled={!available} aria-busy={committing}>
          <span className="action-icon-slot">{committing ? <IconRefresh className="spin" /> : <IconCheck />}</span>
          {committing ? (amend ? 'Amending…' : 'Committing…') : label}
        </button>
        <button
          className="scm-commit-more"
          type="button"
          aria-label="More commit actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={committing || blocked}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <IconChevronSm />
        </button>
        {menuOpen ? (
          <div className="scm-commit-menu" role="menu" aria-label="Commit actions">
            <button type="button" role="menuitem" disabled={!available} onClick={() => void submit(true)}>
              <span>{amend ? 'Amend & Push' : `${label} & Push`}</span><kbd>⇧⌘↵</kbd>
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={amend}
              disabled={lastCommitSubject == null}
              onClick={() => {
                setAmend((current) => !current)
                setMenuOpen(false)
              }}
            >
              <span>Amend Last Commit</span>{amend ? <IconCheck aria-hidden="true" /> : null}
            </button>
          </div>
        ) : null}
      </div>
    </form>
  )
}
