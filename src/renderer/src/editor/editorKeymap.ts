import type { EditorCommand, EditorKeymap, EditorShortcut } from '@pierre/diffs/edit'

import type { AppCommand, KeybindingMap } from '../settings/keybindings'

export interface EditorShortcutHint {
  shortcut: EditorShortcut
  command: EditorCommand
  label: string
}

/**
 * The editor's built-in bindings, in the order the shortcut sheet shows them.
 * Mirrors the default keymap in `@pierre/diffs/dist/editor/command.js`; a
 * binding listed here is one the app must not silently steal while editing.
 */
export const EDITOR_SHORTCUTS: readonly EditorShortcutHint[] = [
  { shortcut: 'cmdOrCtrl+f', command: 'openSearchPanel', label: 'Find in file' },
  { shortcut: 'cmdOrCtrl+alt+f', command: 'openSearchReplacePanel', label: 'Find and replace' },
  { shortcut: 'cmdOrCtrl+d', command: 'findNextMatch', label: 'Select next match' },
  { shortcut: 'cmdOrCtrl+z', command: 'undo', label: 'Undo' },
  { shortcut: 'cmdOrCtrl+shift+z', command: 'redo', label: 'Redo' },
  { shortcut: 'cmdOrCtrl+/', command: 'toggleComment', label: 'Toggle line comment' },
  { shortcut: 'shift+alt+a', command: 'toggleBlockComment', label: 'Toggle block comment' },
  { shortcut: 'alt+ArrowUp', command: 'moveLineUp', label: 'Move line up' },
  { shortcut: 'alt+ArrowDown', command: 'moveLineDown', label: 'Move line down' },
  { shortcut: 'shift+alt+ArrowUp', command: 'copyLineUp', label: 'Copy line up' },
  { shortcut: 'shift+alt+ArrowDown', command: 'copyLineDown', label: 'Copy line down' },
  { shortcut: 'cmdOrCtrl+[', command: 'indentLess', label: 'Outdent' },
  { shortcut: 'cmdOrCtrl+]', command: 'indentMore', label: 'Indent' },
  { shortcut: 'cmdOrCtrl+Enter', command: 'insertBlankLine', label: 'Insert blank line below' },
  { shortcut: 'cmdOrCtrl+a', command: 'selectAll', label: 'Select all' },
  { shortcut: 'Escape', command: 'simplifySelection', label: 'Collapse selection' }
]

const KEY_CODE_SHORTCUT_KEYS: Readonly<Record<string, string>> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Quote: "'",
  Semicolon: ';',
  Space: 'Space'
}

/**
 * Translates one app keybinding (`Meta+Alt+KeyF`) into the editor's shortcut
 * spelling (`cmdOrCtrl+alt+f`) so the two keymaps can be compared at all.
 * Returns null for bindings the editor cannot express.
 */
export function toEditorShortcut(keybinding: string): EditorShortcut | null {
  const parts = keybinding.split('+')
  const code = parts.at(-1)
  if (code == null || code === '') return null
  const key = code.startsWith('Key')
    ? code.slice(3).toLowerCase()
    : code.startsWith('Digit')
      ? code.slice(5)
      : KEY_CODE_SHORTCUT_KEYS[code] ?? (code.length === 1 ? code.toLowerCase() : code)
  const modifiers: string[] = []
  if (parts.includes('Meta') || parts.includes('Control')) modifiers.push('cmdOrCtrl')
  if (parts.includes('Shift')) modifiers.push('shift')
  if (parts.includes('Alt')) modifiers.push('alt')
  if (modifiers.length > 2) return null
  return [...modifiers, key].join('+') as EditorShortcut
}

export interface KeymapConflict {
  command: AppCommand
  shortcut: EditorShortcut
  editorCommand: EditorCommand
}

/**
 * App commands whose binding lands on an editor shortcut. While the caret is in
 * the editor the editor wins, so Settings can warn instead of silently losing
 * one of the two.
 */
export function findEditorKeymapConflicts(keybindings: KeybindingMap): KeymapConflict[] {
  const conflicts: KeymapConflict[] = []
  for (const [command, binding] of Object.entries(keybindings) as Array<[AppCommand, string]>) {
    const shortcut = toEditorShortcut(binding)
    if (shortcut == null) continue
    const editorShortcut = EDITOR_SHORTCUTS.find((entry) => entry.shortcut === shortcut)
    if (editorShortcut == null) continue
    conflicts.push({ command, shortcut, editorCommand: editorShortcut.command })
  }
  return conflicts
}

/**
 * The editor keymap the app installs. Every default binding is restated so a
 * later group cannot be shadowed by a user rebinding an app command onto it:
 * while the editor has focus its own command always wins.
 */
export function buildEditorKeymap(): EditorKeymap {
  const bindings: Partial<Record<EditorShortcut, EditorCommand>> = {}
  for (const { shortcut, command } of EDITOR_SHORTCUTS) bindings[shortcut] = command
  return [{ bindings }]
}

export function formatEditorShortcut(shortcut: EditorShortcut): string {
  const parts = shortcut.split('+')
  const key = parts.at(-1) ?? ''
  return [
    parts.includes('ctrl') ? '⌃' : '',
    parts.includes('alt') ? '⌥' : '',
    parts.includes('shift') ? '⇧' : '',
    parts.includes('cmdOrCtrl') || parts.includes('cmd') ? '⌘' : '',
    key === 'ArrowUp' ? '↑' : key === 'ArrowDown' ? '↓' : key.length === 1 ? key.toUpperCase() : key
  ].join('')
}
