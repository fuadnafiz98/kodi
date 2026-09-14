import { memo } from 'react'

import type { PaletteAction } from './paletteActions'
import { PaletteSearchPreview } from './PaletteSearchPreview'

// Built as a lookup rather than `[a, b].filter(Boolean).join(' ') || undefined`:
// the React Compiler cannot lower a logical test whose operand is a ternary chain
// and bails out of the whole palette.
function paletteRowClassName(active: boolean, preview: boolean): string | undefined {
  if (active) return preview ? 'primary-result palette-content' : 'primary-result'
  return preview ? 'palette-content' : undefined
}

export interface PaletteRowProps {
  action: PaletteAction
  /** Position in the flat result list, which the delegated pointer handler reads. */
  index: number
  active: boolean
  /** The query the content preview highlights. */
  filterQuery: string
}

export const PaletteRow = memo(function PaletteRow({
  action,
  index,
  active,
  filterQuery
}: PaletteRowProps): React.JSX.Element {
  return (
    <button
      data-index={index}
      type="button"
      className={paletteRowClassName(active, action.preview != null)}
      disabled={action.disabledReason != null}
      onClick={action.run}
    >
      <span className="command-icon"><action.icon /></span>
      <span>
        <strong>{action.title}</strong>
        <small>{action.disabledReason ?? action.subtitle}</small>
        {action.preview != null && action.previewPath != null ? (
          <code className="palette-content-preview">
            <PaletteSearchPreview path={action.previewPath} preview={action.preview} query={filterQuery} />
          </code>
        ) : null}
      </span>
      {action.keybinding == null ? null : <kbd>{action.keybinding}</kbd>}
    </button>
  )
})
