import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { IconChevronSm, IconX } from '@pierre/icons'

import type { FindInPageResult } from '../../../shared/contracts'
import { deepActiveElement } from '../settings/keybindings'
import { ReviewFindController, type ReviewFindState } from './reviewFind'

const FIND_DEBOUNCE_MS = 60

// The editor binds ⌘F, ⌘G and Escape itself and calls preventDefault without
// stopping propagation, so the window listener has to stand down while the
// caret is inside it — otherwise both find UIs open and the editor's panel
// loses focus to this one immediately.
function editorOwnsFindKeys(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return true
  const active = deepActiveElement(document)
  return active instanceof HTMLElement && active.isContentEditable
}

function reviewCount(state: ReviewFindState): string {
  if (state.total === 0) return '0/0'
  return `${state.active + 1}/${state.total}${state.truncated ? '+' : ''}`
}

/**
 * Find in the current view. Loaded by the ⌘F that first asks for it
 * (`FindBar`), so it opens on arrival with the focus it was asked from.
 *
 * Over a multi-file review it searches every file's diff (`ReviewFindController`):
 * Chromium's find only sees the rows the viewer has drawn, so it missed files
 * further down and collapsed ones, and counted wrong. Elsewhere — the single-file
 * view — it is Chromium's find in page.
 */
export function FindPanel(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [query, setQuery] = useState('')
  const [result, setResult] = useState<FindInPageResult | null>(null)
  const [reviewState, setReviewState] = useState<ReviewFindState | null>(null)
  const [controller] = useState(() => new ReviewFindController(setReviewState))
  const inputRef = useRef<HTMLInputElement>(null)
  const focusReturnRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    focusReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [])

  const close = (): void => {
    setOpen(false)
    setResult(null)
    controller.clear()
    setReviewState(null)
    void window.repository?.stopFindInPage()
    const focusTarget = focusReturnRef.current
    focusReturnRef.current = null
    window.requestAnimationFrame(() => focusTarget?.focus())
  }

  const findNext = (forward: boolean): void => {
    if (query === '') return
    if (reviewState != null) controller.move(forward)
    else void window.repository?.findInPage(query, forward, true)
  }

  const handleGlobalKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (editorOwnsFindKeys(event)) return
    const commandKey = event.metaKey || event.ctrlKey
    if (commandKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      if (!open) {
        focusReturnRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
      }
      setOpen(true)
      window.requestAnimationFrame(() => inputRef.current?.select())
      return
    }
    if (open && event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })

  // ⌘G / ⇧⌘G step through matches while the bar is open. Heard in the
  // capture phase, ahead of the app's shortcuts: ⇧⌘G also toggles the Guide,
  // and an open find bar is the more specific owner.
  const handleFindStep = useEffectEvent((event: KeyboardEvent): void => {
    if (!open || event.defaultPrevented || event.altKey || editorOwnsFindKeys(event)) return
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'g') return
    event.preventDefault()
    findNext(!event.shiftKey)
  })

  useEffect(() => {
    window.addEventListener('keydown', handleGlobalKeyDown)
    window.addEventListener('keydown', handleFindStep, true)
    return () => {
      window.removeEventListener('keydown', handleGlobalKeyDown)
      window.removeEventListener('keydown', handleFindStep, true)
      controller.clear()
      void window.repository?.stopFindInPage()
    }
  }, [controller])

  useEffect(() => window.repository?.onFoundInPage(setResult), [])

  useEffect(() => {
    if (!open) return
    if (query === '') {
      setResult(null)
      controller.setQuery('')
      void window.repository?.stopFindInPage()
      return
    }
    const timeout = window.setTimeout(() => {
      if (controller.available) {
        void window.repository?.stopFindInPage()
        controller.setQuery(query)
        return
      }
      controller.clear()
      setReviewState(null)
      void window.repository?.findInPage(query, true, false)
    }, FIND_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [controller, open, query])

  return (
    <div className="find-bar-anchor">
      {/* Staying mounted is what lets CSS run the exit; `inert` keeps Tab out of
          the hidden bar, which the conditional render used to do for free. */}
      <search className="find-bar" data-open={open ? '' : undefined} inert={!open}>
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            findNext(!event.shiftKey)
          }}
          placeholder="Find in view"
          aria-label="Find in current view"
        />
        <span className="find-count" aria-live="polite">{query === ''
          ? '—'
          : reviewState != null ? reviewCount(reviewState) : `${result?.activeMatchOrdinal ?? 0}/${result?.matches ?? 0}`}</span>
        <button type="button" className="find-previous" disabled={query === ''} onClick={() => findNext(false)} aria-label="Previous match" title="Previous Match (Shift+Enter)">
          <IconChevronSm />
        </button>
        <button type="button" disabled={query === ''} onClick={() => findNext(true)} aria-label="Next match" title="Next Match (Enter)">
          <IconChevronSm />
        </button>
        <button type="button" onClick={close} aria-label="Close find" title="Close (Escape)">
          <IconX />
        </button>
      </search>
    </div>
  )
}
