import { describe, expect, it, test } from 'bun:test'

import {
  DEFAULT_KEYBINDINGS,
  commandFromEvent,
  findKeybindingConflicts,
  formatTerminalToggleShortcut,
  isTerminalToggleShortcut,
  reviewCommandFromEvent,
  formatKeybinding,
  keybindingFromEvent
} from './keybindings'

function keyboardEvent(code: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers } as KeyboardEvent
}

describe('keybindings', () => {
  test('normalizes and matches macOS shortcuts', () => {
    const event = keyboardEvent('KeyB', { metaKey: true })
    expect(keybindingFromEvent(event)).toBe('Meta+KeyB')
    expect(commandFromEvent(event, DEFAULT_KEYBINDINGS)).toBe('toggleSidebar')
    expect(formatKeybinding('Meta+Shift+KeyF')).toBe('⇧⌘F')
    expect(commandFromEvent(keyboardEvent('KeyK', { metaKey: true }), DEFAULT_KEYBINDINGS)).toBe('openCommandPalette')
    expect(commandFromEvent(keyboardEvent('KeyJ', { metaKey: true }), DEFAULT_KEYBINDINGS)).toBe('toggleTerminal')
    expect(commandFromEvent(keyboardEvent('KeyF', { metaKey: true, shiftKey: true }), DEFAULT_KEYBINDINGS)).toBe('searchContent')
    expect(commandFromEvent(keyboardEvent('KeyG', { metaKey: true, shiftKey: true }), DEFAULT_KEYBINDINGS)).toBe('toggleReviewGuide')
    expect(commandFromEvent(keyboardEvent('KeyO', { metaKey: true, shiftKey: true }), DEFAULT_KEYBINDINGS)).toBe('openInEditor')
    expect(commandFromEvent(keyboardEvent('KeyO', { metaKey: true }), DEFAULT_KEYBINDINGS)).toBe('openFolder')
    expect(isTerminalToggleShortcut(keyboardEvent('KeyJ', { metaKey: true }), DEFAULT_KEYBINDINGS)).toBe(true)
    expect(isTerminalToggleShortcut(keyboardEvent('KeyJ', { ctrlKey: true }), DEFAULT_KEYBINDINGS)).toBe(true)
    expect(isTerminalToggleShortcut(keyboardEvent('Backquote', { ctrlKey: true }), DEFAULT_KEYBINDINGS)).toBe(false)
    expect(formatTerminalToggleShortcut()).toBe('⌃J / ⌘J')
  })

  test('keeps a custom terminal shortcut available alongside Ctrl+J and Command+J', () => {
    const keybindings = { ...DEFAULT_KEYBINDINGS, toggleTerminal: 'Alt+KeyT' }
    expect(isTerminalToggleShortcut(keyboardEvent('KeyT', { altKey: true }), keybindings)).toBe(true)
  })

  test('rejects unmodified typing keys', () => {
    expect(keybindingFromEvent(keyboardEvent('KeyB'))).toBeNull()
  })

  test('reports both commands that share a shortcut', () => {
    const conflicts = findKeybindingConflicts({
      ...DEFAULT_KEYBINDINGS,
      openFolder: DEFAULT_KEYBINDINGS.toggleSidebar
    })
    expect(conflicts).toEqual(new Set(['openFolder', 'toggleSidebar']))
  })

  test('the same chord written in another modifier order is a conflict', () => {
    const conflicts = findKeybindingConflicts({
      ...DEFAULT_KEYBINDINGS,
      openFolder: 'Shift+Meta+KeyG'
    })
    expect(conflicts.has('openFolder')).toBe(true)
    expect(conflicts.has('toggleReviewGuide')).toBe(true)
  })

  test('skips non-Meta bindings while typing', () => {
    const textarea = { tagName: 'TEXTAREA', isContentEditable: false } as unknown as Element
    expect(commandFromEvent(keyboardEvent('KeyZ', { altKey: true }), DEFAULT_KEYBINDINGS, textarea)).toBeNull()
    expect(commandFromEvent(keyboardEvent('KeyO', { metaKey: true }), DEFAULT_KEYBINDINGS, textarea)).toBe('openFolder')
  })

  test('warns when a command is rebound onto the reserved terminal shortcuts', () => {
    const conflicts = findKeybindingConflicts({
      ...DEFAULT_KEYBINDINGS,
      toggleWordWrap: 'Meta+KeyJ'
    })
    expect(conflicts.has('toggleWordWrap')).toBe(true)
  })
})

describe('reviewCommandFromEvent', () => {
  const event = (code: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent =>
    ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...modifiers }) as KeyboardEvent

  it('maps the review shortcut keys', () => {
    expect(reviewCommandFromEvent(event('BracketRight'), null)).toBe('nextReviewFile')
    expect(reviewCommandFromEvent(event('BracketLeft'), null)).toBe('previousReviewFile')
    expect(reviewCommandFromEvent(event('KeyV'), null)).toBe('toggleReviewViewed')
    expect(reviewCommandFromEvent(event('KeyC'), null)).toBe('toggleReviewCollapsed')
  })

  it('ignores unmapped keys and modified presses', () => {
    expect(reviewCommandFromEvent(event('KeyX'), null)).toBeNull()
    expect(reviewCommandFromEvent(event('KeyC', { metaKey: true }), null)).toBeNull()
    expect(reviewCommandFromEvent(event('KeyV', { shiftKey: true }), null)).toBeNull()
    expect(reviewCommandFromEvent(event('KeyC', { altKey: true }), null)).toBeNull()
  })

  it('maps shifted brackets to the guide\'s sections, keeping plain brackets on files', () => {
    expect(reviewCommandFromEvent(event('BracketRight', { shiftKey: true }), null)).toBe('nextGuideSection')
    expect(reviewCommandFromEvent(event('BracketLeft', { shiftKey: true }), null)).toBe('previousGuideSection')
    expect(reviewCommandFromEvent(event('BracketRight'), null)).toBe('nextReviewFile')
  })

  it('yields to typing surfaces', () => {
    const textarea = { tagName: 'TEXTAREA', isContentEditable: false } as unknown as Element
    const input = { tagName: 'INPUT', isContentEditable: false } as unknown as Element
    const editable = { tagName: 'DIV', isContentEditable: true } as unknown as Element
    const button = { tagName: 'BUTTON', isContentEditable: false } as unknown as Element
    expect(reviewCommandFromEvent(event('KeyV'), textarea)).toBeNull()
    expect(reviewCommandFromEvent(event('KeyV'), input)).toBeNull()
    expect(reviewCommandFromEvent(event('KeyV'), editable)).toBeNull()
    expect(reviewCommandFromEvent(event('KeyV'), button)).toBe('toggleReviewViewed')
  })
})
