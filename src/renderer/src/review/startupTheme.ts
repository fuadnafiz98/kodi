import {
  AttachedThemes,
  attachResolvedThemes,
  hasResolvedThemes,
  type DiffsHighlighter,
  type ThemeRegistrationResolved
} from '@pierre/diffs'

/**
 * The launch's editor theme, kept from the last launch. Resolving it is a chain
 * of module loads (the tokenizer core, then the theme chunk, then normalising
 * it), and each hop waits behind React's first mount for a turn on the main
 * thread: the theme landed ~80 ms after the startup module asked, and the
 * highlight worker could not be initialised before it. Seeded from storage,
 * the worker starts at once.
 *
 * `__KODI_THEME_PACKAGES__` is the theme packages' versions, substituted by
 * `electron.vite.config.ts`, so a package upgrade drops the copy.
 */
declare const __KODI_THEME_PACKAGES__: string | undefined

const STARTUP_THEME_KEY = 'kodi:startup-theme:v1'

function themePackages(): string | null {
  return typeof __KODI_THEME_PACKAGES__ === 'string' ? __KODI_THEME_PACKAGES__ : null
}

interface StoredTheme {
  packages: string
  theme: ThemeRegistrationResolved
}

// The one export that seeds the resolver also loads the theme into the
// highlighter it is given and marks it attached. It gets one that keeps
// nothing, and the mark is taken back so the real highlighter still loads it.
const DETACHED_HIGHLIGHTER = { loadThemeSync: () => undefined } as unknown as DiffsHighlighter

/** True when `name` is resolved now, from the last launch's copy or otherwise. */
export function seedStartupTheme(name: string): boolean {
  if (hasResolvedThemes([name])) return true
  const packages = themePackages()
  if (packages == null || AttachedThemes.has(name)) return false
  let stored: StoredTheme | null = null
  try {
    stored = JSON.parse(localStorage.getItem(STARTUP_THEME_KEY) ?? 'null') as StoredTheme | null
  } catch {
    return false
  }
  if (stored?.packages !== packages || stored.theme?.name !== name) return false
  attachResolvedThemes(stored.theme, DETACHED_HIGHLIGHTER)
  AttachedThemes.delete(name)
  return hasResolvedThemes([name])
}

export function rememberStartupTheme(theme: ThemeRegistrationResolved | undefined): void {
  const packages = themePackages()
  if (packages == null || theme == null) return
  try {
    localStorage.setItem(STARTUP_THEME_KEY, JSON.stringify({ packages, theme } satisfies StoredTheme))
  } catch {
    // A full or unavailable storage only costs the next launch the slow path.
  }
}
