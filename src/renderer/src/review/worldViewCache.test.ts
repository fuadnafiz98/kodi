import { afterEach, expect, test } from 'bun:test'
import { hydratePartialDiff, parsePatchFiles, type CodeViewItem } from '@pierre/diffs'

import { boundInactivePatchPayloads, createPatchWorld, type WorldRegistryState } from './useReviewWorlds'
import type { PullRequestReview, RepositorySnapshot } from '../../../shared/contracts'
import {
  estimateConversationBytes,
  estimateHydratedDiffBytes,
  estimateParsedGraphBytes,
  estimateViewerBytes,
  itemsForRetainedWorld,
  MAX_RETAINED_WORLD_VIEWERS,
  PARSED_ITEM_OVERHEAD_BYTES,
  retainWorldViewers,
  reuseAnnotatedItems,
  takeCachedAnnotatedDerivation,
  VIEWER_INSTANCE_OVERHEAD_BYTES,
  VIEWER_ITEM_BYTES,
  WorldViewCache
} from './worldViewCache'

afterEach(() => {
  // The module singleton is unused here; keep isolation obvious.
})

test('parsed graph bytes charge each item id plus a fixed object-graph overhead', () => {
  expect(estimateParsedGraphBytes([])).toBe(0)
  expect(estimateParsedGraphBytes([{ id: 'ab' }])).toBe(4 + PARSED_ITEM_OVERHEAD_BYTES)
  expect(estimateParsedGraphBytes([{ id: 'a' }, { id: 'bcd' }])).toBe(
    2 + 6 + PARSED_ITEM_OVERHEAD_BYTES * 2
  )
})

test('remembered items report graph bytes and drop when the world is released', () => {
  const cache = new WorldViewCache()
  cache.rememberParsed('patch:one', {
    kind: 'string',
    parseKey: 'pr-1',
    patchLength: 12,
    tail: 'tail',
    items: [{ id: 'review:src/a.ts' } as never]
  })
  cache.rememberCollapsed('patch:one', new Set(['review:src/a.ts']))
  expect(cache.graphBytes('patch:one')).toBe(estimateParsedGraphBytes([{ id: 'review:src/a.ts' }]))
  expect(cache.get('patch:one')?.collapsedItemIds).toEqual(new Set(['review:src/a.ts']))

  cache.sync({
    worlds: [{
      source: 'patch',
      worldId: 'patch:one',
      loadStatus: 'released'
    }]
  })
  expect(cache.get('patch:one')).toBeUndefined()
  expect(cache.graphBytes('patch:one')).toBe(0)
})

test('conversation bytes are charged and annotated items reuse the same base array', () => {
  const cache = new WorldViewCache()
  const items = [{ id: 'review:src/a.ts' } as never]
  const conversation = {
    available: true,
    message: null,
    body: 'Hello',
    headOid: 'a'.repeat(40),
    threads: [],
    reviews: []
  }
  cache.rememberParsed('patch:one', {
    kind: 'string',
    parseKey: 'pr-1',
    patchLength: 12,
    tail: 'tail',
    items
  })
  cache.rememberConversation('patch:one', conversation)
  const annotatedCache = new Map()
  cache.rememberAnnotated('patch:one', {
    baseItems: items,
    items,
    cache: annotatedCache
  })
  expect(cache.graphBytes('patch:one')).toBe(
    estimateParsedGraphBytes(items) + estimateConversationBytes(conversation)
  )
  expect(reuseAnnotatedItems(cache.get('patch:one')?.annotated, items)).toBe(items)
  expect(reuseAnnotatedItems(cache.get('patch:one')?.annotated, [{ id: 'review:src/a.ts' } as never])).toBeNull()
  const hit = takeCachedAnnotatedDerivation(cache.get('patch:one')?.annotated, items)
  expect(hit?.items).toBe(items)
  expect(hit?.cache).toBe(annotatedCache)
  expect(takeCachedAnnotatedDerivation(cache.get('patch:one')?.annotated, [{ id: 'review:src/a.ts' } as never])).toBeNull()
})

test('sync drops cache entries for worlds that left the registry', () => {
  const cache = new WorldViewCache()
  cache.rememberParsed('gone', {
    kind: 'pages',
    parseKey: 'pr-2',
    pageRefs: ['page'],
    items: [{ id: 'review:src/b.ts' } as never]
  })
  cache.sync({ worlds: [] })
  expect(cache.get('gone')).toBeUndefined()
})

test('retainWorldViewers keeps the last N worlds and returns the same array when unchanged', () => {
  const first = retainWorldViewers([], 'a')
  expect(first).toEqual(['a'])
  const second = retainWorldViewers(first, 'b')
  expect(second).toEqual(['b', 'a'])
  const third = retainWorldViewers(second, 'c')
  expect(third).toEqual(['c', 'b', 'a'])
  expect(retainWorldViewers(third, 'c')).toBe(third)
  const fourth = retainWorldViewers(third, 'd')
  expect(fourth).toEqual(['d', 'c', 'b'])
  expect(fourth).toHaveLength(MAX_RETAINED_WORLD_VIEWERS)
  expect(retainWorldViewers(fourth, 'a')).toEqual(['a', 'd', 'c'])
})

test('hidden retained worlds keep their own items so a cache-hit return does not swap the outgoing list', () => {
  const worldA = [{ id: 'review:a.ts' }]
  const worldB = [{ id: 'review:b.ts' }]
  expect(itemsForRetainedWorld('a', 'b', worldB, worldA)).toBe(worldA)
  expect(itemsForRetainedWorld('b', 'b', worldB, worldA)).toBe(worldB)
  expect(itemsForRetainedWorld('a', 'a', [], worldA)).toBeNull()
  expect(itemsForRetainedWorld('c', 'a', worldA, null)).toBeNull()
})

test('mounted viewers add estimated viewer bytes and drop them on LRU evict', () => {
  const cache = new WorldViewCache()
  const items = [{ id: 'review:src/a.ts' }, { id: 'review:src/b.ts' }] as never[]
  cache.rememberParsed('patch:one', {
    kind: 'string',
    parseKey: 'pr-1',
    patchLength: 12,
    tail: 'tail',
    items
  })
  const graphOnly = estimateParsedGraphBytes(items)
  expect(cache.graphBytes('patch:one')).toBe(graphOnly)
  cache.retainMountedViewers(['patch:one'])
  expect(cache.viewerMounted('patch:one')).toBe(true)
  expect(cache.graphBytes('patch:one')).toBe(graphOnly + estimateViewerBytes(items.length))
  expect(estimateViewerBytes(items.length)).toBe(VIEWER_INSTANCE_OVERHEAD_BYTES + VIEWER_ITEM_BYTES * 2)
  cache.retainMountedViewers([])
  expect(cache.viewerMounted('patch:one')).toBe(false)
  expect(cache.graphBytes('patch:one')).toBe(graphOnly)
  cache.retainMountedViewers(['patch:one'])
  cache.sync({
    worlds: [{
      source: 'patch',
      worldId: 'patch:one',
      loadStatus: 'released'
    }]
  })
  expect(cache.viewerMounted('patch:one')).toBe(false)
  expect(cache.graphBytes('patch:one')).toBe(0)
})

const OLD_FILE = Array.from({ length: 400 }, (_, index) => `const value${index} = ${index}\n`).join('')
const NEW_FILE = OLD_FILE.replace('const value1 = 1\n', 'const value1 = 100\n')
const PARTIAL_PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const value0 = 0',
  '-const value1 = 1',
  '+const value1 = 100',
  ' const value2 = 2',
  ''
].join('\n')

function partialItem(): CodeViewItem<unknown> & { type: 'diff' } {
  const fileDiff = parsePatchFiles(PARTIAL_PATCH, 'test')[0]!.files[0]!
  return { id: 'review:src/a.ts', type: 'diff', fileDiff }
}

function hydrate(item: CodeViewItem<unknown> & { type: 'diff' }): void {
  // What the viewer does once both files load: merge them into the same object.
  hydratePartialDiff('merge', item.fileDiff, {
    oldFile: { name: 'src/a.ts', contents: OLD_FILE },
    newFile: { name: 'src/a.ts', contents: NEW_FILE }
  })
}

test('a hydrated diff is charged for both whole files it now carries', () => {
  const item = partialItem()
  const flat = estimateParsedGraphBytes([{ id: item.id }])
  expect(estimateParsedGraphBytes([item])).toBe(flat)
  hydrate(item)
  expect(estimateHydratedDiffBytes(item.fileDiff)).toBe((OLD_FILE.length + NEW_FILE.length) * 2)
  expect(estimateParsedGraphBytes([item])).toBe(flat + (OLD_FILE.length + NEW_FILE.length) * 2)
})

test('hydration after the seed was remembered still reaches the evictor', () => {
  const cache = new WorldViewCache()
  const item = partialItem()
  cache.rememberParsed('patch:one', {
    kind: 'string',
    parseKey: 'pr-1',
    patchLength: PARTIAL_PATCH.length,
    tail: '',
    items: [item as never]
  })
  const before = cache.graphBytes('patch:one')
  hydrate(item)
  expect(cache.graphBytes('patch:one')).toBe(before + (OLD_FILE.length + NEW_FILE.length) * 2)

  const snapshot = { root: '/repo', name: 'repo', kind: 'git', branch: 'main', head: 'h', paths: [], statuses: [] } as RepositorySnapshot
  const review = (number: number, patch: string) => ({
    kind: 'github',
    selector: String(number),
    baseOid: `base-${number}`,
    headOid: `head-${number}`,
    pullRequest: { number, url: `https://github.com/acme/repo/pull/${number}` },
    files: [],
    patch,
    omittedFiles: [],
    expectedFileCount: 0
  }) as unknown as PullRequestReview
  const inactive = { ...createPatchWorld(snapshot, review(1, PARTIAL_PATCH), 1, 'ready'), worldId: 'patch:one' }
  const active = createPatchWorld(snapshot, review(2, ''), 1, 'ready')
  const state: WorldRegistryState = { worlds: [inactive, active], activeWorldId: active.worldId }
  // A ceiling the patch and its flat item charge fit under, but not the files.
  const ceiling = PARTIAL_PATCH.length + before + 1_024
  const bounded = boundInactivePatchPayloads(state, ceiling, (worldId) => cache.graphBytes(worldId))
  expect(bounded.worlds[0]?.source === 'patch' ? bounded.worlds[0].loadStatus : null).toBe('released')
})

test('only the world in front is charged for a viewer', () => {
  const cache = new WorldViewCache()
  const items = [{ id: 'review:src/a.ts' }] as never[]
  for (const worldId of ['patch:one', 'patch:two']) {
    cache.rememberParsed(worldId, { kind: 'pages', parseKey: worldId, pageRefs: [], items })
  }
  const graphOnly = estimateParsedGraphBytes(items)
  cache.retainMountedViewers(['patch:one'])
  expect(cache.graphBytes('patch:one')).toBe(graphOnly + estimateViewerBytes(items.length))
  // Focus moves to a world whose viewer has not mounted yet: the one that went
  // behind lost its Pierre instance with the hide, so it stops paying for one.
  cache.retainFrontViewer('patch:two')
  expect(cache.viewerMounted('patch:one')).toBe(false)
  expect(cache.graphBytes('patch:one')).toBe(graphOnly)
  cache.retainMountedViewers(['patch:two'])
  cache.retainFrontViewer('patch:two')
  expect(cache.viewerMounted('patch:two')).toBe(true)
})
