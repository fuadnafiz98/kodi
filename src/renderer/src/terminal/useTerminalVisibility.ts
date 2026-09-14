import { useCallback, useEffect, useEffectEvent, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'


import { isTerminalToggleShortcut, keybindingFromEvent, type KeybindingMap } from '../settings/keybindings'
import { clampTerminalHeight, DEFAULT_TERMINAL_HEIGHT } from './terminalPanel'
import type { TerminalDockHandle } from './TerminalDock'

const TERMINAL_HEIGHT_STORAGE_KEY = 'kodi:terminal-height:v1'

function loadTerminalHeight(): number {
  try {
    const stored = Number(localStorage.getItem(TERMINAL_HEIGHT_STORAGE_KEY))
    return clampTerminalHeight(stored || DEFAULT_TERMINAL_HEIGHT, window.innerHeight)
  } catch {
    return clampTerminalHeight(DEFAULT_TERMINAL_HEIGHT, window.innerHeight)
  }
}

function saveTerminalHeight(height: number): void {
  try {
    localStorage.setItem(TERMINAL_HEIGHT_STORAGE_KEY, String(height))
  } catch {
    // The current height remains active when storage is unavailable.
  }
}

export interface TerminalVisibilityOptions {
  /** No folder open, no dock to toggle. */
  enabled: boolean
  keybindings: KeybindingMap
  /** Overlays that must give way before the terminal takes focus. Must be stable. */
  onBeforeOpen(): void
}

export interface TerminalVisibility {
  open: boolean
  mounted: boolean
  height: number
  resizing: boolean
  dockRef: RefObject<TerminalDockHandle | null>
  setHeight: Dispatch<SetStateAction<number>>
  setResizing: Dispatch<SetStateAction<boolean>>
  toggle(): void
  close(): void
  commitHeight(height: number): void
}

/**
 * The terminal dock's own state: whether it is open, how tall it is, and the
 * focus hand-off in both directions. `mounted` trails `open` so closing the dock
 * keeps the pty alive and reopening it is instant.
 */
export function useTerminalVisibility({
  enabled,
  keybindings,
  onBeforeOpen
}: TerminalVisibilityOptions): TerminalVisibility {
  const [open, setOpen] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [height, setHeight] = useState(loadTerminalHeight)
  const [resizing, setResizing] = useState(false)
  const dockRef = useRef<TerminalDockHandle>(null)
  const openRef = useRef(false)
  const focusReturnRef = useRef<HTMLElement | null>(null)

  const setVisibility = useCallback((visible: boolean) => {
    if (openRef.current === visible) return
    openRef.current = visible
    if (visible) {
      focusReturnRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      onBeforeOpen()
      setMounted(true)
      setOpen(true)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => dockRef.current?.focus())
      })
      return
    }
    setOpen(false)
    setResizing(false)
    const focusTarget = focusReturnRef.current
    focusReturnRef.current = null
    window.requestAnimationFrame(() => focusTarget?.focus())
  }, [onBeforeOpen])

  const toggle = useCallback(() => {
    if (enabled) setVisibility(!openRef.current)
  }, [enabled, setVisibility])

  const close = useCallback(() => setVisibility(false), [setVisibility])

  const commitHeight = useCallback((nextHeight: number) => {
    const clamped = clampTerminalHeight(nextHeight, window.innerHeight)
    setHeight(clamped)
    saveTerminalHeight(clamped)
  }, [])

  useEffect(() => {
    const clampToWindow = (): void => {
      setHeight((current) => clampTerminalHeight(current, window.innerHeight))
    }
    window.addEventListener('resize', clampToWindow)
    return () => window.removeEventListener('resize', clampToWindow)
  }, [])

  const handleShortcut = useEffectEvent((event: KeyboardEvent): void => {
    if (event.repeat || !enabled) return
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('.keybinding-recorder .recording') != null) return
    if (!isTerminalToggleShortcut(event, keybindings)) return
    const binding = keybindingFromEvent(event)
    if (target?.closest('.terminal-dock') != null && binding === 'Control+KeyJ') return
    event.preventDefault()
    event.stopPropagation()
    toggle()
  })

  useEffect(() => {
    window.addEventListener('keydown', handleShortcut, true)
    return () => window.removeEventListener('keydown', handleShortcut, true)
  }, [])

  return { open, mounted, height, resizing, dockRef, setHeight, setResizing, toggle, close, commitHeight }
}
