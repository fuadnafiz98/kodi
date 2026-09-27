import type { CodeViewItem, FileDiffMetadata } from '@pierre/diffs'

import type { PullRequestConversation } from '../../../shared/contracts'
import type { AnnotatedReviewItemCache } from './annotatedReviewItems'
import type { ReviewAnnotationMetadata } from './ReviewComments'

interface WorldViewSyncState {
  worlds: readonly {
    worldId: string
    source: string
    loadStatus?: string
  }[]
}

export const PARSED_ITEM_OVERHEAD_BYTES = 2 * 1024
export const CONVERSATION_THREAD_OVERHEAD_BYTES = 128
export const CONVERSATION_COMMENT_OVERHEAD_BYTES = 64
export const MAX_RETAINED_WORLD_VIEWERS = 3
export const VIEWER_INSTANCE_OVERHEAD_BYTES = 2 * 1024 * 1024
export const VIEWER_ITEM_BYTES = 24 * 1024

export type WorldViewParsedSeed = {
  kind: 'pages'
  parseKey: string
  pageRefs: readonly string[]
  items: CodeViewItem<ReviewAnnotationMetadata>[]
} | {
  kind: 'string'
  parseKey: string
  patchLength: number
  tail: string
  items: CodeViewItem<ReviewAnnotationMetadata>[]
}

export interface WorldViewAnnotatedSeed {
  baseItems: readonly CodeViewItem<ReviewAnnotationMetadata>[]
  items: CodeViewItem<ReviewAnnotationMetadata>[]
  cache: AnnotatedReviewItemCache
}

export interface WorldViewCacheEntry {
  parsed: WorldViewParsedSeed | null
  collapsedItemIds: ReadonlySet<string>
  conversation: PullRequestConversation | null
  annotated: WorldViewAnnotatedSeed | null
  /**
   * Conversation and viewer bytes, which only move when the entry does. The
   * parsed items are charged when asked, because hydration grows them in place.
   */
  fixedBytes: number
}

interface HydratedLineBytes {
  deletionLines: readonly string[]
  additionLines: readonly string[]
  bytes: number
}

const hydratedLineBytes = new WeakMap<FileDiffMetadata, HydratedLineBytes>()

function lineArrayBytes(lines: readonly string[]): number {
  let length = 0
  for (const line of lines) length += line.length
  return length * 2
}

/**
 * A patch-parsed diff holds only its hunk lines, and those are slices of the
 * patch the world already charges. Hydration merges both whole files into the
 * same object the seed keeps, so a diff that is no longer partial carries two
 * files the patch length never counted. Lines are charged at two bytes a
 * character, like item ids, which leaves room for each line's string header.
 */
export function estimateHydratedDiffBytes(fileDiff: FileDiffMetadata): number {
  if (fileDiff.isPartial) return 0
  const { deletionLines, additionLines } = fileDiff
  const cached = hydratedLineBytes.get(fileDiff)
  if (cached?.deletionLines === deletionLines && cached.additionLines === additionLines) return cached.bytes
  // A pure rename hydrates both sides from the one file.
  const bytes = lineArrayBytes(deletionLines)
    + (additionLines === deletionLines ? 0 : lineArrayBytes(additionLines))
  hydratedLineBytes.set(fileDiff, { deletionLines, additionLines, bytes })
  return bytes
}

export function estimateParsedGraphBytes(items: readonly { id: string; fileDiff?: FileDiffMetadata }[]): number {
  let bytes = 0
  for (const item of items) {
    bytes += item.id.length * 2 + PARSED_ITEM_OVERHEAD_BYTES
    if (item.fileDiff != null) bytes += estimateHydratedDiffBytes(item.fileDiff)
  }
  return bytes
}

export function estimateConversationBytes(conversation: PullRequestConversation | null): number {
  if (conversation == null) return 0
  let bytes = conversation.body.length * 2 + (conversation.message?.length ?? 0) * 2
  for (const thread of conversation.threads) {
    bytes += CONVERSATION_THREAD_OVERHEAD_BYTES
    for (const comment of thread.comments) bytes += comment.body.length * 2 + CONVERSATION_COMMENT_OVERHEAD_BYTES
  }
  for (const review of conversation.reviews) bytes += review.body.length * 2 + CONVERSATION_COMMENT_OVERHEAD_BYTES
  return bytes
}

export function estimateViewerBytes(itemCount: number): number {
  if (itemCount <= 0) return 0
  return VIEWER_INSTANCE_OVERHEAD_BYTES + itemCount * VIEWER_ITEM_BYTES
}

export function retainWorldViewers(
  current: readonly string[],
  activeWorldId: string,
  max = MAX_RETAINED_WORLD_VIEWERS
): string[] {
  if (current[0] === activeWorldId && current.length <= max) {
    const seen = new Set<string>()
    let unique = true
    for (const id of current) {
      if (seen.has(id)) {
        unique = false
        break
      }
      seen.add(id)
    }
    if (unique) return current as string[]
  }
  const next = [activeWorldId]
  for (const id of current) {
    if (id === activeWorldId) continue
    next.push(id)
    if (next.length === max) break
  }
  return next
}

export function itemsForRetainedWorld<Item>(
  worldId: string,
  activeWorldId: string | null,
  liveItems: readonly Item[],
  cachedItems: readonly Item[] | null | undefined
): Item[] | null {
  if (worldId === activeWorldId) return liveItems.length > 0 ? liveItems as Item[] : null
  return cachedItems != null && cachedItems.length > 0 ? cachedItems as Item[] : null
}

export function reuseAnnotatedItems(
  cached: WorldViewAnnotatedSeed | null | undefined,
  baseItems: readonly CodeViewItem<ReviewAnnotationMetadata>[]
): CodeViewItem<ReviewAnnotationMetadata>[] | null {
  return cached?.baseItems === baseItems ? cached.items : null
}

export function takeCachedAnnotatedDerivation(
  cached: WorldViewAnnotatedSeed | null | undefined,
  baseItems: readonly CodeViewItem<ReviewAnnotationMetadata>[]
): { items: CodeViewItem<ReviewAnnotationMetadata>[]; cache: AnnotatedReviewItemCache } | null {
  const items = reuseAnnotatedItems(cached, baseItems)
  return items == null || cached == null ? null : { items, cache: cached.cache }
}

function emptyEntry(): WorldViewCacheEntry {
  return {
    parsed: null,
    collapsedItemIds: new Set(),
    conversation: null,
    annotated: null,
    fixedBytes: 0
  }
}

function withGraphBytes(
  worldId: string,
  entry: Omit<WorldViewCacheEntry, 'fixedBytes'>,
  mountedViewers: ReadonlySet<string>
): WorldViewCacheEntry {
  const items = entry.parsed?.items ?? []
  return {
    ...entry,
    fixedBytes: estimateConversationBytes(entry.conversation)
      + (mountedViewers.has(worldId) ? estimateViewerBytes(items.length) : 0)
  }
}

export class WorldViewCache {
  #entries = new Map<string, WorldViewCacheEntry>()
  #mountedViewers = new Set<string>()

  get(worldId: string): WorldViewCacheEntry | undefined {
    return this.#entries.get(worldId)
  }

  graphBytes(worldId: string): number {
    const entry = this.#entries.get(worldId)
    if (entry == null) return 0
    return estimateParsedGraphBytes(entry.parsed?.items ?? []) + entry.fixedBytes
  }

  viewerMounted(worldId: string): boolean {
    return this.#mountedViewers.has(worldId)
  }

  /**
   * Only the world in front has a live viewer: hiding an `<Activity>` detaches
   * the viewer's host ref, and Pierre's CodeView cleans its instance up then.
   * The registry calls this as focus moves, before it charges the world that
   * just went behind, so that world is not billed for a viewer it lost.
   */
  retainFrontViewer(activeWorldId: string | null): void {
    this.retainMountedViewers(activeWorldId != null && this.#mountedViewers.has(activeWorldId)
      ? [activeWorldId]
      : [])
  }

  retainMountedViewers(worldIds: readonly string[]): void {
    const next = new Set(worldIds)
    const affected = new Set<string>()
    for (const worldId of this.#mountedViewers) {
      if (!next.has(worldId)) affected.add(worldId)
    }
    for (const worldId of next) {
      if (!this.#mountedViewers.has(worldId)) affected.add(worldId)
    }
    if (affected.size === 0) return
    this.#mountedViewers = next
    for (const worldId of affected) {
      const entry = this.#entries.get(worldId)
      if (entry == null) continue
      this.#entries.set(worldId, withGraphBytes(worldId, entry, this.#mountedViewers))
    }
  }

  rememberParsed(worldId: string, parsed: WorldViewParsedSeed): void {
    const previous = this.#entries.get(worldId) ?? emptyEntry()
    this.#entries.set(worldId, withGraphBytes(worldId, {
      ...previous,
      parsed,
      annotated: previous.annotated?.baseItems === parsed.items ? previous.annotated : null
    }, this.#mountedViewers))
  }

  rememberCollapsed(worldId: string, collapsedItemIds: ReadonlySet<string>): void {
    const previous = this.#entries.get(worldId) ?? emptyEntry()
    this.#entries.set(worldId, withGraphBytes(worldId, {
      ...previous,
      collapsedItemIds: new Set(collapsedItemIds)
    }, this.#mountedViewers))
  }

  rememberConversation(worldId: string, conversation: PullRequestConversation | null): void {
    const previous = this.#entries.get(worldId) ?? emptyEntry()
    this.#entries.set(worldId, withGraphBytes(worldId, {
      ...previous,
      conversation
    }, this.#mountedViewers))
  }

  rememberAnnotated(worldId: string, annotated: WorldViewAnnotatedSeed): void {
    const previous = this.#entries.get(worldId) ?? emptyEntry()
    this.#entries.set(worldId, withGraphBytes(worldId, {
      ...previous,
      annotated
    }, this.#mountedViewers))
  }

  drop(worldId: string): void {
    this.#entries.delete(worldId)
    this.#mountedViewers.delete(worldId)
  }

  clear(): void {
    this.#entries.clear()
    this.#mountedViewers.clear()
  }

  sync(state: WorldViewSyncState): void {
    const live = new Set(state.worlds.map((world) => world.worldId))
    for (const worldId of this.#entries.keys()) {
      if (!live.has(worldId)) this.#entries.delete(worldId)
    }
    for (const world of state.worlds) {
      if ((world.source === 'patch' || world.source === 'since') && world.loadStatus === 'released') {
        this.#entries.delete(world.worldId)
      }
    }
    for (const worldId of this.#mountedViewers) {
      if (!this.#entries.has(worldId)) this.#mountedViewers.delete(worldId)
    }
  }
}

export const worldViewCache = new WorldViewCache()
