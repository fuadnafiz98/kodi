import { expect, test } from 'bun:test'

import { AttachedThemes, hasResolvedThemes, type ThemeRegistrationResolved } from '@pierre/diffs'

import { rememberStartupTheme, seedStartupTheme } from './startupTheme'

// The bundler substitutes this.
;(globalThis as { __KODI_THEME_PACKAGES__?: string }).__KODI_THEME_PACKAGES__ = '1|2|3'

function theme(name: string): ThemeRegistrationResolved {
  return { name, type: 'dark', fg: '#ffffff', bg: '#000000', settings: [], colors: {} } as unknown as ThemeRegistrationResolved
}

test('a launch seeds the theme the last one resolved, without marking it attached', () => {
  localStorage.clear()
  expect(seedStartupTheme('vesper')).toBe(false)

  rememberStartupTheme(theme('vesper'))
  expect(seedStartupTheme('vesper')).toBe(true)
  expect(hasResolvedThemes(['vesper'])).toBe(true)
  // The real highlighter still has to load it.
  expect(AttachedThemes.has('vesper')).toBe(false)
})

test('another theme or another package version is not seeded', () => {
  localStorage.clear()
  rememberStartupTheme(theme('poimandres'))
  expect(seedStartupTheme('houston')).toBe(false)

  const stored = JSON.parse(localStorage.getItem('kodi:startup-theme:v1') ?? '{}') as { packages: string }
  localStorage.setItem('kodi:startup-theme:v1', JSON.stringify({ ...stored, packages: '0|2|3' }))
  expect(seedStartupTheme('poimandres')).toBe(false)
  expect(hasResolvedThemes(['poimandres'])).toBe(false)
})
