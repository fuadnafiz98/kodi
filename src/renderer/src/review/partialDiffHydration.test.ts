import { expect, test } from 'bun:test'
import {
  getSharedHighlighter,
  hydratePartialDiff,
  parsePatchFiles,
  renderDiffWithHighlighter,
  type FileContents,
  type FileDiffMetadata
} from '@pierre/diffs'

import {
  AUTO_HYDRATE_MAX_LINES,
  createPartialDiffLoader,
  loadPartialDiffFiles,
  patchMatchesFileLines,
  reconstructFileSide,
  schedulePartialDiffHydration,
  type DiffSideSource
} from './partialDiffHydration'

function lines(count: number, render: (index: number) => string): string {
  return Array.from({ length: count }, (_, index) => `${render(index + 1)}\n`).join('')
}

// A docstring opens in the first hunk and closes in the second, so the second
// hunk's closing `"""` reads as an opening one when that hunk is tokenized alone.
const OLD_PY = `def f():\n    x = 1\n    """docstring start\n${lines(12, (index) => `    doc line ${index}`)}    """\n    tail = 1\n${lines(4, (index) => `    v${index} = call(${index})`)}`
const NEW_PY = OLD_PY.replace('x = 1', 'x = 5').replace('tail = 1', 'tail = 9')
const PY_PATCH = [
  'diff --git a/q.py b/q.py',
  'index d490634..df6bf9f 100644',
  '--- a/q.py',
  '+++ b/q.py',
  '@@ -1,5 +1,5 @@',
  ' def f():',
  '-    x = 1',
  '+    x = 5',
  '     """docstring start',
  '     doc line 1',
  '     doc line 2',
  '@@ -14,7 +14,7 @@ def f():',
  '     doc line 11',
  '     doc line 12',
  '     """',
  '-    tail = 1',
  '+    tail = 9',
  '     v1 = call(1)',
  '     v2 = call(2)',
  '     v3 = call(3)',
  ''
].join('\n')

const OLD_TXT = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl'
const NEW_TXT = 'a\nc\nd\ne\nf\ng\nh\ni\nj\nk\nL'
const TXT_PATCH = [
  'diff --git a/n.txt b/n.txt',
  'index 26dc1c6..0c75517 100644',
  '--- a/n.txt',
  '+++ b/n.txt',
  '@@ -1,5 +1,4 @@',
  ' a',
  '-b',
  ' c',
  ' d',
  ' e',
  '@@ -9,4 +8,4 @@ h',
  ' i',
  ' j',
  ' k',
  '-l',
  '\\ No newline at end of file',
  '+L',
  '\\ No newline at end of file',
  ''
].join('\n')

const ZERO_CONTEXT_NEW = 'a\nb\nX\nY\nc\nd\ne\nf\ng\nh\ni\nj\nk\n'
const ZERO_CONTEXT_PATCH = [
  'diff --git a/n.txt b/n.txt',
  'index 26dc1c6..7e7a6e3 100644',
  '--- a/n.txt',
  '+++ b/n.txt',
  '@@ -2,0 +3,2 @@ b',
  '+X',
  '+Y',
  '@@ -12 +13,0 @@ k',
  '-l',
  '\\ No newline at end of file',
  ''
].join('\n')

function parsePartial(patch: string): FileDiffMetadata {
  const fileDiff = parsePatchFiles(patch, 'test')[0]!.files[0]!
  expect(fileDiff.isPartial).toBe(true)
  return fileDiff
}

function file(name: string, contents: string): FileContents {
  return { name, contents, cacheKey: `${name}:${contents.length}` }
}

function split(contents: string): string[] {
  return contents.split(/(?<=\n)/)
}

test('either side of a file rebuilds the other from the hunks', () => {
  for (const [patch, oldContents, newContents] of [
    [PY_PATCH, OLD_PY, NEW_PY],
    [TXT_PATCH, OLD_TXT, NEW_TXT],
    [ZERO_CONTEXT_PATCH, OLD_TXT, ZERO_CONTEXT_NEW]
  ] as const) {
    const fileDiff = parsePartial(patch)
    expect(patchMatchesFileLines(fileDiff, 'new', split(newContents))).toBe(true)
    expect(patchMatchesFileLines(fileDiff, 'old', split(oldContents))).toBe(true)
    expect(reconstructFileSide(fileDiff, 'new', split(newContents)).replace(/\n$/, ''))
      .toBe(oldContents.replace(/\n$/, ''))
    expect(reconstructFileSide(fileDiff, 'old', split(oldContents)).replace(/\n$/, ''))
      .toBe(newContents.replace(/\n$/, ''))
  }
})

test('a version that no longer matches the patch is skipped for the next source', async () => {
  const fileDiff = parsePartial(PY_PATCH)
  const stale = NEW_PY.replace('    doc line 12\n', '    doc line 12\n    inserted since\n')
  expect(patchMatchesFileLines(fileDiff, 'new', split(stale))).toBe(false)

  const reads: string[] = []
  const sources: DiffSideSource[] = [
    { side: 'new', load: async () => { reads.push('new'); return file('q.py', stale) } },
    { side: 'old', load: async () => { reads.push('old'); return file('q.py', OLD_PY) } }
  ]
  const files = await loadPartialDiffFiles(fileDiff, sources)
  expect(reads).toEqual(['new', 'old'])
  expect(files.oldFile?.contents).toBe(OLD_PY)
  expect(files.newFile.contents).toBe(NEW_PY)
})

test('a file with no readable matching version is rejected', async () => {
  const fileDiff = parsePartial(PY_PATCH)
  await expect(loadPartialDiffFiles(fileDiff, [
    { side: 'new', load: async () => null },
    { side: 'old', load: async () => file('q.py', 'unrelated\n') }
  ])).rejects.toThrow('q.py')
})

function fakeInstance(fileDiff: FileDiffMetadata): {
  fileDiff: FileDiffMetadata
  events: string[]
  primeHighlightCache(diff?: FileDiffMetadata): Promise<void>
  loadFilesIfNecessary(): void
} {
  const events: string[] = []
  return {
    fileDiff,
    events,
    async primeHighlightCache(diff) { events.push(`prime:${diff?.isPartial === false ? 'hydrated' : 'partial'}`) },
    loadFilesIfNecessary() { events.push('load') }
  }
}

test('a settled partial diff is highlighted in full before the viewer swaps it in', async () => {
  const fileDiff = parsePartial(PY_PATCH)
  let reads = 0
  const loader = createPartialDiffLoader((diff) => {
    reads += 1
    return loadPartialDiffFiles(diff, [{ side: 'new', load: async () => file('q.py', NEW_PY) }])
  })
  const instance = fakeInstance(fileDiff)
  const item = { id: 'review:q.py', type: 'diff', fileDiff } as const

  schedulePartialDiffHydration(instance, 'mount', item, loader)
  schedulePartialDiffHydration(instance, 'update', item, loader)
  await Bun.sleep(250)
  expect(instance.events).toEqual(['prime:hydrated', 'load'])
  // The viewer's own load consumes the prefetched files instead of reading again.
  await loader.load(fileDiff)
  expect(reads).toBe(1)
})

test('an unmounted or oversized diff is left as the patch', async () => {
  const unmounted = fakeInstance(parsePartial(PY_PATCH))
  const loader = createPartialDiffLoader((diff) =>
    loadPartialDiffFiles(diff, [{ side: 'new', load: async () => file('q.py', NEW_PY) }]))
  const unmountedItem = { id: 'review:q.py', type: 'diff', fileDiff: unmounted.fileDiff } as const
  schedulePartialDiffHydration(unmounted, 'mount', unmountedItem, loader)
  schedulePartialDiffHydration(unmounted, 'unmount', unmountedItem, loader)

  const padding = lines(AUTO_HYDRATE_MAX_LINES, (index) => `pad = ${index}`)
  const oversized = fakeInstance(parsePartial(PY_PATCH))
  const oversizedLoader = createPartialDiffLoader((diff) =>
    loadPartialDiffFiles(diff, [{ side: 'new', load: async () => file('q.py', NEW_PY + padding) }]))
  schedulePartialDiffHydration(oversized, 'mount', { id: 'review:q.py', type: 'diff', fileDiff: oversized.fileDiff }, oversizedLoader)

  await Bun.sleep(250)
  expect(unmounted.events).toEqual([])
  expect(oversized.events).toEqual([])
})

test('a docstring closing between hunks no longer swallows the code after it', async () => {
  const highlighter = await getSharedHighlighter({ themes: ['pierre-dark'], langs: ['python'] })
  const options = {
    theme: 'pierre-dark',
    lineDiffType: 'none',
    maxLineDiffLength: 1_000,
    tokenizeMaxLineLength: 2_000,
    useTokenTransformer: false
  } as const
  const text = (node: unknown): string => {
    const element = node as { type: string; value?: string; children?: unknown[] }
    return element.type === 'text' ? element.value ?? '' : (element.children ?? []).map(text).join('')
  }
  const colors = (node: unknown, found: string[] = []): string[] => {
    const element = node as { properties?: { style?: string }; children?: unknown[] }
    if (typeof element.properties?.style === 'string') found.push(element.properties.style)
    for (const child of element.children ?? []) colors(child, found)
    return found
  }
  const colorsOf = (fileDiff: FileDiffMetadata, content: string): string[] => {
    const { code } = renderDiffWithHighlighter(fileDiff, highlighter, options)
    const line = code.additionLines.find((node) => node != null && text(node).trim() === content)
    expect(line).toBeDefined()
    return colors(line)
  }

  const partial = parsePartial(PY_PATCH)
  const docstringColor = colorsOf(partial, 'doc line 1')
  // The bug: tokenized on its own, the second hunk turns `tail = 9` into a string.
  expect(colorsOf(partial, 'tail = 9')).toEqual(docstringColor)

  const files = await loadPartialDiffFiles(partial, [{ side: 'new', load: async () => file('q.py', NEW_PY) }])
  const hydrated = hydratePartialDiff('clone', partial, files)
  expect(hydrated.isPartial).toBe(false)
  expect(colorsOf(hydrated, 'tail = 9')).not.toEqual(docstringColor)
  expect(colorsOf(hydrated, 'doc line 12')).toEqual(docstringColor)
})
