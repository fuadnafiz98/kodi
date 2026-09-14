import type { FileComparison } from '../../../shared/contracts'
import { hasImagePreview } from '../../../shared/imagePreview'

/**
 * What the diff surface can show instead of code. `code` means the comparison
 * has renderable text; everything else is a one-line state screen.
 */
export type DiffSurfaceState =
  | 'loading'
  | 'no-selection'
  | 'image'
  | 'binary'
  | 'oversized'
  | 'no-contents'
  | 'code'

export function diffSurfaceState(
  comparison: FileComparison | null,
  loading: boolean
): DiffSurfaceState {
  if (loading) return 'loading'
  if (comparison == null) return 'no-selection'
  if (hasImagePreview(comparison.image)) return 'image'
  if (comparison.binary) return 'binary'
  if (comparison.oversized) return 'oversized'
  if (comparison.oldFile == null && comparison.newFile == null) return 'no-contents'
  return 'code'
}
