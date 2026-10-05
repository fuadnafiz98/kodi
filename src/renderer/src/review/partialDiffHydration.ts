import {
  hydratePartialDiff,
  type CodeViewItem,
  type FileContents,
  type FileDiffContentsLoader,
  type FileDiffLoadedFiles,
  type FileDiffMetadata,
  type PostRenderPhase
} from '@pierre/diffs'

import { countKodiMetric } from '../perf/kodiCounters'

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
// An item that is already on screen does not re-render while the reader
// scrolls, so its own settle timer says nothing about scrolling: every file a
// fling passed over used to fetch both whole files and take a whole-file
// highlight onto the main thread (a 35–60 ms message) mid-fling. Hydration now
// waits until the item has been rendered this long *and* nothing anywhere has
// scrolled for as long, and runs one file at a time.
const AUTO_HYDRATE_SETTLE_MS = 150
export const AUTO_HYDRATE_SCROLL_QUIET_MS = 400

let lastScrollAt = Number.NEGATIVE_INFINITY
let scrollListening = false

function listenForScroll(): void {
  if (scrollListening || typeof window === 'undefined') return
  scrollListening = true
  const note = (): void => { lastScrollAt = performance.now() }
  // Scroll events do not bubble; capturing sees the review's own scroller.
  window.addEventListener('scroll', note, { capture: true, passive: true })
  window.addEventListener('wheel', note, { capture: true, passive: true })
}

/** Milliseconds until scrolling has been quiet long enough, 0 when it already has. */
export function scrollQuietIn(now = performance.now()): number {
  return Math.max(0, lastScrollAt + AUTO_HYDRATE_SCROLL_QUIET_MS - now)
}

/** For tests: pretend the reader scrolled at `at`. */
export function noteScrollForTests(at: number): void {
  lastScrollAt = at
}

// One hydration at a time: the reader stopped on a screen of several files,
// and fetching and highlighting all of them at once was one burst of work.
let hydrationQueue: Promise<unknown> = Promise.resolve()

function queueHydration<Result>(run: () => Promise<Result>): Promise<Result> {
  const next = hydrationQueue.then(run, run)
  hydrationQueue = next.catch(() => {})
  return next
}

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

export function exceedsLineLimit(contents: string | undefined): boolean {
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
  // The prefetch is keyed by the diff, which lives as long as the review does.
  // Once nothing is going to consume it, both whole files would stay pinned
  // behind a diff that is still partial; the next settle reads them again.
  if (target.fileDiff !== fileDiff) {
    loader.discard(fileDiff)
    return true
  }
  // The viewer only waits 300 ms for the full-file highlight before it swaps the
  // hydrated diff in, so a large file flashed as plain text. Highlighting the same
  // hydrated clone first (same cache key) makes the swap a cache hit.
  await target.primeHighlightCache?.(hydratePartialDiff('clone', fileDiff, files))
  if (target.fileDiff === fileDiff && fileDiff.isPartial) target.loadFilesIfNecessary?.()
  else loader.discard(fileDiff)
  return true
}

// The items the viewer has mounted (one instance each), for work that only
// matters to what the reader can see.
const renderedItems = new Map<object, string>()

/** Call from `onPostRender`. */
export function noteReviewItemRender(instance: object, phase: PostRenderPhase, id: string): void {
  if (phase === 'unmount') renderedItems.delete(instance)
  else renderedItems.set(instance, id)
}

export function isReviewItemRendered(id: string): boolean {
  for (const rendered of renderedItems.values()) if (rendered === id) return true
  return false
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
  listenForScroll()
  const attempt = (delay: number): void => {
    settleTimers.set(instance, setTimeout(() => {
      settleTimers.delete(instance)
      const target = instance as HydratableInstance
      if (target.fileDiff !== fileDiff) return
      const wait = scrollQuietIn()
      if (wait > 0) {
        attempt(wait)
        return
      }
      const giveUp = (): void => {
        settledDiffs.add(fileDiff)
        loader.discard(fileDiff)
      }
      void queueHydration(async () => {
        // The reader may have scrolled on while this waited its turn.
        if (target.fileDiff !== fileDiff || !fileDiff.isPartial) return true
        if (scrollQuietIn() > 0) {
          attempt(scrollQuietIn())
          return true
        }
        countKodiMetric('autoHydrations')
        return hydrateWhenHighlighted(target, fileDiff, loader)
      }).then((hydrating) => {
        if (!hydrating) giveUp()
      }, giveUp)
    }, delay))
  }
  attempt(AUTO_HYDRATE_SETTLE_MS)
}
