import { IconDiffSplit, IconDiffUnified } from '@pierre/icons'

import type { DiffStyle } from '../app/AppView'

export interface DiffLayoutToggleProps {
  diffStyle: DiffStyle
  onDiffStyleChange(style: DiffStyle): void
}

/**
 * Offers the other layout rather than presenting both. Which one is on is
 * already unmistakable from the diff itself — two columns or one — so a
 * two-button segmented control spent twice the width saying what the content
 * says for free. No `aria-pressed`: split and unified are two values of one
 * mode, not an on/off, so the label names the destination instead.
 *
 * The glyph changes with the state, unlike the sidebar toggle, which keeps one
 * glyph so it can be found by muscle memory. This is reached a handful of times
 * a session, from a toolbar the reader is already looking at, and the glyph is
 * the only thing naming the layout it would switch to.
 */
export function DiffLayoutToggle({ diffStyle, onDiffStyleChange }: DiffLayoutToggleProps): React.JSX.Element {
  const next: DiffStyle = diffStyle === 'split' ? 'unified' : 'split'
  return (
    <button type="button" aria-label={`Switch to ${next} diff`}
      data-tooltip={next === 'split' ? 'Split view' : 'Unified view'}
      onClick={() => onDiffStyleChange(next)}>
      {next === 'split' ? <IconDiffSplit aria-hidden="true" /> : <IconDiffUnified aria-hidden="true" />}
    </button>
  )
}
