import { afterEach, describe, expect, it } from 'bun:test'

import { DEFAULT_KEYBINDINGS } from './keybindings'
import {
  EDITOR_THEMES,
  getEditorThemeType,
  KEYBINDINGS_VERSION,
  loadKeybindings,
  loadPreferences
} from './preferences'

afterEach(() => localStorage.clear())

describe('EDITOR_THEMES', () => {
  it('matches the Shiki allowlist shipped by the renderer build', () => {
    expect(Object.keys(EDITOR_THEMES).sort()).toEqual([
      'catppuccin-latte',
      'catppuccin-mocha',
      'github-dark',
      'github-dark-dimmed',
      'github-light',
      'light-plus',
      'nord',
      'pierre-dark',
      'pierre-dark-soft',
      'pierre-dark-vibrant',
      'pierre-light',
      'pierre-light-soft',
      'solarized-light',
      'tokyo-night',
      'vitesse-dark',
      'vitesse-light'
    ])
  })

  it('ships a concrete six-digit canvas on every seeded theme', () => {
    for (const info of Object.values(EDITOR_THEMES)) {
      if (info.palette == null) continue
      expect(info.palette.canvas).toMatch(/^#[0-9a-f]{6}$/i)
      expect(info.palette.text).toMatch(/^#[0-9a-f]{6}$/i)
      expect(info.palette.accent).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
})

describe('getEditorThemeType', () => {
  it('classifies bundled light and dark themes', () => {
    expect(getEditorThemeType('pierre-light')).toBe('light')
    expect(getEditorThemeType('light-plus')).toBe('light')
    expect(getEditorThemeType('pierre-dark-soft')).toBe('dark')
    // Names are not sniffed — latte/mocha classify from the table, not the suffix.
    expect(getEditorThemeType('catppuccin-latte')).toBe('light')
    expect(getEditorThemeType('catppuccin-mocha')).toBe('dark')
    expect(getEditorThemeType('solarized-light')).toBe('light')
    expect(getEditorThemeType('tokyo-night')).toBe('dark')
  })
})

describe('loadPreferences', () => {
  it('loads autosave and clamps terminal scrollback', () => {
    localStorage.setItem('kodi:preferences:v1', JSON.stringify({
      autosaveOnBlur: true,
      terminalScrollback: 100_000
    }))
    const preferences = loadPreferences()
    expect(preferences.autosaveOnBlur).toBe(true)
    expect(preferences.terminalScrollback).toBe(50_000)
  })

  it('accepts a stored theme from the allowlist and rejects anything else', () => {
    localStorage.setItem('kodi:preferences:v1', JSON.stringify({ editorTheme: 'tokyo-night' }))
    expect(loadPreferences().editorTheme).toBe('tokyo-night')
    localStorage.setItem('kodi:preferences:v1', JSON.stringify({ editorTheme: 'not-a-theme' }))
    expect(loadPreferences().editorTheme).toBe('pierre-dark')
  })

  it('keeps only clean repo slugs in the inbox scope', () => {
    expect(loadPreferences().inboxRepos).toEqual([])
    localStorage.setItem('kodi:preferences:v1', JSON.stringify({
      inboxRepos: ['Acme/Core', 'acme/core', 'garbage', 7]
    }))
    expect(loadPreferences().inboxRepos).toEqual(['acme/core'])
  })

  it('validates the accent choice and clamps the interface text scale', () => {
    localStorage.setItem('kodi:preferences:v1', JSON.stringify({
      accentColor: 'green',
      interfaceFontScale: 130
    }))
    let preferences = loadPreferences()
    expect(preferences.accentColor).toBe('green')
    expect(preferences.interfaceFontScale).toBe(110)
    localStorage.setItem('kodi:preferences:v1', JSON.stringify({ accentColor: 'chartreuse' }))
    expect(loadPreferences().accentColor).toBe('theme')
    localStorage.setItem('kodi:preferences:v1', JSON.stringify({ interfaceFontScale: 'big' }))
    preferences = loadPreferences()
    expect(preferences.interfaceFontScale).toBe(100)
  })
})

describe('loadKeybindings', () => {
  it('keeps a rebound shortcut', () => {
    expect(loadKeybindings({ toggleFoldUnchanged: 'Meta+Shift+KeyY' }, undefined).toggleFoldUnchanged)
      .toBe('Meta+Shift+KeyY')
  })

  it('migrates a saved copy of a retired default to the new default', () => {
    expect(loadKeybindings({ toggleFoldUnchanged: 'Meta+Alt+KeyF' }, undefined).toggleFoldUnchanged)
      .toBe(DEFAULT_KEYBINDINGS.toggleFoldUnchanged)
  })

  it('keeps ⌘⌥F once the migration has already run', () => {
    expect(loadKeybindings({ toggleFoldUnchanged: 'Meta+Alt+KeyF' }, KEYBINDINGS_VERSION).toggleFoldUnchanged)
      .toBe('Meta+Alt+KeyF')
  })

  it('falls back to the defaults when nothing was saved', () => {
    expect(loadKeybindings(undefined, undefined)).toEqual(DEFAULT_KEYBINDINGS)
  })
})
