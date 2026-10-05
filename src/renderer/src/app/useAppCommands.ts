import { useCallback, useEffect, useEffectEvent, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'

import type { CommandPaletteHandle } from '../palette/CommandPaletteHost'
import { commandFromEvent, type AppCommand } from '../settings/keybindings'
import type { AppPreferences } from '../settings/preferences'
import type { useGitWorkflow } from '../git/useGitWorkflow'

export interface CommandPaletteControls {
  ref: RefObject<CommandPaletteHandle | null>
  close(): void
  open(): void
  toggle(): void
}

/** The palette host is always mounted, so driving it is a ref call, not a state flip. */
export function useCommandPaletteControls(): CommandPaletteControls {
  const ref = useRef<CommandPaletteHandle>(null)
  return useMemo(() => ({
    ref,
    close: () => { ref.current?.close() },
    open: () => ref.current?.open(),
    toggle: () => ref.current?.toggle()
  }), [])
}

export interface AppCommandOptions {
  commandPalette: CommandPaletteControls
  closeFolderPicker(): boolean
  toggleFolderPicker(): void
  gitWorkflow: ReturnType<typeof useGitWorkflow>
  keybindings: AppPreferences['keybindings']
  hasSnapshot: boolean
  settingsOpen: boolean
  setSettingsOpen: Dispatch<SetStateAction<boolean>>
  setPreferences: Dispatch<SetStateAction<AppPreferences>>
  toggleSidebar(): void
  toggleTerminal(): void
}

/**
 * One command table for the keyboard and the palette, so every command the
 * palette lists actually does something.
 */
export function useAppCommands({
  commandPalette,
  closeFolderPicker,
  toggleFolderPicker,
  gitWorkflow,
  keybindings,
  hasSnapshot,
  settingsOpen,
  setSettingsOpen,
  setPreferences,
  toggleSidebar,
  toggleTerminal
}: AppCommandOptions): (command: AppCommand) => void {
  const runCommand = useCallback((command: AppCommand) => {
    // While settings is modal only the two commands that manage overlays run —
    // the palette reaches this too, and everything else would act on inert UI.
    if (settingsOpen && command !== 'openSettings' && command !== 'openCommandPalette') return
    if (command === 'openSettings') {
      commandPalette.close()
      closeFolderPicker()
      setSettingsOpen(true)
    } else if (command === 'openCommandPalette') {
      closeFolderPicker()
      commandPalette.toggle()
    } else if (command === 'goToFile' || command === 'searchContent') {
      closeFolderPicker()
      commandPalette.open()
    } else if (command === 'openFolder') {
      toggleFolderPicker()
    } else if (command === 'toggleSidebar' && hasSnapshot) {
      toggleSidebar()
    } else if (command === 'toggleWordWrap') {
      setPreferences((current) => ({ ...current, wordWrap: !current.wordWrap }))
    } else if (command === 'toggleFoldUnchanged') {
      setPreferences((current) => ({ ...current, foldUnchanged: !current.foldUnchanged }))
    } else if (command === 'toggleTerminal' && hasSnapshot) {
      toggleTerminal()
    }
  }, [closeFolderPicker, commandPalette, hasSnapshot, setPreferences, setSettingsOpen, settingsOpen, toggleFolderPicker, toggleSidebar, toggleTerminal])

  useAppShortcuts({
    commandPaletteRef: commandPalette.ref,
    closeFolderPicker,
    gitWorkflow,
    keybindings,
    runCommand,
    settingsOpen
  })

  return runCommand
}

interface AppShortcutOptions {
  commandPaletteRef: RefObject<CommandPaletteHandle | null>
  closeFolderPicker(): boolean
  gitWorkflow: ReturnType<typeof useGitWorkflow>
  keybindings: AppPreferences['keybindings']
  runCommand(command: AppCommand): void
  settingsOpen: boolean
}

function useAppShortcuts({
  commandPaletteRef,
  closeFolderPicker,
  gitWorkflow,
  keybindings,
  runCommand,
  settingsOpen
}: AppShortcutOptions): void {
  const handleKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    // Leaf surfaces (comment drafts, find, open dialogs) preventDefault first.
    // Settings is a modal <dialog>: Escape reaches it as `cancel`, which runs its
    // own 160ms exit. Closing it from here would skip that.
    if (event.defaultPrevented || event.repeat) return
    if (event.key === 'Escape' && document.querySelector('dialog[open]') != null) return
    if (event.key === 'Escape' && closeFolderPicker()) {
      event.preventDefault()
      return
    }
    if (event.key === 'Escape' && commandPaletteRef.current?.close()) {
      event.preventDefault()
      return
    }
    if (event.key === 'Escape' && settingsOpen) return
    if (event.key === 'Escape' && gitWorkflow.panelOpen) {
      event.preventDefault()
      gitWorkflow.setPanelOpen(false)
      return
    }
    if (!settingsOpen && event.metaKey && !event.ctrlKey && !event.altKey) {
      if (!event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        gitWorkflow.openNewWorld()
        return
      }
      if (!event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        gitWorkflow.closeReview()
        return
      }
      if (event.shiftKey && (event.key === '[' || event.key === ']')) {
        event.preventDefault()
        gitWorkflow.cycleWorld(event.key === '[' ? -1 : 1)
        return
      }
    }
    const command = commandFromEvent(event, keybindings)
    if (command == null) return
    event.preventDefault()
    runCommand(command)
  })

  // Tab switching listens in the capture phase: the editor indents on Tab and
  // the terminal takes every key it sees, and either would otherwise swallow
  // ⌃Tab before it bubbled up here.
  const handleTabKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    if (settingsOpen || event.altKey) return
    if (event.ctrlKey && !event.metaKey && event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      gitWorkflow.cycleWorld(event.shiftKey ? -1 : 1)
      return
    }
    if (event.metaKey && !event.ctrlKey && !event.shiftKey && /^Digit[1-9]$/.test(event.code)) {
      event.preventDefault()
      event.stopPropagation()
      gitWorkflow.focusWorldAt(Number(event.code.slice(5)))
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keydown', handleTabKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keydown', handleTabKeyDown, { capture: true })
    }
  }, [])
}
