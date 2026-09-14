import type { DiffLineAnnotation, LineAnnotation, SelectedLineRange } from '@pierre/diffs'

import type { ReviewAnnotationMetadata, ReviewThread } from './ReviewComments'

export function selectedRangeLastLine(range: Pick<SelectedLineRange, 'start' | 'end'>): number {
  return Math.max(range.start, range.end)
}

function threadAnnotationLine(thread: ReviewThread): number {
  const first = Math.min(thread.range.start, thread.range.end)
  const last = selectedRangeLastLine(thread.range)
  // Saved comments used to store the drag origin. Sit after the last selected
  // line unless an editor remapped the card off that span.
  if (thread.lineNumber === first) return last
  return thread.lineNumber
}

export function annotationLine(metadata: ReviewAnnotationMetadata): number {
  // The action bar and the draft that can replace it anchor to the same line, so
  // the bar does not jump when a selection turns into a comment.
  if (metadata.kind === 'image' || metadata.kind === 'markdown') return 1
  if (metadata.kind === 'selection' || metadata.kind === 'draft') return selectedRangeLastLine(metadata.range)
  if (metadata.kind === 'remote') return metadata.thread.line ?? metadata.thread.startLine ?? 1
  return threadAnnotationLine(metadata.thread)
}

export function annotationSide(metadata: ReviewAnnotationMetadata): 'additions' | 'deletions' {
  if (metadata.kind === 'image' || metadata.kind === 'markdown') return 'additions'
  if (metadata.kind === 'selection' || metadata.kind === 'draft') return metadata.range.side ?? 'additions'
  if (metadata.kind === 'remote') return metadata.thread.side === 'LEFT' ? 'deletions' : 'additions'
  return metadata.thread.side ?? 'additions'
}

// The library's annotation types distribute over the metadata union, so the
// shared shape is cast once here instead of at every call site.
export function createDiffAnnotation(
  metadata: ReviewAnnotationMetadata
): DiffLineAnnotation<ReviewAnnotationMetadata> {
  return {
    lineNumber: annotationLine(metadata),
    side: annotationSide(metadata),
    metadata
  } as DiffLineAnnotation<ReviewAnnotationMetadata>
}

export function createFileAnnotation(
  metadata: ReviewAnnotationMetadata
): LineAnnotation<ReviewAnnotationMetadata> {
  return {
    lineNumber: annotationLine(metadata),
    metadata
  } as LineAnnotation<ReviewAnnotationMetadata>
}
