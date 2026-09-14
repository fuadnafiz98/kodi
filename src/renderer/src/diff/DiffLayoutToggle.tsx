import { IconDiffSplit, IconDiffUnified } from '@pierre/icons'

import type { DiffStyle } from '../app/AppView'

export interface DiffLayoutToggleProps {
  diffStyle: DiffStyle
  onDiffStyleChange(style: DiffStyle): void
}

export function DiffLayoutToggle({ diffStyle, onDiffStyleChange }: DiffLayoutToggleProps): React.JSX.Element {
  return (
    <>
      <span className="diff-control-divider" aria-hidden="true" />
      <div className="segmented-control diff-layout-control" role="group" aria-label="Diff layout">
        <button type="button" aria-label="Split diff" aria-pressed={diffStyle === 'split'}
          data-tooltip="Split view" className={diffStyle === 'split' ? 'active' : undefined} onClick={() => onDiffStyleChange('split')}>
          <IconDiffSplit />
        </button>
        <button type="button" aria-label="Unified diff" aria-pressed={diffStyle === 'unified'}
          data-tooltip="Unified view" className={diffStyle === 'unified' ? 'active' : undefined} onClick={() => onDiffStyleChange('unified')}>
          <IconDiffUnified />
        </button>
      </div>
    </>
  )
}
