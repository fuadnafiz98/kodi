import { afterEach, expect, test } from 'bun:test'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { parsePatchFiles } from '@pierre/diffs'

import type { PullRequestReview, RepositoryApi } from '../../../shared/contracts'
import { useReviewDiffLoader } from './useReviewDiffLoader'

afterEach(() => {
  cleanup()
  delete window.repository
})

const review = {
  kind: 'github',
  selector: '7',
  baseOid: 'base-7',
  headOid: 'head-7',
  pullRequest: { number: 7, url: 'https://github.com/acme/repo/pull/7' },
  files: [],
  patch: '',
  omittedFiles: [],
  expectedFileCount: 0
} as unknown as PullRequestReview

const PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index 1111111..2222222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,2 +1,2 @@',
  ' a',
  '-b',
  '+B',
  ''
].join('\n')

function installRepository(readable: boolean) {
  let answer!: (value: boolean) => void
  const calls = { hasRevision: 0, getRevisionFile: 0 }
  window.repository = {
    hasRevision: () => {
      calls.hasRevision += 1
      return new Promise<boolean>((resolve) => { answer = resolve })
    },
    getRevisionFile: async (_revision: string, path: string) => {
      calls.getRevisionFile += 1
      return { name: path, contents: 'a\nB\n' }
    }
  } as unknown as RepositoryApi
  return { calls, answer: () => answer(readable) }
}

const noopPreview = (): void => {}

test('a pull request gets one loader from the first render, before its head is known', async () => {
  installRepository(true)
  const { result, rerender } = renderHook(() => useReviewDiffLoader(review, noopPreview))
  const first = result.current
  // The viewer counts a loader appearing as a layout change for every item.
  expect(first).toBeDefined()
  rerender()
  expect(result.current).toBe(first)
})

test('loads wait for the head check and are refused when the head is not local', async () => {
  const repository = installRepository(false)
  const { result } = renderHook(() => useReviewDiffLoader(review, noopPreview))
  const fileDiff = parsePatchFiles(PATCH, 'test')[0]!.files[0]!
  const pending = result.current!.load(fileDiff)
  await waitFor(() => expect(repository.calls.hasRevision).toBe(1))
  repository.answer()
  await expect(pending).rejects.toThrow('head-7')
  expect(repository.calls.getRevisionFile).toBe(0)
})

test('a readable head is asked about once and then read from', async () => {
  const repository = installRepository(true)
  const { result } = renderHook(() => useReviewDiffLoader(review, noopPreview))
  const loader = result.current!
  const first = loader.load(parsePatchFiles(PATCH, 'one')[0]!.files[0]!)
  await waitFor(() => expect(repository.calls.hasRevision).toBe(1))
  repository.answer()
  const files = await first
  expect(files.newFile.contents).toBe('a\nB\n')
  await loader.load(parsePatchFiles(PATCH, 'two')[0]!.files[0]!)
  expect(repository.calls.hasRevision).toBe(1)
})
