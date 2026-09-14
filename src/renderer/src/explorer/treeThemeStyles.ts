import type { TreeThemeStyles } from '@pierre/trees'

// Baked output of themeToTreeStyles() for the two bundled palettes. The theme
// JSON is ~30 KB each — far too heavy for the pre-mount workspace chunk — while
// the tree only reads these seventeen values. Baking keeps the correct palette
// available synchronously on the first frame; the async fallback painted the
// sidebar dark under a light theme. treeThemeStyles.test.ts recomputes both
// from the real themes so a dependency bump cannot drift these silently.
export const DARK_TREE_STYLES: TreeThemeStyles = {
  colorScheme: 'dark',
  backgroundColor: '#171717',
  color: '#a3a3a3',
  borderColor: 'var(--trees-theme-sidebar-border, light-dark(oklch(0% 0 0 / 0.15), oklch(100% 0 0 / 0.15)))',
  '--trees-theme-sidebar-bg': '#171717',
  '--trees-theme-sidebar-fg': '#a3a3a3',
  '--trees-theme-sidebar-header-fg': '#a3a3a3',
  '--trees-theme-list-active-selection-fg': '#fafafa',
  '--trees-theme-list-hover-bg': '#19283c59',
  '--trees-theme-list-active-selection-bg': '#19283c99',
  '--trees-theme-focus-ring': '#009fff',
  '--trees-theme-input-bg': '#1d1d1d',
  '--trees-theme-sidebar-border': '#0a0a0a',
  '--trees-theme-input-border': '#1d1d1d',
  '--trees-theme-git-added-fg': '#07c480',
  '--trees-theme-git-modified-fg': '#009fff',
  '--trees-theme-git-deleted-fg': '#ff2e3f'
}

export const LIGHT_TREE_STYLES: TreeThemeStyles = {
  colorScheme: 'light',
  backgroundColor: '#f5f5f5',
  color: '#525252',
  borderColor: 'var(--trees-theme-sidebar-border, light-dark(oklch(0% 0 0 / 0.15), oklch(100% 0 0 / 0.15)))',
  '--trees-theme-sidebar-bg': '#f5f5f5',
  '--trees-theme-sidebar-fg': '#525252',
  '--trees-theme-sidebar-header-fg': '#525252',
  '--trees-theme-list-active-selection-fg': '#0a0a0a',
  '--trees-theme-list-hover-bg': '#dfebff59',
  '--trees-theme-list-active-selection-bg': '#dfebffcc',
  '--trees-theme-focus-ring': '#009fff',
  '--trees-theme-input-bg': '#ededed',
  '--trees-theme-sidebar-border': '#e5e5e5',
  '--trees-theme-input-border': '#d4d4d4',
  '--trees-theme-git-added-fg': '#18a46c',
  '--trees-theme-git-modified-fg': '#009fff',
  '--trees-theme-git-deleted-fg': '#d52c36'
}
