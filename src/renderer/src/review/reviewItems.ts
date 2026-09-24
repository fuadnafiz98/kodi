import { parseDiffFromFile, parsePatchFiles, type CodeViewItem } from '@pierre/diffs'

import type { FileComparison, FileImagePreview } from '../../../shared/contracts'
import { hasImagePreview, imagePreviewCacheKey } from '../../../shared/imagePreview'
import { isMarkdownPath } from '../../../shared/markdownPreview'
import { stripMarkdownFrontmatter } from './documentView'
import type { ReviewAnnotationMetadata } from './ReviewComments'

export function reviewItemId(path: string): string {
  return `review:${path}`
}

export function pathFromReviewItemId(id: string): string {
  return id.startsWith('review:') ? id.slice('review:'.length) : id
}

export function imageReviewFile(path: string, image: FileImagePreview): {
  name: string
  contents: string
  cacheKey: string
} {
  return {
    name: path,
    contents: '\u200b',
    cacheKey: imagePreviewCacheKey(image)
  }
}

export function createImageReviewItem(
  path: string,
  image: FileImagePreview
): CodeViewItem<ReviewAnnotationMetadata> {
  return {
    id: reviewItemId(path),
    type: 'file',
    file: imageReviewFile(path, image),
    annotations: [{
      lineNumber: 1,
      metadata: { kind: 'image', image }
    }]
  } as CodeViewItem<ReviewAnnotationMetadata>
}

export function applyImagePreviews<Metadata>(
  items: readonly CodeViewItem<Metadata>[],
  previews: ReadonlyMap<string, FileImagePreview>
): CodeViewItem<Metadata>[] {
  if (previews.size === 0) return items as CodeViewItem<Metadata>[]
  let changed = false
  const next = items.map((item) => {
    const path = pathFromReviewItemId(item.id)
    const image = previews.get(path)
    if (image == null) return item
    const cacheKey = imagePreviewCacheKey(image)
    if (item.type === 'file' && item.file.cacheKey === cacheKey) return item
    changed = true
    return createImageReviewItem(path, image) as CodeViewItem<Metadata>
  })
  return changed ? next : items as CodeViewItem<Metadata>[]
}

const PREVIEW_PLACEHOLDER = '\u200b'

export interface MarkdownItemSource {
  source: string
  /** True when the patch only contains the changed sections, not the whole file. */
  partial: boolean
}

/** Cheap header-toggle gate: a path check plus non-empty content, no join. */
export function canPreviewMarkdownItem(item: CodeViewItem<unknown>): boolean {
  if (!isMarkdownPath(pathFromReviewItemId(item.id))) return false
  if (item.type === 'file') {
    return item.file.contents !== PREVIEW_PLACEHOLDER && item.file.contents.length > 0
  }
  if (item.type === 'diff') {
    const { fileDiff } = item
    return (fileDiff.type === 'deleted' ? fileDiff.deletionLines : fileDiff.additionLines).length > 0
  }
  return false
}

/**
 * The markdown the preview renders. A patch-parsed diff only carries the lines
 * it touches, except for whole-file changes: a `new` file's additions and a
 * `deleted` file's deletions are complete even while `isPartial`.
 */
export function markdownItemSource(item: CodeViewItem<unknown>): MarkdownItemSource | null {
  if (!canPreviewMarkdownItem(item)) return null
  if (item.type === 'file') {
    return { source: stripMarkdownFrontmatter(item.file.contents), partial: false }
  }
  if (item.type !== 'diff') return null
  const { fileDiff } = item
  const lines = fileDiff.type === 'deleted' ? fileDiff.deletionLines : fileDiff.additionLines
  const partial = fileDiff.isPartial && fileDiff.type !== 'new' && fileDiff.type !== 'deleted'
  // Patch-parsed line arrays keep their own trailing newlines.
  return { source: stripMarkdownFrontmatter(lines.join('')), partial }
}

export function markdownPreviewCacheKey(path: string, source: string): string {
  return `markdown:${path}:${source.length}:${source.slice(-24)}`
}

export function createMarkdownReviewItem(
  path: string,
  source: string,
  partial: boolean
): CodeViewItem<ReviewAnnotationMetadata> {
  return {
    id: reviewItemId(path),
    type: 'file',
    file: { name: path, contents: PREVIEW_PLACEHOLDER, cacheKey: markdownPreviewCacheKey(path, source) },
    annotations: [{
      lineNumber: 1,
      metadata: { kind: 'markdown', source, partial }
    }]
  } as CodeViewItem<ReviewAnnotationMetadata>
}

export interface MarkdownHydratedSource {
  /** Cache key of the item the source was resolved for; a reloaded diff invalidates it. */
  cacheKey: string | undefined
  source: string
}

function reviewItemCacheKey(item: CodeViewItem<unknown>): string | undefined {
  if (item.type === 'file') return item.file.cacheKey
  if (item.type === 'diff') return item.fileDiff.cacheKey
  return undefined
}

export function applyMarkdownPreviews<Metadata>(
  items: readonly CodeViewItem<Metadata>[],
  previewPaths: ReadonlySet<string>,
  hydratedSources: ReadonlyMap<string, MarkdownHydratedSource>
): CodeViewItem<Metadata>[] {
  if (previewPaths.size === 0) return items as CodeViewItem<Metadata>[]
  let changed = false
  const next = items.map((item) => {
    const path = pathFromReviewItemId(item.id)
    if (!previewPaths.has(path)) return item
    const hydrated = hydratedSources.get(path)
    const resolved = hydrated != null
      && (hydrated.cacheKey == null || hydrated.cacheKey === reviewItemCacheKey(item))
      ? { source: hydrated.source, partial: false }
      : markdownItemSource(item)
    if (resolved == null) return item
    const cacheKey = markdownPreviewCacheKey(path, resolved.source)
    if (item.type === 'file' && item.file.cacheKey === cacheKey) return item
    changed = true
    return createMarkdownReviewItem(path, resolved.source, resolved.partial) as CodeViewItem<Metadata>
  })
  return changed ? next : items as CodeViewItem<Metadata>[]
}

export function createReviewItem<Metadata>(comparison: FileComparison): CodeViewItem<Metadata> | null {
  if (comparison.oversized) return null
  if (hasImagePreview(comparison.image)) {
    return createImageReviewItem(comparison.path, comparison.image) as CodeViewItem<Metadata>
  }
  if (comparison.binary) return null

  if (comparison.mode === 'file' && comparison.newFile != null) {
    return { id: reviewItemId(comparison.path), type: 'file', file: comparison.newFile }
  }

  if (comparison.oldFile == null && comparison.newFile == null) return null
  return {
    id: reviewItemId(comparison.path),
    type: 'diff',
    fileDiff: parseDiffFromFile(comparison.oldFile, comparison.newFile)
  }
}

/**
 * Content identity for a patch-parsed file, for callers that have no git object
 * ID to lean on. Two hashes with different seeds and orders, so a file cannot
 * collide with its own reverse.
 */
function hashPatchLines(lines: readonly string[], seed: number): number {
  let hash = seed
  for (const line of lines) {
    for (let index = 0; index < line.length; index += 1) {
      hash = Math.imul(hash ^ line.charCodeAt(index), 16_777_619)
    }
    hash = Math.imul(hash ^ 0, 16_777_619)
  }
  return hash >>> 0
}

export function patchContentSignature(type: string, additions: readonly string[], deletions: readonly string[]): string {
  const first = hashPatchLines([type, ...additions, '\u0001', ...deletions], 2_166_136_261)
  const second = hashPatchLines([type, ...deletions, '\u0002', ...additions], 2_654_435_761)
  return `patch:${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`
}

/**
 * `parsePatchFiles` keys each file by where it sat in the text it was parsed
 * from — `${version}-${patchIndex}-${fileIndex}`. The viewer treats `cacheKey`
 * as content identity: its highlight worker and its render cache both look a
 * diff up by that key alone and never compare the lines. Pages arrive in
 * whatever order the eight fetches finish, and a reload may serve one cached
 * page where the first pass streamed several, so the same key came back on a
 * different file — and the renderer then drew the new file's hunks against the
 * old file's highlighted lines. Past the end of them it throws
 * `deletionLine and additionLine are null`, and the file blanks out.
 *
 * Keying by content closes it. `version` stays in front so the load state's
 * page seams keep working.
 */
function patchCacheKey(fileDiff: { name: string; prevName?: string | null; type: string;
  additionLines: readonly string[]; deletionLines: readonly string[]
  prevObjectId?: string | null; newObjectId?: string | null }, version: string): string {
  const identity = fileDiff.newObjectId != null
    ? `${fileDiff.prevObjectId ?? 'none'}..${fileDiff.newObjectId}`
    : patchContentSignature(fileDiff.type, fileDiff.additionLines, fileDiff.deletionLines)
  return `${version}:${fileDiff.prevName ?? ''}>${fileDiff.name}:${identity}`
}

export function createPatchReviewItems<Metadata>(patch: string, version: string): CodeViewItem<Metadata>[] {
  const seenPaths = new Set<string>()
  const items: CodeViewItem<Metadata>[] = []
  for (const parsedPatch of parsePatchFiles(patch, version)) {
    for (const fileDiff of parsedPatch.files) {
      if (seenPaths.has(fileDiff.name)) continue
      seenPaths.add(fileDiff.name)
      fileDiff.cacheKey = patchCacheKey(fileDiff, version)
      items.push({ id: reviewItemId(fileDiff.name), type: 'diff', fileDiff })
    }
  }
  return items
}

export function mergeReviewItems<Metadata>(
  currentItems: readonly CodeViewItem<Metadata>[],
  incomingItems: readonly CodeViewItem<Metadata>[]
): CodeViewItem<Metadata>[] {
  const itemsById = new Map(currentItems.map((item) => [item.id, item]))
  for (const item of incomingItems) itemsById.set(item.id, item)
  return [...itemsById.values()]
}

// A path set that changed keeps whatever it still contains: the viewer reconciles
// the difference, where clearing the list first would have unmounted it.
export function retainReviewItems<Metadata>(
  items: readonly CodeViewItem<Metadata>[],
  paths: readonly string[]
): CodeViewItem<Metadata>[] {
  const visiblePaths = new Set(paths)
  return items.filter((item) => visiblePaths.has(pathFromReviewItemId(item.id)))
}

export function orderReviewItems<Metadata>(
  items: readonly CodeViewItem<Metadata>[],
  orderedPaths: readonly string[]
): CodeViewItem<Metadata>[] {
  const itemsByPath = new Map(items.map((item) => [pathFromReviewItemId(item.id), item]))
  const orderedItems = orderedPaths.flatMap((path) => {
    const item = itemsByPath.get(path)
    if (item == null) return []
    itemsByPath.delete(path)
    return [item]
  })
  return [...orderedItems, ...itemsByPath.values()]
}

export interface ReviewItemPosition {
  id: string
  top: number
}

/**
 * A file collapsed from its sticky header — the file starts above the viewport —
 * must have its header held where it was clicked. Left alone, the page loses the
 * whole file's height at once and the header the pointer is on vanishes upward,
 * which reads as the review jumping to another file.
 */
export function shouldPinCollapsedHeader(itemTop: number | undefined, scrollTop: number): boolean {
  return itemTop != null && itemTop < scrollTop
}

export function findNextUnreadReviewItemId(
  activeItemId: string | null,
  viewedItemId: string,
  items: readonly Pick<CodeViewItem, 'id'>[],
  viewedPaths: ReadonlySet<string>
): string | null {
  if (activeItemId !== viewedItemId) return null
  const viewedIndex = items.findIndex((item) => item.id === viewedItemId)
  if (viewedIndex < 0) return null
  return items.slice(viewedIndex + 1).find(
    (item) => !viewedPaths.has(pathFromReviewItemId(item.id))
  )?.id ?? null
}

export function findActiveReviewItemId(
  scrollTop: number,
  positions: readonly ReviewItemPosition[],
  anchorOffset = 56
): string | null {
  const first = positions[0]
  if (first == null) return null
  const anchor = scrollTop + anchorOffset
  let activeId = first.id
  for (const position of positions) {
    if (position.top > anchor) break
    activeId = position.id
  }
  return activeId
}
