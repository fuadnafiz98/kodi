// One worker is enough for the visible viewport and keeps highlighting off the
// main thread. More workers complete off-screen work during a fast scroll, load
// duplicate Shiki grammars, and retain much larger V8 heap arenas.
export const DIFF_WORKER_COUNT = 1

export const COMPARISON_FETCH_CONCURRENCY = 4

function createDiffWorker(): Worker {
  return new Worker(new URL('@pierre/diffs/worker/worker.js', import.meta.url), { type: 'module' })
}

let prewarmedWorker: Worker | null = null

/**
 * Starts the highlight worker's script loading from the entry chunk. The pool
 * creates its worker only once the theme and grammars have resolved, and the
 * worker then still has to fetch and evaluate its own bundle before the first
 * highlight; started here, that runs alongside the boot chunk instead.
 */
export function prewarmDiffWorker(): void {
  prewarmedWorker ??= createDiffWorker()
}

export const DIFF_WORKER_POOL_OPTIONS = {
  poolSize: DIFF_WORKER_COUNT,
  // This limit applies independently to file and diff AST caches. Four entries
  // preserve short reverse-scroll reuse without retaining an entire review.
  totalASTLRUCacheSize: 4,
  workerFactory: (): Worker => {
    const worker = prewarmedWorker ?? createDiffWorker()
    prewarmedWorker = null
    return worker
  }
}

export const DIFF_HIGHLIGHTER_LIMITS = {
  tokenizeMaxLineLength: 2_000,
  maxLineDiffLength: 1_000
}

// Pool-wide render options. `useTokenTransformer` stays off: it wraps every
// token fragment in an extra span and stops shiki merging whitespace, and the
// renderers already force it on per instance while an edit session is attached
// (FileRenderer.getRenderOptions), so only the file being edited pays for it.
// The worker pool is a module singleton that ignores these after the first
// construction, so this must not be rebuilt per render.
export const DIFF_HIGHLIGHTER_OPTIONS = {
  useTokenTransformer: false,
  ...DIFF_HIGHLIGHTER_LIMITS
}
