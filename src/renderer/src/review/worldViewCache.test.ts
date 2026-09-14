import { afterEach, expect, test } from 'bun:test'

import {
  estimateConversationBytes,
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
