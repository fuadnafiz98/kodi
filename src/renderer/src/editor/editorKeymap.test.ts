import { describe, expect, test } from 'bun:test'

import { DEFAULT_KEYBINDINGS } from '../settings/keybindings'
import {
  buildEditorKeymap,
  EDITOR_SHORTCUTS,
  findEditorKeymapConflicts,
  formatEditorShortcut,
  toEditorShortcut
} from './editorKeymap'

describe('toEditorShortcut', () => {
  test('translates the app spelling into the editor spelling', () => {
    expect(toEditorShortcut('Meta+KeyF')).toBe('cmdOrCtrl+f')
    expect(toEditorShortcut('Meta+Alt+KeyF')).toBe('cmdOrCtrl+alt+f')
    expect(toEditorShortcut('Meta+Shift+KeyM')).toBe('cmdOrCtrl+shift+m')
    expect(toEditorShortcut('Meta+Comma')).toBe('cmdOrCtrl+,')
    expect(toEditorShortcut('Alt+KeyZ')).toBe('alt+z')
  })

  test('rejects bindings the editor keymap cannot express', () => {
    expect(toEditorShortcut('')).toBeNull()
    expect(toEditorShortcut('Control+Alt+Shift+Meta+KeyF')).toBeNull()
  })
})

describe('findEditorKeymapConflicts', () => {
  test('the shipped defaults stay clear of the editor keymap', () => {
    expect(findEditorKeymapConflicts(DEFAULT_KEYBINDINGS)).toEqual([])
  })

  test('reports a rebinding onto find-and-replace', () => {
    const conflicts = findEditorKeymapConflicts({ ...DEFAULT_KEYBINDINGS, toggleFoldUnchanged: 'Meta+Alt+KeyF' })
    expect(conflicts).toContainEqual({
      command: 'toggleFoldUnchanged',
      shortcut: 'cmdOrCtrl+alt+f',
      editorCommand: 'openSearchReplacePanel'
    })
  })

  test('reports a rebinding onto an editor shortcut', () => {
    const conflicts = findEditorKeymapConflicts({ ...DEFAULT_KEYBINDINGS, toggleSidebar: 'Meta+KeyD' })
    expect(conflicts.map((conflict) => conflict.command)).toContain('toggleSidebar')
  })

  test('finds nothing when every binding avoids the editor keymap', () => {
    const safe = Object.fromEntries(
      Object.keys(DEFAULT_KEYBINDINGS).map((command) => [command, 'Meta+Shift+KeyQ'])
    ) as typeof DEFAULT_KEYBINDINGS
    expect(findEditorKeymapConflicts(safe)).toEqual([])
  })
})

describe('buildEditorKeymap', () => {
  test('installs one group covering every advertised shortcut', () => {
    const keymap = buildEditorKeymap()
    expect(keymap).toHaveLength(1)
    const bindings = keymap[0]?.bindings ?? {}
    for (const { shortcut, command } of EDITOR_SHORTCUTS) {
      expect(bindings[shortcut]).toBe(command)
    }
  })
})

describe('formatEditorShortcut', () => {
  test('uses the platform modifier order', () => {
    expect(formatEditorShortcut('cmdOrCtrl+f')).toBe('⌘F')
    expect(formatEditorShortcut('cmdOrCtrl+alt+f')).toBe('⌥⌘F')
    expect(formatEditorShortcut('shift+alt+ArrowUp')).toBe('⌥⇧↑')
    expect(formatEditorShortcut('Escape')).toBe('Escape')
  })
})
