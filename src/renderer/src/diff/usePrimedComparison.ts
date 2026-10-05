import { useEffect, useState } from 'react'
import { parseDiffFromFile } from '@pierre/diffs'
import { useWorkerPool } from '@pierre/diffs/react'

import type { FileComparison } from '../../../shared/contracts'

// A rewrite waits at most this long for its highlight before it shows plain.
const PRIME_TIMEOUT_MS = 250
// Past this the worker's answer is a long main-thread message of its own.
const PRIME_MAX_LINES = 3_000

function lineCount(contents: string): number {
  let count = 0
  for (let index = contents.indexOf('\n'); index !== -1 && count <= PRIME_MAX_LINES; index = contents.indexOf('\n', index + 1)) count += 1
  return count
}

/**
 * The comparison to draw. A new version of the file already on screen is held
 * back until the worker has highlighted it, at most a quarter second: the
 * viewer draws a diff it has no highlight for as plain text, so every agent
 * write flashed the open file uncoloured. Another file, and the drafts of an
 * edit session (`holdBack` false), show at once.
 */
export function usePrimedComparison(comparison: FileComparison, holdBack: boolean): FileComparison {
  const workerPool = useWorkerPool()
  const [shown, setShown] = useState(comparison)
  const { oldFile, newFile } = comparison
  const waiting = holdBack && shown !== comparison && shown.path === comparison.path
    && oldFile != null && newFile != null && workerPool?.isWorkingPool() === true
    && lineCount(oldFile.contents) <= PRIME_MAX_LINES && lineCount(newFile.contents) <= PRIME_MAX_LINES
  // What is drawn is what the next comparison is measured against.
  if (!waiting && shown !== comparison) setShown(comparison)

  useEffect(() => {
    if (!waiting || workerPool == null || oldFile == null || newFile == null) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    void Promise.race([
      workerPool.primeDiffHighlightCache(parseDiffFromFile(oldFile, newFile)).catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, PRIME_TIMEOUT_MS) })
    ]).then(() => {
      clearTimeout(timer)
      if (active) setShown(comparison)
    })
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [comparison, newFile, oldFile, waiting, workerPool])

  return waiting ? shown : comparison
}
