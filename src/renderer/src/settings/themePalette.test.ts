import { describe, expect, it } from 'bun:test'

import {
  accentVars,
  effectiveAccent,
  mixHex,
  terminalThemeFor,
  themeCanvas,
  themeCardVars,
  themePaletteVars,
} from './themePalette'

describe('mixHex', () => {
  it('keeps the endpoints at weight 0 and 1', () => {
    expect(mixHex('#1a1b26', '#a9b1d6', 0)).toBe('#1a1b26')
    expect(mixHex('#1a1b26', '#a9b1d6', 1)).toBe('#a9b1d6')
  })

  it('lands on the midpoint', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('composites eight-digit colors over the backdrop instead of dropping alpha', () => {
    // 50%-opaque white over black composites to #808080; treating the alpha as
    // an extra channel would produce #ffffff80 or corrupt the channel split.
    expect(mixHex('#ffffff80', '#ffffff80', 0, '#000000')).toBe('#808080')
  })
})

describe('themeCanvas', () => {
  it('returns the theme canvas for seeded themes and the app base for pierre themes', () => {
    expect(themeCanvas('tokyo-night')).toBe('#1a1b26')
    expect(themeCanvas('solarized-light')).toBe('#fdf6e3')
    expect(themeCanvas('pierre-dark')).toBe('#0c0d0f')
    expect(themeCanvas('pierre-light')).toBe('#f7f8fa')
  })
})

describe('themePaletteVars', () => {
  it('returns null for pierre themes so the stylesheet defaults stay in charge', () => {
    expect(themePaletteVars('pierre-dark')).toBeNull()
    expect(themePaletteVars('pierre-dark-vibrant')).toBeNull()
    expect(themePaletteVars('pierre-light-soft')).toBeNull()
  })

  it('emits the shell token set from the seed for themed palettes', () => {
    const vars = themePaletteVars('catppuccin-mocha')
    expect(vars?.['--canvas']).toBe('#1e1e2e')
    expect(vars?.['--text']).toBe('#cdd6f4')
    expect(vars?.['--accent']).toBe('#89b4fa')
    for (const token of ['--surface', '--muted', '--panel', '--focus', '--floating-surface']) {
      expect(vars?.[token]).toBeDefined()
    }
  })
})

describe('accentVars', () => {
  it('leaves the theme accent alone for the theme choice', () => {
    expect(accentVars('theme', 'tokyo-night')).toEqual({})
  })

  it('repaints accent-derived tokens for an explicit choice', () => {
    const vars = accentVars('green', 'tokyo-night')
    expect(vars['--accent']).toBe('#56d364')
    expect(vars['--accent-soft']).toMatch(/^rgba\(/)
    // The contrast token follows the theme's canvas, not a global constant.
    expect(vars['--accent-contrast']).toBe('#1a1b26')
  })
})

describe('effectiveAccent', () => {
  it('reads the theme signature for the theme choice', () => {
    expect(effectiveAccent('theme', 'nord')).toBe('#88c0d0')
    expect(effectiveAccent('theme', 'pierre-dark')).toBe('#78a9ff')
  })
})

describe('terminalThemeFor', () => {
  it('falls back to the type defaults for palette-less themes', () => {
    expect(terminalThemeFor('pierre-dark').background).toBe('#0d0e10')
    expect(terminalThemeFor('pierre-light').background).toBe('#ffffff')
  })

  it('derives canvas, cursor, and selection from the seed', () => {
    const theme = terminalThemeFor('nord')
    expect(theme.background).toBe('#2e3440')
    expect(theme.cursor).toBe('#88c0d0')
    expect(theme.cursorAccent).toBe('#2e3440')
    expect(theme.selectionBackground).toMatch(/^#[0-9a-f]{6}$/)
    // ANSI colors stay on the type-level set — per-theme terminal palettes are
    // a deliberate non-goal of the seed model.
    expect(theme.red).toBeDefined()
  })
})

describe('themeCardVars', () => {
  it('returns null for pierre themes and real colors for seeded ones', () => {
    expect(themeCardVars('pierre-dark')).toBeNull()
    const vars = themeCardVars('tokyo-night')
    expect(vars?.['--theme-card-bg']).toBe('#1a1b26')
    expect(vars?.['--theme-card-accent']).toBe('#7aa2f7')
  })
})
