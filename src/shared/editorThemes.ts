// The theme table lives in shared/ because the build config reads it too:
// electron.vite.config.ts derives the shipped-shiki allowlist from these keys
// and cannot reach into the renderer tsconfig.

export type EditorTheme =
  | 'pierre-dark'
  | 'pierre-dark-soft'
  | 'pierre-dark-vibrant'
  | 'github-dark'
  | 'github-dark-dimmed'
  | 'vitesse-dark'
  | 'tokyo-night'
  | 'catppuccin-mocha'
  | 'nord'
  | 'pierre-light'
  | 'pierre-light-soft'
  | 'github-light'
  | 'vitesse-light'
  | 'light-plus'
  | 'solarized-light'
  | 'catppuccin-latte'
export type EditorThemeType = 'dark' | 'light'

/**
 * The three colors a theme contributes to the chrome around the code:
 * `canvas`/`text` are the theme's own editor background and foreground so the
 * app surface reads as the same material the diff is drawn on, and `accent`
 * is the theme's signature highlight. `themePalette.ts` derives the rest of
 * the token set from these.
 */
export interface ThemePaletteSeed {
  canvas: string
  text: string
  accent: string
}

export interface EditorThemeInfo {
  label: string
  type: EditorThemeType
  /**
   * Present when the theme owns the app chrome as well as the syntax colors.
   * The pierre themes deliberately leave it out: they pair with the app's own
   * neutral palettes instead of imposing one.
   */
  palette?: ThemePaletteSeed
}

export const EDITOR_THEMES: Record<EditorTheme, EditorThemeInfo> = {
  'pierre-dark': { label: 'Pierre Dark', type: 'dark' },
  'pierre-dark-soft': { label: 'Pierre Dark Soft', type: 'dark', palette: { canvas: '#171717', text: '#d4d4d4', accent: '#69b1ff' } },
  'pierre-dark-vibrant': { label: 'Pierre Dark Vibrant', type: 'dark' },
  'github-dark': { label: 'GitHub Dark', type: 'dark', palette: { canvas: '#24292e', text: '#e1e4e8', accent: '#58a6ff' } },
  'github-dark-dimmed': { label: 'GitHub Dark Dimmed', type: 'dark', palette: { canvas: '#22272e', text: '#adbac7', accent: '#539bf5' } },
  'vitesse-dark': { label: 'Vitesse Dark', type: 'dark', palette: { canvas: '#121212', text: '#dbd7ca', accent: '#a78bfa' } },
  'tokyo-night': { label: 'Tokyo Night', type: 'dark', palette: { canvas: '#1a1b26', text: '#a9b1d6', accent: '#7aa2f7' } },
  'catppuccin-mocha': { label: 'Catppuccin Mocha', type: 'dark', palette: { canvas: '#1e1e2e', text: '#cdd6f4', accent: '#89b4fa' } },
  nord: { label: 'Nord', type: 'dark', palette: { canvas: '#2e3440', text: '#d8dee9', accent: '#88c0d0' } },
  'pierre-light': { label: 'Pierre Light', type: 'light' },
  'pierre-light-soft': { label: 'Pierre Light Soft', type: 'light' },
  'github-light': { label: 'GitHub Light', type: 'light', palette: { canvas: '#ffffff', text: '#24292e', accent: '#0969da' } },
  'vitesse-light': { label: 'Vitesse Light', type: 'light', palette: { canvas: '#ffffff', text: '#393a34', accent: '#7656c9' } },
  'light-plus': { label: 'Light Plus', type: 'light', palette: { canvas: '#ffffff', text: '#1f1f1f', accent: '#007acc' } },
  'solarized-light': { label: 'Solarized Light', type: 'light', palette: { canvas: '#fdf6e3', text: '#657b83', accent: '#268bd2' } },
  'catppuccin-latte': { label: 'Catppuccin Latte', type: 'light', palette: { canvas: '#eff1f5', text: '#4c4f69', accent: '#1e66f5' } }
}

export const EDITOR_THEME_GROUPS: ReadonlyArray<{
  label: string
  themes: readonly EditorTheme[]
}> = [
  { label: 'Light', themes: ['pierre-light', 'pierre-light-soft', 'github-light', 'vitesse-light', 'light-plus', 'solarized-light', 'catppuccin-latte'] },
  { label: 'Dark', themes: ['pierre-dark', 'pierre-dark-soft', 'pierre-dark-vibrant', 'github-dark', 'github-dark-dimmed', 'vitesse-dark', 'tokyo-night', 'catppuccin-mocha', 'nord'] }
]

export function getEditorThemeType(theme: EditorTheme): EditorThemeType {
  return EDITOR_THEMES[theme].type
}
