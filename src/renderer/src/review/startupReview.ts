import { getFiletypeFromFileName, resolveLanguages, resolveThemes, type CodeViewItem, type SupportedLanguages } from '@pierre/diffs'
import { getOrCreateWorkerPoolSingleton } from '@pierre/diffs/worker'

import type { OmittedDiffFile, RepositorySnapshot } from '../../../shared/contracts'
import { initialWorkspacePaint } from '../../../shared/workspaceCache'
import { DIFF_HIGHLIGHTER_OPTIONS, DIFF_WORKER_POOL_OPTIONS } from '../diff/diffWorkerConfig'
import { compareTreePaths } from '../explorer/treePathOrder'
import { loadPreferences } from '../settings/preferences'
import type { ReviewAnnotationMetadata } from './ReviewComments'
import { createPatchReviewItems, primeReviewHighlights } from './reviewItems'
import { peekStartupReviewRequest, takeStartupReviewRequest } from './startupReviewRequest'
import { rememberStartupTheme, seedStartupTheme } from './startupTheme'

/**
 * A launch's first screen, started from the entry chunk while the boot chunk is
 * still on its way. The viewer used to start everything it needed once it had
 * mounted, one step after another: ask main for the patch, draw the files as
 * plain text, then load the worker, the theme and the grammar and recolour
 * them — about 180 ms after the viewer mounted, with the window waiting on it.
 * Here the worker warms up at once, the patch is asked for the moment the
 * session answers, and the first files are highlighted while React mounts; the
 * review adopts these items (`takeStartupReview`), so its first draw hits the
 * highlight cache and is final.
 */

// Enough for the files a first screen can show; each grammar is a chunk and a
// transfer to the worker.
const WARM_LANGUAGE_LIMIT = 4
// What a first screen can show. The worker highlights one file at a time.
const PRIMED_FILE_LIMIT = 2
// A larger working tree is the patch builder's own business (streamed pages,
// cancellation on a status tick); the launch does not race it.
const PREFETCH_PATH_LIMIT = 300
const STARTUP_PATCH_VERSION = 'working-tree-startup'

export interface StartupReview {
  items: CodeViewItem<ReviewAnnotationMetadata>[]
  omittedFiles: OmittedDiffFile[]
}

export interface StartupReviewFetch {
  root: string
  paths: ReadonlySet<string>
  review: Promise<StartupReview | null>
}

type HighlightPool = ReturnType<typeof getOrCreateWorkerPoolSingleton>

function firstLanguages(paths: readonly string[]): SupportedLanguages[] {
  const languages: SupportedLanguages[] = []
  for (const path of paths) {
    const language = getFiletypeFromFileName(path)
    if (language === 'text' || languages.includes(language)) continue
    languages.push(language)
    if (languages.length === WARM_LANGUAGE_LIMIT) break
  }
  return languages
}

async function fetchStartupReview(pool: HighlightPool, root: string, paths: readonly string[]): Promise<StartupReview | null> {
  const repository = window.repository
  if (repository == null) return null
  try {
    // No request id: a streamed caller's reply carries no patch.
    const reply = await repository.getWorkingTreePatch([...paths], undefined, root)
    performance.mark('kodi:startup-patch')
    const items = createPatchReviewItems<ReviewAnnotationMetadata>(reply.patch, STARTUP_PATCH_VERSION)
    // The review's own order: the files on screen first.
    const first = items
      .map((item) => ({ item, path: item.type === 'diff' ? item.fileDiff.name : item.id }))
      .sort((left, right) => compareTreePaths(left.path, right.path))
      .slice(0, PRIMED_FILE_LIMIT)
      .map(({ item }) => item)
    // Not awaited: an item the review draws meanwhile joins this highlight in
    // the pool instead of asking for its own, and the window waits for it.
    void primeReviewHighlights(pool, first, [])
    return { items, omittedFiles: reply.omittedFiles }
  } catch {
    return null
  }
}

/** Called once, from the entry chunk. Null when the launch does not open on a folder review. */
export async function startStartupReview(
  sessionSnapshot: Promise<RepositorySnapshot | null>
): Promise<StartupReviewFetch | null> {
  const cachedPaint = initialWorkspacePaint(window.repository?.cachedWorkspace ?? null)
  const cached = cachedPaint.snapshot
  if (cached == null) return null
  const review = cachedPaint.workspaceView === 'multi'
  // The pool is a singleton that keeps the options it is first built with, so
  // these must be the ones `ViewerProviders` passes.
  const theme = loadPreferences().editorTheme
  // Before the pool exists: it starts initialising as it is built, and finds
  // the theme resolved or goes to load it.
  const seeded = seedStartupTheme(theme)
  const pool = getOrCreateWorkerPoolSingleton({
    poolOptions: DIFF_WORKER_POOL_OPTIONS,
    highlighterOptions: { theme, ...DIFF_HIGHLIGHTER_OPTIONS }
  })
  const firstPaths = review
    ? cached.statuses.map((entry) => entry.path).sort(compareTreePaths)
    : cachedPaint.selectedPath == null ? [] : [cachedPaint.selectedPath]
  const languages = firstLanguages(firstPaths)
  // The worker takes each grammar with the first file that needs it, so they
  // are fetched now. With the theme seeded the worker is already starting;
  // otherwise the pool is waiting on this same theme load, and the result is
  // kept for the next launch.
  if (!seeded) void resolveThemes([theme]).then(([resolved]) => rememberStartupTheme(resolved)).catch(() => undefined)
  void resolveLanguages(languages).catch(() => undefined)
  if (!review) return null

  // The last session's changed files are usually this one's too, so their patch
  // is asked for now, while main is still answering the live snapshot, and
  // kept only if the live list names the same files. The patch itself is read
  // from the working tree as main answers, so it is current either way.
  const cachedPaths = cached.kind === 'git' ? cached.statuses.map((entry) => entry.path) : []
  const early = prefetchablePaths(cachedPaths)
    ? fetchStartupReview(pool, cached.root, cachedPaths)
    : null
  const snapshot = await sessionSnapshot
  if (snapshot == null || snapshot.kind !== 'git' || snapshot.root !== cached.root) return null
  const paths = snapshot.statuses.map((entry) => entry.path)
  if (!prefetchablePaths(paths)) return null
  const pathSet = new Set(paths)
  const reusable = early != null && cachedPaths.length === pathSet.size && cachedPaths.every((path) => pathSet.has(path))
  return { root: snapshot.root, paths: pathSet, review: reusable ? early : fetchStartupReview(pool, snapshot.root, paths) }
}

function prefetchablePaths(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.length <= PREFETCH_PATH_LIMIT
}

/**
 * The launch's patch for exactly these paths of this repository, once. Null when
 * the launch fetched none, fetched another set, or it was already taken.
 */
export async function takeStartupReview(
  root: string | undefined,
  paths: readonly string[],
  isCancelled: () => boolean
): Promise<StartupReview | null> {
  const request = peekStartupReviewRequest()
  if (request == null) return null
  const fetch = await request
  // A load cancelled meanwhile leaves the patch to the run that replaced it.
  if (isCancelled()) return null
  takeStartupReviewRequest()
  if (fetch == null || (root != null && root !== fetch.root) || paths.length !== fetch.paths.size) return null
  if (!paths.every((path) => fetch.paths.has(path))) return null
  const review = await fetch.review
  return isCancelled() ? null : review
}
