import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'
import { WorkerPoolContext } from '@pierre/diffs/react'

import type { FileComparison } from '../../../shared/contracts'
import { usePrimedComparison } from './usePrimedComparison'

afterEach(cleanup)

const version = (text: string, key: string): FileComparison => ({
  path: 'a.ts',
  mode: 'diff',
  oldFile: { name: 'a.ts', contents: 'one\n', cacheKey: 'old' },
  newFile: { name: 'a.ts', contents: text, cacheKey: key }
} as FileComparison)

function primingPool() {
  const pending: (() => void)[] = []
  const pool = {
    isWorkingPool: () => true,
    primeDiffHighlightCache: () => new Promise<void>((resolve) => { pending.push(resolve) })
  }
  return { pool, answer: () => pending.splice(0).forEach((resolve) => resolve()) }
}

test('a new version of the open file shows once its highlight is ready, the drafts of an edit at once', async () => {
  const { pool, answer } = primingPool()
  const first = version('one\ntwo\n', 'v1')
  const second = version('one\ntwo\nthree\n', 'v2')
  const { result, rerender } = renderHook(
    ({ comparison, holdBack }: { comparison: FileComparison; holdBack: boolean }) => usePrimedComparison(comparison, holdBack),
    {
      initialProps: { comparison: first, holdBack: true },
      wrapper: ({ children }) => <WorkerPoolContext.Provider value={pool as never}>{children}</WorkerPoolContext.Provider>
    }
  )
  expect(result.current).toBe(first)

  rerender({ comparison: second, holdBack: true })
  expect(result.current).toBe(first)
  await act(async () => { answer() })
  expect(result.current).toBe(second)

  const draft = version('one\ntwo\nthree\nfour\n', 'draft')
  rerender({ comparison: draft, holdBack: false })
  expect(result.current).toBe(draft)
})
