import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref
} from 'react'

import type { CommandPaletteProps } from './CommandPalette'
import { loadCommandPalette, useCommandPaletteModule } from './commandPaletteModule'
import { warmFileSearchIndex } from './fileSearch'
import { formatKeybinding } from '../settings/keybindings'
import { getErrorMessage } from '../explorer/repositoryApi'

export interface CommandPaletteHandle {
  close(): boolean
  open(): void
  toggle(): void
}

/**
 * The share of Cmd+P the app is answerable for: the keystroke that asked for the
 * palette to the frame its input took focus. The CDP probe's own number carries
 * four input round trips and a poll on top of this, so the mark is what a
 * regression should be read from.
 */
export const PALETTE_OPEN_MEASURE = 'kodi:palette-open-to-focus'

let paletteOpenStartedAt: number | null = null

function measurePaletteFocus(): void {
  if (paletteOpenStartedAt == null) return
  const start = paletteOpenStartedAt
  paletteOpenStartedAt = null
  // One entry, always the last open: a session that reaches for Cmd+P a hundred
  // times should not leave a hundred entries in the user-timing buffer.
  performance.clearMeasures(PALETTE_OPEN_MEASURE)
  performance.measure(PALETTE_OPEN_MEASURE, { start })
}

export interface CommandPaletteShellProps {
  keybinding: string
  value: string
  onChange(value: string): void
  onClose(): void
}

/**
 * What Cmd+P puts on screen when the palette chunk has not landed yet: the same
 * frame, the same box, a focused input whose text the real palette adopts. It
 * imports nothing from CommandPalette.tsx, so it costs the boot chunk nothing.
 */
export function CommandPaletteShell({
  keybinding,
  value,
  onChange,
  onClose
}: CommandPaletteShellProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog != null && !dialog.open) dialog.showModal()
    inputRef.current?.focus()
    measurePaletteFocus()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [])

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
      <section className="command-palette">
        <form onSubmit={(event) => event.preventDefault()}>
          <label className="sr-only" id="command-palette-title" htmlFor="command-palette-input">Command palette</label>
          <input
            ref={inputRef}
            id="command-palette-input"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder="Search files, commands, or a pull request"
            spellCheck={false}
            autoCapitalize="none"
          />
          <kbd>{keybinding}</kbd>
        </form>
        <div className="command-palette-results" aria-live="polite" />
      </section>
    </dialog>
  )
}

export interface CommandPaletteHostProps extends Omit<CommandPaletteProps, 'initialQuery' | 'onClose'> {
  ref?: Ref<CommandPaletteHandle>
}

/**
 * Owns whether the palette is on screen and which component renders it. Mounted
 * for the life of the app so Cmd+P is a state flip rather than a chunk load, and
 * a sibling of the workspace so nothing the palette does re-renders the tree.
 */
export const CommandPaletteHost = memo(function CommandPaletteHost({
  ref,
  ...paletteProps
}: CommandPaletteHostProps): React.JSX.Element | null {
  const paletteModule = useCommandPaletteModule()
  const [open, setOpen] = useState(false)
  const [panelReady, setPanelReady] = useState(false)
  const [pendingQuery, setPendingQuery] = useState('')
  const openRef = useRef(false)
  const focusReturnRef = useRef<HTMLElement | null>(null)
  // The handle outlives every prop change, so the error reporter it reaches for
  // is read through a ref rather than baked into its identity.
  const onErrorRef = useRef(paletteProps.onError)
  useLayoutEffect(() => {
    onErrorRef.current = paletteProps.onError
  })

  const setVisibility = useCallback((visible: boolean): void => {
    if (visible && !openRef.current) {
      paletteOpenStartedAt = performance.now()
      focusReturnRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      void loadCommandPalette().catch((error: unknown) => onErrorRef.current(getErrorMessage(error)))
    }
    openRef.current = visible
    setOpen(visible)
    if (visible) return
    setPanelReady(false)
    setPendingQuery('')
    const focusTarget = focusReturnRef.current
    focusReturnRef.current = null
    window.requestAnimationFrame(() => focusTarget?.focus())
  }, [])

  // The keystroke that opens the palette commits the shell and nothing else: the
  // panel builds its rows on the next frame, so the input is focused within one
  // frame however much the repository has to offer it.
  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => setPanelReady(true))
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  // The index is built from the snapshot the reader is already looking at, so it
  // can be built before they ask for it. Opening the palette then looks it up.
  const snapshotPaths = paletteProps.snapshot?.paths
  useEffect(() => warmFileSearchIndex(snapshotPaths), [snapshotPaths])

  useImperativeHandle(ref, () => ({
    close: () => {
      if (!openRef.current) return false
      setVisibility(false)
      return true
    },
    open: () => setVisibility(true),
    toggle: () => setVisibility(!openRef.current)
  }), [setVisibility])

  if (!open) return null
  if (paletteModule == null || !panelReady) {
    return (
      <CommandPaletteShell
        keybinding={formatKeybinding(paletteProps.keybindings.openCommandPalette)}
        value={pendingQuery}
        onChange={setPendingQuery}
        onClose={() => setVisibility(false)}
      />
    )
  }
  return (
    <paletteModule.CommandPalette
      {...paletteProps}
      initialQuery={pendingQuery}
      onClose={() => setVisibility(false)}
    />
  )
})
