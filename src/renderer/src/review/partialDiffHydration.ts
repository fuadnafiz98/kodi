import {
  hydratePartialDiff,
  type CodeViewItem,
  type FileContents,
  type FileDiffContentsLoader,
  type FileDiffLoadedFiles,
  type FileDiffMetadata,
  type PostRenderPhase
} from '@pierre/diffs'

// A patch-parsed diff only carries its hunks, and the viewer tokenizes each hunk
// on its own. Any hunk that starts inside a block comment, docstring or template
// literal is highlighted from the wrong grammar state: a closing `"""` reads as
// an opening one and every line after it turns into a string. Only the whole
// file can say which state a hunk starts in, so a partial diff on screen is
// hydrated once the reader has settled on it.

export type DiffSide = 'old' | 'new'

export interface DiffSideSource {
  side: DiffSide
  load(): Promise<FileContents | null>
}

export interface PartialDiffLoader {
  /** The viewer's `loadDiffFiles`: consumes a prefetched result when there is one. */
  load: FileDiffContentsLoader
  prefetch(fileDiff: FileDiffMetadata): Promise<FileDiffLoadedFiles>
  discard(fileDiff: FileDiffMetadata): void
}

// The full-file AST arrives on the main thread in one structured-clone message:
// ~35 ms for a 3,000-line file, a 60 ms long task at 4,000. Past this the patch
// view stays as it was until the reader expands it.
export const AUTO_HYDRATE_MAX_LINES = 3_000
// Scrolling re-renders every visible item each frame, which restarts the wait:
// hydration only starts once the view has been still this long.
const AUTO_HYDRATE_SETTLE_MS = 150

function splitFileLines(contents: string): string[] {
  return contents === '' ? [] : contents.split(/(?<=\n)/)
}

function sameLine(patchLine: string | undefined, fileLine: string | undefined): boolean {
  return patchLine != null && fileLine != null
    && patchLine.replace(/\r?\n$/, '') === fileLine.replace(/\r?\n$/, '')
}

function hunkStartIndex(start: number, count: number): number {
  return start - (count === 0 ? 0 : 1)
}

function sideRange(hunk: FileDiffMetadata['hunks'][number], side: DiffSide): { start: number; count: number } {
  return side === 'new'
    ? { start: hunkStartIndex(hunk.additionStart, hunk.additionCount), count: hunk.additionCount }
    : { start: hunkStartIndex(hunk.deletionStart, hunk.deletionCount), count: hunk.deletionCount }
}

function contentSpan(
  content: FileDiffMetadata['hunks'][number]['hunkContent'][number],
  side: DiffSide
): { index: number; count: number } {
  const index = side === 'new' ? content.additionLineIndex : content.deletionLineIndex
  if (content.type === 'context') return { index, count: content.lines }
  return { index, count: side === 'new' ? content.additions : content.deletions }
}

/** True when every line the patch shows for `side` sits in `lines` where its hunk says. */
export function patchMatchesFileLines(fileDiff: FileDiffMetadata, side: DiffSide, lines: readonly string[]): boolean {
  const patchLines = side === 'new' ? fileDiff.additionLines : fileDiff.deletionLines
  for (const hunk of fileDiff.hunks) {
    let position = sideRange(hunk, side).start
    for (const content of hunk.hunkContent) {
      const { index, count } = contentSpan(content, side)
      for (let offset = 0; offset < count; offset += 1) {
        if (!sameLine(patchLines[index + offset], lines[position + offset])) return false
      }
      position += count
    }
  }
  return true
}

/**
 * Rebuilds the other side of a file from one complete side and the hunks. Lines
 * outside the hunks are unchanged by definition, so one readable version is
 * enough — a pull request's merge base need not exist locally.
 */
export function reconstructFileSide(fileDiff: FileDiffMetadata, known: DiffSide, lines: readonly string[]): string {
  const other: DiffSide = known === 'new' ? 'old' : 'new'
  const otherLines = other === 'new' ? fileDiff.additionLines : fileDiff.deletionLines
  const output: string[] = []
  let cursor = 0
  for (const hunk of fileDiff.hunks) {
    const { start, count } = sideRange(hunk, known)
    for (; cursor < start; cursor += 1) output.push(lines[cursor]!)
    for (const content of hunk.hunkContent) {
      const { index, count: otherCount } = contentSpan(content, other)
      for (let offset = 0; offset < otherCount; offset += 1) output.push(otherLines[index + offset]!)
    }
    cursor = start + count
  }
  for (; cursor < lines.length; cursor += 1) output.push(lines[cursor]!)
  return output.join('')
}

/** The first source whose contents agree with the patch supplies both sides. */
export async function loadPartialDiffFiles(
  fileDiff: FileDiffMetadata,
  sources: readonly DiffSideSource[]
): Promise<FileDiffLoadedFiles> {
  for (const source of sources) {
    const file = await source.load()
    if (file == null) continue
    if (fileDiff.type === 'rename-pure') {
      if (source.side === 'new') return { oldFile: null, newFile: file }
      continue
    }
    const lines = splitFileLines(file.contents)
    if (!patchMatchesFileLines(fileDiff, source.side, lines)) continue
    const reconstructed: FileContents = {
      name: source.side === 'new' ? fileDiff.prevName ?? fileDiff.name : fileDiff.name,
      contents: reconstructFileSide(fileDiff, source.side, lines),
      ...(file.cacheKey == null ? {} : { cacheKey: `${file.cacheKey}:${source.side === 'new' ? 'old' : 'new'}` })
    }
    return source.side === 'new'
      ? { oldFile: reconstructed, newFile: file }
      : { oldFile: file, newFile: reconstructed }
  }
  throw new Error(`No readable version of ${fileDiff.name} matches its patch.`)
}

export function createPartialDiffLoader(
  load: (fileDiff: FileDiffMetadata) => Promise<FileDiffLoadedFiles>
): PartialDiffLoader {
  const prefetched = new WeakMap<FileDiffMetadata, Promise<FileDiffLoadedFiles>>()
  return {
    load(fileDiff) {
      const pending = prefetched.get(fileDiff)
      prefetched.delete(fileDiff)
      return pending ?? load(fileDiff)
    },
    prefetch(fileDiff) {
      let pending = prefetched.get(fileDiff)
      if (pending == null) {
        pending = load(fileDiff)
        prefetched.set(fileDiff, pending)
      }
      return pending
    },
    discard(fileDiff) {
      prefetched.delete(fileDiff)
    }
  }
}

function exceedsLineLimit(contents: string | undefined): boolean {
  if (contents == null) return false
  let newlines = 0
  for (let index = contents.indexOf('\n'); index !== -1; index = contents.indexOf('\n', index + 1)) {
    newlines += 1
    if (newlines > AUTO_HYDRATE_MAX_LINES) return true
  }
  return false
}

export function canAutoHydrate(fileDiff: FileDiffMetadata): boolean {
  return fileDiff.isPartial && fileDiff.hunks.length > 0
    && (fileDiff.type === 'change' || fileDiff.type === 'rename-changed')
}

interface HydratableInstance {
  fileDiff?: FileDiffMetadata
  loadFilesIfNecessary?(): void
  primeHighlightCache?(fileDiff?: FileDiffMetadata): Promise<void>
}

async function hydrateWhenHighlighted(
  target: HydratableInstance,
  fileDiff: FileDiffMetadata,
  loader: PartialDiffLoader
): Promise<boolean> {
  const files = await loader.prefetch(fileDiff)
  if (exceedsLineLimit(files.oldFile?.contents) || exceedsLineLimit(files.newFile.contents)) return false
  if (target.fileDiff !== fileDiff) return true
  // The viewer only waits 300 ms for the full-file highlight before it swaps the
  // hydrated diff in, so a large file flashed as plain text. Highlighting the same
  // hydrated clone first (same cache key) makes the swap a cache hit.
  await target.primeHighlightCache?.(hydratePartialDiff('clone', fileDiff, files))
  if (target.fileDiff === fileDiff && fileDiff.isPartial) target.loadFilesIfNecessary?.()
  return true
}

const settleTimers = new WeakMap<object, ReturnType<typeof setTimeout>>()
// A file that cannot be hydrated — nothing readable matches, or it is too big —
// is not asked about again while its diff object lives.
const settledDiffs = new WeakSet<FileDiffMetadata>()

/** Call from `onPostRender`: hydrates the rendered partial diff once scrolling settles. */
export function schedulePartialDiffHydration(
  instance: object,
  phase: PostRenderPhase,
  item: CodeViewItem<unknown>,
  loader: PartialDiffLoader | undefined
): void {
  const timer = settleTimers.get(instance)
  if (timer != null) {
    clearTimeout(timer)
    settleTimers.delete(instance)
  }
  if (phase === 'unmount' || loader == null || item.type !== 'diff') return
  const { fileDiff } = item
  if (!canAutoHydrate(fileDiff) || settledDiffs.has(fileDiff)) return
  settleTimers.set(instance, setTimeout(() => {
    settleTimers.delete(instance)
    const target = instance as HydratableInstance
    if (target.fileDiff !== fileDiff) return
    const giveUp = (): void => {
      settledDiffs.add(fileDiff)
      loader.discard(fileDiff)
    }
    hydrateWhenHighlighted(target, fileDiff, loader).then((hydrating) => {
      if (!hydrating) giveUp()
    }, giveUp)
  }, AUTO_HYDRATE_SETTLE_MS))
}
