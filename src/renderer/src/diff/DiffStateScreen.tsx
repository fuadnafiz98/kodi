import {
  IconCodeSearch,
  IconFile,
  IconFileCode,
  IconRefresh,
  IconWarningOctogonFill
} from '@pierre/icons'

import type { FileComparison } from '../../../shared/contracts'
import type { DiffSurfaceState } from './diffSurfaceState'
import { ImageDiffPreview } from './ImageDiffPreview'

export interface DiffStateScreenProps {
  /** Anything but `code`; `code` renders nothing here. */
  state: DiffSurfaceState
  comparison: FileComparison | null
}

/** The one-line screens the diff surface shows when there is no code to render. */
export function DiffStateScreen({ state, comparison }: DiffStateScreenProps): React.JSX.Element | null {
  if (state === 'loading') {
    return <div className="diff-state pending"><IconRefresh className="spin" /><span>Loading comparison…</span></div>
  }
  if (state === 'no-selection') {
    return <div className="diff-state"><IconCodeSearch /><span>Select a file in the explorer</span></div>
  }
  if (state === 'image' && comparison?.image != null) {
    return (
      <div className="diff-scroll image-diff-scroll">
        <ImageDiffPreview image={comparison.image} status={comparison.status} />
      </div>
    )
  }
  if (state === 'binary') {
    return (
      <div className="diff-state">
        <IconFile />
        <strong>Binary file</strong>
        <span>Text diff is not available.</span>
      </div>
    )
  }
  if (state === 'oversized') {
    return (
      <div className="diff-state">
        <IconWarningOctogonFill />
        <strong>Large file</strong>
        <span>Files larger than 2 MB are not rendered yet.</span>
      </div>
    )
  }
  if (state === 'no-contents') {
    return <div className="diff-state"><IconFileCode /><span>No renderable file contents</span></div>
  }
  return null
}
