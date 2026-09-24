import type { ITheme } from '@xterm/xterm'

import {
  ACCENT_COLORS,
  EDITOR_THEMES,
  getEditorThemeType,
  type AccentColor,
  type EditorTheme,
  type EditorThemeType,
  type ThemePaletteSeed
} from './preferences'

// The app palettes that themes without a `palette` seed keep. Values mirror the
// :root and [data-theme-type="light"] blocks in styles.css.
const BASE_SEEDS: Record<EditorThemeType, ThemePaletteSeed> = {
  dark: { canvas: '#0c0d0f', text: '#e7e8eb', accent: '#78a9ff' },
  light: { canvas: '#f7f8fa', text: '#1c1e23', accent: '#276bd6' }
}

/** The seed a theme resolves to — its own palette, else the app's base one. */
export function themeSeed(theme: EditorTheme): ThemePaletteSeed {
  return EDITOR_THEMES[theme].palette ?? BASE_SEEDS[EDITOR_THEMES[theme].type]
}

/**
 * The color main paints the window with and the boot page uses before React
 * mounts. Always concrete — never a var() — because it crosses IPC and lands
 * in index.html's pre-stylesheet paint.
 */
export function themeCanvas(theme: EditorTheme): string {
  return themeSeed(theme).canvas
}

function parseHex(value: string, backdrop = '#000000'): [number, number, number] {
  let hex = value.startsWith('#') ? value.slice(1) : value
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('')
  if (hex.length === 8) {
    // Composite the alpha over a backdrop so seeds with transparency
    // (some Shiki themes ship #rrggbbaa) still produce solid chrome colors.
    const alpha = Number.parseInt(hex.slice(6, 8), 16) / 255
    const over = parseHex(backdrop)
    return [0, 1, 2].map((channel) => {
      const value = Number.parseInt(hex.slice(channel * 2, channel * 2 + 2), 16)
      return Math.round(value * alpha + (over[channel] ?? 0) * (1 - alpha))
    }) as [number, number, number]
  }
  return [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`
}

/** `weight` is how much of `to` lands in the result: 0 keeps `from`, 1 is `to`. */
export function mixHex(from: string, to: string, weight: number, backdrop?: string): string {
  const a = parseHex(from, backdrop)
  const b = parseHex(to, backdrop)
  return toHex(a[0] + (b[0] - a[0]) * weight, a[1] + (b[1] - a[1]) * weight, a[2] + (b[2] - a[2]) * weight)
}

/** Real alpha for layered colors (borders, tints) where a solid hex would band. */
function hexAlpha(value: string, alpha: number, backdrop?: string): string {
  const [r, g, b] = parseHex(value, backdrop)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface DerivedPalette {
  canvas: string
  panel: string
  panelSubtle: string
  surface: string
  surfaceInput: string
  surfaceHover: string
  surfaceSelected: string
  titlebar: string
  popover: string
  floatingSurface: string
  text: string
  textSecondary: string
  muted: string
  faint: string
  accent: string
  accentSoft: string
  accentContrast: string
  pathText: string
  avatarFill: string
  avatarText: string
  focus: string
  selection: string
}

/**
 * Dark themes raise surfaces toward the text color; light themes raise them
 * toward white. One recipe, two directions — the derived tokens keep the same
 * relative steps the hand-tuned base palettes use.
 */
function derivePalette(seed: ThemePaletteSeed, type: EditorThemeType): DerivedPalette {
  const { canvas, text, accent } = seed
  const raised = type === 'dark' ? text : '#ffffff'
  return {
    canvas,
    panel: mixHex(canvas, raised, type === 'dark' ? 0.05 : 0.62),
    panelSubtle: type === 'dark' ? mixHex(canvas, text, 0.07) : mixHex(canvas, text, 0.045),
    surface: mixHex(canvas, raised, type === 'dark' ? 0.09 : 0.85),
    surfaceInput: type === 'dark' ? mixHex(canvas, '#000000', 0.22) : mixHex(canvas, '#ffffff', 0.85),
    surfaceHover: mixHex(canvas, text, type === 'dark' ? 0.12 : 0.05),
    surfaceSelected: mixHex(canvas, accent, type === 'dark' ? 0.17 : 0.12),
    titlebar: type === 'dark' ? mixHex(canvas, text, 0.05) : mixHex(canvas, '#ffffff', 0.5),
    popover: mixHex(canvas, raised, type === 'dark' ? 0.14 : 0.92),
    floatingSurface: mixHex(canvas, raised, type === 'dark' ? 0.12 : 0.95),
    text,
    textSecondary: mixHex(text, canvas, 0.25),
    muted: mixHex(text, canvas, 0.42),
    faint: mixHex(text, canvas, 0.52),
    accent,
    accentSoft: hexAlpha(accent, type === 'dark' ? 0.13 : 0.11),
    accentContrast: type === 'dark' ? canvas : '#ffffff',
    pathText: type === 'dark' ? mixHex(accent, text, 0.28) : mixHex(accent, '#000000', 0.14),
    avatarFill: mixHex(accent, canvas, type === 'dark' ? 0.78 : 0.85),
    avatarText: type === 'dark' ? mixHex(accent, text, 0.38) : mixHex(accent, '#000000', 0.3),
    focus: hexAlpha(accent, type === 'dark' ? 0.85 : 0.72),
    selection: mixHex(accent, canvas, type === 'dark' ? 0.62 : 0.75)
  }
}

const SHELL_VAR_MAP: ReadonlyArray<[keyof DerivedPalette, string]> = [
  ['canvas', '--canvas'],
  ['panel', '--panel'],
  ['panelSubtle', '--panel-subtle'],
  ['surface', '--surface'],
  ['surfaceInput', '--surface-input'],
  ['surfaceHover', '--surface-hover'],
  ['surfaceSelected', '--surface-selected'],
  ['titlebar', '--titlebar'],
  ['popover', '--popover'],
  ['floatingSurface', '--floating-surface'],
  ['text', '--text'],
  ['textSecondary', '--text-secondary'],
  ['muted', '--muted'],
  ['faint', '--faint'],
  ['accent', '--accent'],
  ['accentSoft', '--accent-soft'],
  ['accentContrast', '--accent-contrast'],
  ['pathText', '--path-text'],
  ['avatarFill', '--avatar-fill'],
  ['avatarText', '--avatar-text'],
  ['focus', '--focus']
]

const paletteVarsCache = new Map<EditorTheme, Record<string, string> | null>()

/**
 * Inline `--*` overrides for `.app-shell`. Themes without a palette return
 * null and keep the stylesheet defaults. The vars sit on the shell element so
 * they win over the `[data-theme-type]` blocks; type-level tokens those blocks
 * set (alpha fills, scrim, elevation, status hues) stay in charge.
 */
export function themePaletteVars(theme: EditorTheme): Record<string, string> | null {
  if (paletteVarsCache.has(theme)) return paletteVarsCache.get(theme) ?? null
  const info = EDITOR_THEMES[theme]
  const palette = info.palette == null ? null : derivePalette(info.palette, info.type)
  const vars = palette == null
    ? null
    : Object.fromEntries(SHELL_VAR_MAP.map(([key, cssVar]) => [cssVar, palette[key]]))
  paletteVarsCache.set(theme, vars)
  return vars
}

/**
 * The accent override row in Settings. `theme` returns nothing so the active
 * palette's own accent wins; any other choice repaints accent-derived tokens.
 */
export function accentVars(choice: AccentColor, theme: EditorTheme): Record<string, string> {
  if (choice === 'theme') return {}
  const type = getEditorThemeType(theme)
  const seed = themeSeed(theme)
  const accent = ACCENT_COLORS[choice][type]
  return {
    '--accent': accent,
    '--accent-soft': hexAlpha(accent, type === 'dark' ? 0.13 : 0.11),
    '--accent-contrast': type === 'dark' ? seed.canvas : '#ffffff',
    '--focus': hexAlpha(accent, type === 'dark' ? 0.85 : 0.72),
    '--path-text': type === 'dark' ? mixHex(accent, seed.text, 0.28) : mixHex(accent, '#000000', 0.14)
  }
}

/** The effective accent for the current theme — what the "Theme" swatch shows. */
export function effectiveAccent(choice: AccentColor, theme: EditorTheme): string {
  if (choice === 'theme') return themeSeed(theme).accent
  return ACCENT_COLORS[choice][getEditorThemeType(theme)]
}

/**
 * The four colors the Settings theme card previews. Seeded themes preview
 * their real chrome; pierre themes return null and keep the stylesheet's
 * neutral previews.
 */
export function themeCardVars(theme: EditorTheme): Record<string, string> | null {
  const info = EDITOR_THEMES[theme]
  if (info.palette == null) return null
  const palette = derivePalette(info.palette, info.type)
  return {
    '--theme-card-bg': palette.canvas,
    '--theme-card-panel': palette.panelSubtle,
    '--theme-card-line': palette.faint,
    '--theme-card-accent': palette.accent
  }
}

const ANSI_COLORS: Record<EditorThemeType, Pick<ITheme,
  'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white' |
  'brightBlack' | 'brightRed' | 'brightGreen' | 'brightYellow' | 'brightBlue' | 'brightMagenta' | 'brightCyan' | 'brightWhite'>> = {
  dark: {
    black: '#24262b', red: '#ef8582', green: '#65d3a8', yellow: '#dfc369',
    blue: '#78a9ff', magenta: '#c49aee', cyan: '#78c5e6', white: '#d9dbe0',
    brightBlack: '#797d86', brightRed: '#ff9b98', brightGreen: '#80e8bd', brightYellow: '#f0d780',
    brightBlue: '#9bc1ff', brightMagenta: '#d8b5fa', brightCyan: '#92daf5', brightWhite: '#ffffff'
  },
  light: {
    black: '#24272d', red: '#b42318', green: '#16734f', yellow: '#805b10',
    blue: '#276bd6', magenta: '#7542a6', cyan: '#176783', white: '#e7e8eb',
    brightBlack: '#707681', brightRed: '#d92d20', brightGreen: '#1f9d6a', brightYellow: '#a87616',
    brightBlue: '#175cd3', brightMagenta: '#9b51d0', brightCyan: '#168aad', brightWhite: '#ffffff'
  }
}

const DEFAULT_TERMINAL: Record<EditorThemeType, ITheme> = {
  dark: {
    background: '#0d0e10', foreground: '#d9dbe0', cursor: '#78a9ff', cursorAccent: '#0d0e10',
    selectionBackground: '#29466f', selectionInactiveBackground: '#243247', ...ANSI_COLORS.dark
  },
  light: {
    background: '#ffffff', foreground: '#34373e', cursor: '#276bd6', cursorAccent: '#ffffff',
    selectionBackground: '#b8d2f5', selectionInactiveBackground: '#d8e4f3', ...ANSI_COLORS.light
  }
}

const terminalThemeCache = new Map<EditorTheme, ITheme>()

/** xterm wants concrete colors — same derivation, solid hexes out. */
export function terminalThemeFor(theme: EditorTheme): ITheme {
  const cached = terminalThemeCache.get(theme)
  if (cached != null) return cached
  const info = EDITOR_THEMES[theme]
  if (info.palette == null) {
    const fallback = DEFAULT_TERMINAL[info.type]
    terminalThemeCache.set(theme, fallback)
    return fallback
  }
  const palette = derivePalette(info.palette, info.type)
  const resolved: ITheme = {
    background: palette.canvas,
    foreground: mixHex(palette.text, palette.canvas, 0.08),
    cursor: palette.accent,
    cursorAccent: palette.canvas,
    selectionBackground: palette.selection,
    selectionInactiveBackground: mixHex(palette.selection, palette.canvas, 0.45),
    ...ANSI_COLORS[info.type]
  }
  terminalThemeCache.set(theme, resolved)
  return resolved
}
