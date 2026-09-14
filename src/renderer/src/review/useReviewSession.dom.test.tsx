import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, renderHook } from '@testing-library/react'

import {
  loadStoredReviewThreads,
  reviewThreadStorageKey,
  saveStoredReviewThreads
} from './reviewThreadStorage'
import { clearReviewSessionMemory, useReviewSession } from './useReviewSession'
import {
  loadStoredViewedFiles,
  saveStoredViewedFiles,
  viewedFileStorageKey
} from './viewedFileStorage'

afterEach(() => {
  cleanup()
  localStorage.clear()
  clearReviewSessionMemory()
})

const emptyReanchor = {
  items: [] as const,
  loading: false,
  enabled: false
}

const thread = {
  id: 'thread-a',
  body: 'On review A',
  lineNumber: 2,
  range: { start: 2, end: 2 },
  replies: [],
  resolved: false
}

test('an in-place reviewIdentity change flushes A and loads B without remounting', () => {
  saveStoredReviewThreads(reviewThreadStorageKey('/repo', 'review-b'), {
    'src/b.ts': [{ ...thread, id: 'thread-b', body: 'On review B' }]
  })
  saveStoredViewedFiles(viewedFileStorageKey('/repo', 'review-b'), { 'src/b.ts': 'sig-b' })

  const { result, rerender } = renderHook(
    ({ identity }: { identity: string }) => useReviewSession('/repo', identity, emptyReanchor),
    { initialProps: { identity: 'review-a' } }
  )

  act(() => {
    result.current.setThreadsByPath({ 'src/a.ts': [thread] })
    result.current.setViewedFiles({ 'src/a.ts': 'sig-a' })
  })

  rerender({ identity: 'review-b' })

  expect(result.current.threadsByPath['src/b.ts']?.[0]?.body).toBe('On review B')
  expect(result.current.viewedFiles).toEqual({ 'src/b.ts': 'sig-b' })
  expect(loadStoredReviewThreads(reviewThreadStorageKey('/repo', 'review-a')))
    .toEqual({ 'src/a.ts': [thread] })
  expect(loadStoredViewedFiles(viewedFileStorageKey('/repo', 'review-a'))).toEqual({ 'src/a.ts': 'sig-a' })
})

test('a second visit to the same review keeps the in-memory thread and viewed maps', () => {
  const { result, rerender } = renderHook(
    ({ identity }: { identity: string }) => useReviewSession('/repo', identity, emptyReanchor),
    { initialProps: { identity: 'review-a' } }
  )

  act(() => {
    result.current.setThreadsByPath({ 'src/a.ts': [thread] })
    result.current.setViewedFiles({ 'src/a.ts': 'sig-a' })
  })
  const threadsA = result.current.threadsByPath
  const viewedA = result.current.viewedFiles

  rerender({ identity: 'review-b' })
  expect(result.current.threadsByPath).not.toBe(threadsA)

  rerender({ identity: 'review-a' })
  expect(result.current.threadsByPath).toBe(threadsA)
  expect(result.current.viewedFiles).toBe(viewedA)
})
