import type { CodeViewItem, CodeViewLineSelection } from '@pierre/diffs'

import type { RemoteReviewThread } from '../../../shared/contracts'
import { createDiffAnnotation, createFileAnnotation } from './reviewAnnotations'
import type { ReviewAnnotationMetadata, ReviewThread } from './ReviewComments'
import { pathFromReviewItemId as pathFromItemId } from './reviewItems'
import type { DraftReviewComment } from './useReviewThreads'

export interface AnnotatedReviewItemCacheEntry {
  baseItem: CodeViewItem<ReviewAnnotationMetadata>
  signature: number
  item: CodeViewItem<ReviewAnnotationMetadata>
}

export type AnnotatedReviewItemCache = Map<string, AnnotatedReviewItemCacheEntry>

interface DeriveAnnotatedReviewItemsOptions {
  items: readonly CodeViewItem<ReviewAnnotationMetadata>[]
  threadsByPath: Readonly<Record<string, ReviewThread[]>>
  remoteThreadsByPath: ReadonlyMap<string, RemoteReviewThread[]>
  draftComment: DraftReviewComment | null
  pendingSelection: { id: string; range: CodeViewLineSelection['range'] } | null
  collapsedItemIds: ReadonlySet<string>
  annotationVersions: Readonly<Record<string, number>>
  previousCache: AnnotatedReviewItemCache
  previousItems?: CodeViewItem<ReviewAnnotationMetadata>[]
}

interface AnnotatedReviewItemDerivation {
  items: CodeViewItem<ReviewAnnotationMetadata>[]
  cache: AnnotatedReviewItemCache
}

export interface AnnotatedReviewItemMutations {
  additions: CodeViewItem<ReviewAnnotationMetadata>[]
  updates: CodeViewItem<ReviewAnnotationMetadata>[]
  removedIds: string[]
  // The viewer's `addItems` can only append, so anything that removes, inserts in
  // the middle or reorders has to go through its own reconcile instead.
  appendOnly: boolean
  nextItems: ReadonlyMap<string, CodeViewItem<ReviewAnnotationMetadata>>
}

export function planAnnotatedReviewItemMutations(
  items: readonly CodeViewItem<ReviewAnnotationMetadata>[],
  previousItems: ReadonlyMap<string, CodeViewItem<ReviewAnnotationMetadata>>,
  hasItem: (id: string) => boolean
): AnnotatedReviewItemMutations {
  const additions: CodeViewItem<ReviewAnnotationMetadata>[] = []
  const updates: CodeViewItem<ReviewAnnotationMetadata>[] = []
  const removedIds: string[] = []
  const nextItems = new Map<string, CodeViewItem<ReviewAnnotationMetadata>>()

  for (const item of items) {
    nextItems.set(item.id, item)
    if (!hasItem(item.id)) additions.push(item)
    else if (previousItems.get(item.id) !== item) updates.push(item)
  }

  for (const id of previousItems.keys()) {
    if (!nextItems.has(id)) removedIds.push(id)
  }

  let appendOnly = removedIds.length === 0
  if (appendOnly) {
    let index = 0
    for (const id of previousItems.keys()) {
      if (items[index]?.id !== id) {
        appendOnly = false
        break
      }
      index += 1
    }
  }

  return { additions, updates, removedIds, appendOnly, nextItems }
}

const FNV_OFFSET_BASIS = 2_166_136_261
const FNV_PRIME = 16_777_619

function hashNumber(hash: number, value: number): number {
  return Math.imul(hash ^ value, FNV_PRIME)
}

// Long bodies are sampled at both ends rather than read whole: hashing every
// character of every comment measured 2.6x slower than the `JSON.stringify` this
// replaced, which would have traded the garbage for main-thread latency. The blind
// spot — an edit that keeps the length and both 64-character ends — costs a stale
// annotation until the next change; every local thread edit also bumps
// `annotationVersions`, so only a remote comment can land in it.
const BODY_HASH_SAMPLE = 64

function hashSpan(hash: number, value: string, from: number, to: number): number {
  let next = hash
  for (let index = from; index < to; index += 1) {
    next = Math.imul(next ^ value.charCodeAt(index), FNV_PRIME)
  }
  return next
}

function hashText(hash: number, value: string): number {
  return hashNumber(hashSpan(hash, value, 0, value.length), value.length)
}

function hashBody(hash: number, value: string): number {
  const withLength = hashNumber(hash, value.length)
  if (value.length <= BODY_HASH_SAMPLE * 2) return hashSpan(withLength, value, 0, value.length)
  return hashSpan(
    hashSpan(withLength, value, 0, BODY_HASH_SAMPLE),
    value,
    value.length - BODY_HASH_SAMPLE,
    value.length
  )
}

function hashRange(hash: number, range: CodeViewLineSelection['range'] | null): number {
  if (range == null) return hashNumber(hash, 0)
  const bounds = hashNumber(hashNumber(hash, range.start + 1), range.end + 1)
  return hashText(hashText(bounds, range.side ?? ''), range.endSide ?? '')
}

/**
 * Everything that can change what one file's annotations render, folded into a
 * 32-bit word. The previous signature was `JSON.stringify` over the whole thread
 * list, which serialized every comment body — 0.8-2.6 MB of throwaway strings per
 * derivation, and a derivation runs on every 30 s conversation poll.
 */
export function annotationSignature(
  threads: readonly ReviewThread[],
  remoteThreads: readonly RemoteReviewThread[],
  draftRange: CodeViewLineSelection['range'] | null,
  selectionRange: CodeViewLineSelection['range'] | null,
  collapsed: boolean,
  annotationVersion: number
): number {
  let hash = hashNumber(FNV_OFFSET_BASIS, annotationVersion)
  hash = hashNumber(hash, collapsed ? 1 : 2)
  hash = hashRange(hash, draftRange)
  hash = hashRange(hash, selectionRange)
  hash = hashNumber(hash, threads.length)
  for (const thread of threads) {
    hash = hashText(hash, thread.id)
    hash = hashBody(hash, thread.body)
    hash = hashNumber(hash, thread.lineNumber)
    hash = hashText(hash, thread.side ?? '')
    hash = hashRange(hash, thread.range)
    hash = hashNumber(hash, thread.resolved ? 1 : 2)
    hash = hashNumber(hash, thread.replies.length)
    for (const reply of thread.replies) {
      hash = hashText(hash, reply.id)
      hash = hashBody(hash, reply.body)
    }
  }
  hash = hashNumber(hash, remoteThreads.length)
  for (const remoteThread of remoteThreads) {
    hash = hashText(hash, remoteThread.id)
    hash = hashNumber(hash, (remoteThread.line ?? -1) + 1)
    hash = hashNumber(hash, (remoteThread.startLine ?? -1) + 1)
    hash = hashText(hash, remoteThread.side)
    hash = hashNumber(hash, remoteThread.resolved ? 1 : 2)
    hash = hashNumber(hash, remoteThread.outdated ? 1 : 2)
    hash = hashNumber(hash, remoteThread.comments.length)
    for (const comment of remoteThread.comments) {
      hash = hashText(hash, comment.id)
      hash = hashBody(hash, comment.body)
      hash = hashText(hash, comment.authorLogin)
      hash = hashText(hash, comment.createdAt)
    }
  }
  return hash >>> 0
}

export function deriveAnnotatedReviewItems({
  items,
  threadsByPath,
  remoteThreadsByPath,
  draftComment,
  pendingSelection,
  collapsedItemIds,
  annotationVersions,
  previousCache,
  previousItems
}: DeriveAnnotatedReviewItemsOptions): AnnotatedReviewItemDerivation {
  const nextCache: AnnotatedReviewItemCache = new Map()
  let changed = previousItems == null || previousItems.length !== items.length
  const nextItems = items.map((baseItem, index) => {
    const path = pathFromItemId(baseItem.id)
    const threads = (threadsByPath[path] ?? []).filter((thread) => !thread.orphaned)
    const remoteThreads = remoteThreadsByPath.get(path) ?? []
    const draftRange = draftComment?.path === path ? draftComment.range : null
    const selectionRange = draftComment == null && pendingSelection?.id === baseItem.id
      ? pendingSelection.range
      : null
    const collapsed = collapsedItemIds.has(baseItem.id)
    const signature = annotationSignature(
      threads,
      remoteThreads,
      draftRange,
      selectionRange,
      collapsed,
      annotationVersions[path] ?? 0
    )
    const previous = previousCache.get(baseItem.id)
    if (previous?.baseItem === baseItem && previous.signature === signature) {
      nextCache.set(baseItem.id, previous)
      if (previousItems?.[index] !== previous.item) changed = true
      return previous.item
    }

    changed = true
    const inherited = inheritedPreviewMetadata(baseItem)
    // A preview item's single placeholder row cannot host line annotations:
    // comments and selection chrome stay with the diff it replaced.
    const commenting = !inherited.some((entry) => entry.kind === 'markdown')
    const metadata: ReviewAnnotationMetadata[] = [
      ...inherited,
      ...(commenting ? [
        ...remoteThreads.map((thread) => ({ kind: 'remote' as const, thread })),
        ...threads.map((thread) => ({ kind: 'thread' as const, thread })),
        ...(draftRange == null ? [] : [{ kind: 'draft' as const, range: draftRange }]),
        ...(selectionRange == null ? [] : [{ kind: 'selection' as const, range: selectionRange }])
      ] : [])
    ]
    const annotations = baseItem.type === 'diff'
      ? metadata.map(createDiffAnnotation)
      : metadata.map(createFileAnnotation)
    // A plain counter, because the viewer treats an unchanged version as "keep what
    // you have" and silently drops the update (CodeView.syncItemRecord). A version
    // derived from the annotation state alone was equal across a re-parse of the
    // same file, so a working-tree reload left stale hunks on screen.
    const item = {
      ...baseItem,
      annotations,
      collapsed,
      version: (previous?.item.version ?? 0) + 1
    } as CodeViewItem<ReviewAnnotationMetadata>
    nextCache.set(baseItem.id, { baseItem, signature, item })
    return item
  })

  // Holding the previous array is what lets `MultiFileViewer`'s memo bail on a
  // poll tick that changed nothing.
  if (!changed && previousItems != null) return { items: previousItems, cache: previousCache }
  return { items: nextItems, cache: nextCache }
}

function inheritedPreviewMetadata(
  item: CodeViewItem<ReviewAnnotationMetadata>
): ReviewAnnotationMetadata[] {
  const annotated = item as CodeViewItem<ReviewAnnotationMetadata> & {
    annotations?: ReadonlyArray<{ metadata?: ReviewAnnotationMetadata }>
  }
  return (annotated.annotations ?? []).flatMap((annotation) => (
    annotation.metadata?.kind === 'image' || annotation.metadata?.kind === 'markdown'
      ? [annotation.metadata]
      : []
  ))
}
