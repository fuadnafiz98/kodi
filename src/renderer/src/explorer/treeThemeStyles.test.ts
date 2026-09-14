import { describe, expect, it } from 'bun:test'
import { themeToTreeStyles } from '@pierre/trees'
import pierreDarkTheme from '@pierre/theme/pierre-dark'
import pierreLightTheme from '@pierre/theme/pierre-light'

import { DARK_TREE_STYLES, LIGHT_TREE_STYLES } from './treeThemeStyles'

// The shipped styles are baked literals so the ~30 KB theme JSON stays out of
// the pre-mount workspace chunk. If a dependency bump changes what
// themeToTreeStyles emits, this fails and the literals must be regenerated.
describe('treeThemeStyles', () => {
  it('matches themeToTreeStyles for pierre-dark', () => {
    expect(DARK_TREE_STYLES).toEqual(themeToTreeStyles(pierreDarkTheme))
  })

  it('matches themeToTreeStyles for pierre-light', () => {
    expect(LIGHT_TREE_STYLES).toEqual(themeToTreeStyles(pierreLightTheme))
  })
})
