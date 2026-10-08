import { IconSidebar } from '@pierre/icons'

import type { DiffStyle } from '../app/AppView'

export interface DiffLayoutToggleProps {
  diffStyle: DiffStyle
  onDiffStyleChange(style: DiffStyle): void
}

/**
 * Split view as an on/off beside word wrap and folding: one outline glyph
 * (two panes) that is lit when the diff is split, the same pressed thumb as the
 * toggles next to it. The library's split and unified glyphs are filled
 * duotone blocks that read as a badge in a row of line icons.
 */
export function DiffLayoutToggle({ diffStyle, onDiffStyleChange }: DiffLayoutToggleProps): React.JSX.Element {
  const split = diffStyle === 'split'
  return (
    <button type="button" aria-label="Split view" aria-pressed={split}
      data-tooltip={split ? 'Split view · on' : 'Split view'} className={split ? 'active' : undefined}
      onClick={() => onDiffStyleChange(split ? 'unified' : 'split')}>
      <IconSidebar aria-hidden="true" />
    </button>
  )
}
