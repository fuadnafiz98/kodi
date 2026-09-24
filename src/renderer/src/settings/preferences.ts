import { EDITOR_THEMES, type EditorTheme } from '../../../shared/editorThemes'
import { normalizeInboxRepos } from '../../../shared/inboxRepos'
import { DEFAULT_KEYBINDINGS, type KeybindingMap } from './keybindings'

export { EDITOR_THEMES, EDITOR_THEME_GROUPS, getEditorThemeType } from '../../../shared/editorThemes'
export type { EditorTheme, EditorThemeInfo, EditorThemeType, ThemePaletteSeed } from '../../../shared/editorThemes'

export type CodeFont = 'fira-code' | 'sf-mono' | 'menlo' | 'monaco'
export type InterfaceFont = 'inter' | 'system'
export type AccentColor = 'theme' | 'blue' | 'purple' | 'pink' | 'orange' | 'green' | 'graphite'

export interface AppPreferences {
  codeFont: CodeFont
  codeFontSize: number
  codeLineHeight: number
  editorTheme: EditorTheme
  accentColor: AccentColor
  interfaceFont: InterfaceFont
  interfaceFontScale: number
  showLineNumbers: boolean
  wordWrap: boolean
  foldUnchanged: boolean
  autosaveOnBlur: boolean
  terminalScrollback: number
  restoreLastFolder: boolean
  // `owner/name` slugs that scope the welcome-screen pull-request inbox; empty
  // asks GitHub for everything the viewer can see.
  inboxRepos: string[]
  keybindings: KeybindingMap
  // Bumped when a default shortcut is retired, so the migration that drops the
  // old default from storage runs once instead of on every load.
  keybindingsVersion: number
  // Bumped when a default setting changes, so a profile saved under the old
  // default adopts the new one once and keeps any choice made after that.
  defaultsVersion: number
}

export const KEYBINDINGS_VERSION = 2
/** 1: word wrap became the default. */
export const DEFAULTS_VERSION = 1

export const CODE_FONTS: Record<CodeFont, { label: string; fontFamily: string }> = {
  'fira-code': {
    label: 'Fira Code',
    fontFamily: '"Fira Code Variable", "Fira Code", monospace'
  },
  'sf-mono': {
    label: 'SF Mono',
    fontFamily: '"SF Mono", ui-monospace, monospace'
  },
  menlo: {
    label: 'Menlo',
    fontFamily: 'Menlo, ui-monospace, monospace'
  },
  monaco: {
    label: 'Monaco',
    fontFamily: 'Monaco, ui-monospace, monospace'
  }
}

export const INTERFACE_FONTS: Record<InterfaceFont, { label: string; fontFamily: string }> = {
  inter: {
    label: 'Inter',
    fontFamily: '"Inter Variable", Inter, ui-sans-serif, -apple-system, sans-serif'
  },
  system: {
    label: 'System',
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif'
  }
}

/** Accent presets; `theme` defers to whatever the active editor theme ships. */
export const ACCENT_COLORS: Record<Exclude<AccentColor, 'theme'>, { label: string; dark: string; light: string }> = {
  blue: { label: 'Blue', dark: '#78a9ff', light: '#276bd6' },
  purple: { label: 'Purple', dark: '#b79aff', light: '#7656c9' },
  pink: { label: 'Pink', dark: '#f299c8', light: '#d6336c' },
  orange: { label: 'Orange', dark: '#f0a868', light: '#c2571c' },
  green: { label: 'Green', dark: '#56d364', light: '#1a7f37' },
  graphite: { label: 'Graphite', dark: '#c8ccd4', light: '#4c515b' }
}

export const DEFAULT_PREFERENCES: AppPreferences = {
  codeFont: 'fira-code',
  codeFontSize: 13,
  codeLineHeight: 20,
  editorTheme: 'pierre-dark',
  accentColor: 'theme',
  interfaceFont: 'inter',
  interfaceFontScale: 100,
  showLineNumbers: true,
  wordWrap: true,
  foldUnchanged: true,
  autosaveOnBlur: false,
  terminalScrollback: 5_000,
  restoreLastFolder: true,
  inboxRepos: [],
  keybindings: DEFAULT_KEYBINDINGS,
  keybindingsVersion: KEYBINDINGS_VERSION,
  defaultsVersion: DEFAULTS_VERSION
}

const STORAGE_KEY = 'kodi:preferences:v1'

export function loadPreferences(): AppPreferences {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored == null) return DEFAULT_PREFERENCES
    const parsed = JSON.parse(stored) as Partial<AppPreferences>
    const savedUnderOldDefaults = (parsed.defaultsVersion ?? 0) < DEFAULTS_VERSION
    return {
      codeFont: parsed.codeFont != null && Object.hasOwn(CODE_FONTS, parsed.codeFont)
        ? parsed.codeFont
        : DEFAULT_PREFERENCES.codeFont,
      codeFontSize: clampNumber(parsed.codeFontSize, 10, 20, DEFAULT_PREFERENCES.codeFontSize),
      codeLineHeight: clampNumber(parsed.codeLineHeight, 16, 32, DEFAULT_PREFERENCES.codeLineHeight),
      editorTheme: parsed.editorTheme != null && Object.hasOwn(EDITOR_THEMES, parsed.editorTheme)
        ? parsed.editorTheme
        : DEFAULT_PREFERENCES.editorTheme,
      accentColor: parsed.accentColor === 'theme' || (parsed.accentColor != null && Object.hasOwn(ACCENT_COLORS, parsed.accentColor))
        ? parsed.accentColor
        : DEFAULT_PREFERENCES.accentColor,
      interfaceFont: parsed.interfaceFont != null && Object.hasOwn(INTERFACE_FONTS, parsed.interfaceFont)
        ? parsed.interfaceFont
        : DEFAULT_PREFERENCES.interfaceFont,
      interfaceFontScale: clampNumber(parsed.interfaceFontScale, 90, 110, DEFAULT_PREFERENCES.interfaceFontScale),
      showLineNumbers: typeof parsed.showLineNumbers === 'boolean'
        ? parsed.showLineNumbers
        : DEFAULT_PREFERENCES.showLineNumbers,
      wordWrap: typeof parsed.wordWrap === 'boolean' && !savedUnderOldDefaults ? parsed.wordWrap : DEFAULT_PREFERENCES.wordWrap,
      foldUnchanged: typeof parsed.foldUnchanged === 'boolean' ? parsed.foldUnchanged : DEFAULT_PREFERENCES.foldUnchanged,
      autosaveOnBlur: typeof parsed.autosaveOnBlur === 'boolean'
        ? parsed.autosaveOnBlur
        : DEFAULT_PREFERENCES.autosaveOnBlur,
      terminalScrollback: clampNumber(
        parsed.terminalScrollback,
        1_000,
        50_000,
        DEFAULT_PREFERENCES.terminalScrollback
      ),
      restoreLastFolder: typeof parsed.restoreLastFolder === 'boolean'
        ? parsed.restoreLastFolder
        : DEFAULT_PREFERENCES.restoreLastFolder,
      inboxRepos: normalizeInboxRepos(parsed.inboxRepos),
      keybindings: loadKeybindings(parsed.keybindings, parsed.keybindingsVersion),
      keybindingsVersion: KEYBINDINGS_VERSION,
      defaultsVersion: DEFAULTS_VERSION
    }
  } catch {
    return DEFAULT_PREFERENCES
  }
}

// ⌘⌥F now belongs to the editor's find-in-selection, so the fold shortcut moved
// to ⌘⌥U. Anyone who never rebound it kept the old default in localStorage.
const RETIRED_DEFAULT_KEYBINDINGS: Partial<Record<keyof KeybindingMap, string>> = {
  toggleFoldUnchanged: 'Meta+Alt+KeyF'
}

export function loadKeybindings(
  value: Partial<KeybindingMap> | undefined,
  savedVersion: number | undefined
): KeybindingMap {
  if (value == null || typeof value !== 'object') return DEFAULT_KEYBINDINGS
  // The retired defaults are dropped exactly once. Without the version check,
  // deliberately binding fold back onto ⌘⌥F would be undone on every launch.
  const migrating = savedVersion !== KEYBINDINGS_VERSION
  const keybindings = { ...DEFAULT_KEYBINDINGS }
  for (const command of Object.keys(DEFAULT_KEYBINDINGS) as Array<keyof KeybindingMap>) {
    const saved = value[command]
    if (typeof saved !== 'string') continue
    if (migrating && saved === RETIRED_DEFAULT_KEYBINDINGS[command]) continue
    keybindings[command] = saved
  }
  return keybindings
}

export function savePreferences(preferences: AppPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Preferences remain active for the current session when storage is unavailable.
  }
}

function clampNumber(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.round(value)))
    : fallback
}
