import { describe, expect, it } from 'bun:test'
import { FileTree } from '@pierre/trees'

import {
  applyTreePathDelta,
  diffTreePaths,
  expandDirectories,
  expandedDirectoryPaths,
  getDirectoryPaths,
  PER_ITEM_EXPANSION_LIMIT,
  setAllDirectoriesExpanded
} from './treeExpansion'

// The shape that froze the window: one untracked tool checkout (`imux/`) with
// a thousand folders next to ordinary source. Built against the real tree model
// rather than a fake, because the bug lived in how often *it* notifies.
function largeTree(): { paths: string[]; directories: string[] } {
  const paths: string[] = ['README.md', 'src/app.ts', 'src/lib/util.ts']
  for (let a = 0; a < 40; a += 1) {
    for (let b = 0; b < 25; b += 1) {
      for (let c = 0; c < 25; c += 1) paths.push(`imux/m${a}/s${b}/f${c}.ts`)
    }
  }
  paths.sort()
  return { paths, directories: getDirectoryPaths(paths) }
}

function observed(model: FileTree): { notifications(): number; slowestListenerMs(): number } {
  let count = 0
  let slowest = 0
  model.subscribe(() => {
    count += 1
    const started = performance.now()
    // What the explorer's own listener does on every notification.
    for (const path of model.getVisibleRows(0, 40)) void path
    slowest = Math.max(slowest, performance.now() - started)
  })
  return { notifications: () => count, slowestListenerMs: () => slowest }
}

describe('bulk tree expansion', () => {
  it('expands every folder of a large tree with one notification', () => {
    const { paths, directories } = largeTree()
    expect(directories.length).toBeGreaterThan(1_000)
    const model = new FileTree({ paths, initialExpansion: 0, flattenEmptyDirectories: true })
    const watch = observed(model)

    const started = performance.now()
    setAllDirectoriesExpanded(model, paths, directories, true)
    const elapsed = performance.now() - started

    expect(watch.notifications()).toBe(1)
    expect(expandedDirectoryPaths(model, directories)).toHaveLength(directories.length)
    expect(model.getVisibleCount()).toBe(paths.length + directories.length)
    // Generous for CI; the per-folder version took seconds here.
    expect(elapsed).toBeLessThan(1_000)
  })

  it('collapses every folder, including the top level a plain folder reopens', () => {
    const { paths, directories } = largeTree()
    const model = new FileTree({ paths, initialExpansion: 1, flattenEmptyDirectories: true })
    setAllDirectoriesExpanded(model, paths, directories, true)
    const watch = observed(model)

    setAllDirectoriesExpanded(model, paths, directories, false)

    expect(expandedDirectoryPaths(model, directories)).toEqual([])
    // One rebuild plus the handful of top-level folders the base expansion opened.
    expect(watch.notifications()).toBeLessThanOrEqual(1 + directories.filter((path) => !path.includes('/')).length)
  })

  it('opens a burst of changed folders in one rebuild and keeps what was already open', () => {
    const { paths, directories } = largeTree()
    const model = new FileTree({ paths, initialExpansion: 0, flattenEmptyDirectories: true })
    expandDirectories(model, paths, directories, ['src', 'src/lib'])
    const watch = observed(model)

    const changed = directories.filter((path) => path.startsWith('imux'))
    expandDirectories(model, paths, directories, changed)

    expect(watch.notifications()).toBe(1)
    const open = new Set(expandedDirectoryPaths(model, directories))
    expect(open.has('src/lib')).toBe(true)
    expect(changed.every((path) => open.has(path))).toBe(true)
  })

  it('opens a few folders in place without rebuilding the tree', () => {
    const { paths, directories } = largeTree()
    const model = new FileTree({ paths, initialExpansion: 0, flattenEmptyDirectories: true })
    model.focusPath('README.md')
    const watch = observed(model)

    expandDirectories(model, paths, directories, ['src', 'src/lib'])

    expect(watch.notifications()).toBeLessThanOrEqual(PER_ITEM_EXPANSION_LIMIT)
    expect(model.getFocusedPath()).toBe('README.md')
    expect(expandedDirectoryPaths(model, directories)).toEqual(['src', 'src/lib'])
  })

  it('does nothing when every target is already open', () => {
    const { paths, directories } = largeTree()
    const model = new FileTree({ paths, initialExpansion: 0, flattenEmptyDirectories: true })
    expandDirectories(model, paths, directories, ['src'])
    const watch = observed(model)
    expandDirectories(model, paths, directories, ['src'])
    expect(watch.notifications()).toBe(0)
  })
})

describe('incremental tree path updates', () => {
  it('finds a single added and removed path by the shared head and tail', () => {
    const previous = ['a/1.ts', 'a/2.ts', 'b/1.ts', 'c/1.ts']
    const next = ['a/1.ts', 'b/1.ts', 'b/2.ts', 'c/1.ts']
    expect(diffTreePaths(previous, next)).toEqual({ added: ['b/2.ts'], removed: ['a/2.ts'] })
    expect(diffTreePaths(previous, previous)).toEqual({ added: [], removed: [] })
  })

  it('gives up on a delta past the limit, which a rebuild handles better', () => {
    const previous = Array.from({ length: 50 }, (_unused, index) => `a/${index}.ts`)
    expect(diffTreePaths(previous, [], 10)).toBeNull()
  })

  it('applies a new file in one notification and keeps every folder the reader opened', () => {
    const { paths, directories } = largeTree()
    const model = new FileTree({ paths, initialExpansion: 0, flattenEmptyDirectories: true })
    expandDirectories(model, paths, directories, ['imux', 'imux/m3', 'imux/m3/s2', 'src'])
    const before = expandedDirectoryPaths(model, directories)
    const watch = observed(model)

    const next = [...paths, 'imux/m3/s2/new.ts', 'fresh/deep/file.ts'].sort()
    const delta = diffTreePaths(paths, next)!
    applyTreePathDelta(model, delta, getDirectoryPaths(next))

    expect(watch.notifications()).toBe(1)
    expect(expandedDirectoryPaths(model, directories)).toEqual(before)
    expect(model.getItem('imux/m3/s2/new.ts')).not.toBeNull()
    expect(model.getItem('fresh/deep/file.ts')).not.toBeNull()
  })

  it('removes a folder whose last file went, instead of leaving it empty', () => {
    const { paths } = largeTree()
    const model = new FileTree({ paths, initialExpansion: 0, flattenEmptyDirectories: true })
    const next = paths.filter((path) => !path.startsWith('imux/m3/s1/'))
    applyTreePathDelta(model, diffTreePaths(paths, next)!, getDirectoryPaths(next))

    expect(model.getItem('imux/m3/s1')).toBeNull()
    expect(model.getItem('imux/m3/s2')).not.toBeNull()
    expect(model.getItem('imux/m3')).not.toBeNull()
  })

  it('is far cheaper than the reset it replaces on a large tree', () => {
    const { paths } = largeTree()
    const model = new FileTree({ paths, initialExpansion: 0, flattenEmptyDirectories: true })
    const next = [...paths, 'imux/m3/s2/new.ts'].sort()
    const started = performance.now()
    applyTreePathDelta(model, diffTreePaths(paths, next)!, getDirectoryPaths(next))
    const batchMs = performance.now() - started
    const resetStarted = performance.now()
    model.resetPaths(next)
    const resetMs = performance.now() - resetStarted
    expect(batchMs).toBeLessThan(resetMs)
  })
})
