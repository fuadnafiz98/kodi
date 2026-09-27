import { afterEach, expect, test } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'

import type { PullRequestReview } from '../../../shared/contracts'
import { DEFAULT_PREFERENCES, type AppPreferences } from '../settings/preferences'
import { reviewScrollAnchorKey, useReviewCodeStyle, useReviewCodeViewOptions } from './MultiFileReview'

afterEach(cleanup)

const noop = (): void => {}

function renderViewerOptions(preferences: AppPreferences) {
  return renderHook(({ preferences: current }: { preferences: AppPreferences }) => ({
    options: useReviewCodeViewOptions({
      diffStyle: 'split',
      preferences: current,
      repositoryReview: null,
      onSelectLines: noop,
      onHideSelectionActions: noop,
      onImagePreview: noop
    }),
    style: useReviewCodeStyle(current)
  }), { initialProps: { preferences } })
}

test('a preference the viewer does not read leaves its options and style alone', () => {
  const { result, rerender } = renderViewerOptions(DEFAULT_PREFERENCES)
  const { options, style } = result.current
  rerender({ preferences: { ...DEFAULT_PREFERENCES, terminalScrollback: 99, accentColor: DEFAULT_PREFERENCES.accentColor } })
  expect(result.current.options).toBe(options)
  expect(result.current.style).toBe(style)

  rerender({ preferences: { ...DEFAULT_PREFERENCES, wordWrap: !DEFAULT_PREFERENCES.wordWrap } })
  expect(result.current.options).not.toBe(options)
  expect(result.current.style).toBe(style)

  rerender({ preferences: { ...DEFAULT_PREFERENCES, codeFontSize: DEFAULT_PREFERENCES.codeFontSize + 1 } })
  expect(result.current.style).not.toBe(style)
})

const review = {
  kind: 'github',
  selector: '3',
  baseOid: 'base-3',
  headOid: 'head-3',
  pullRequest: { number: 3, url: 'https://github.com/acme/repo/pull/3', checks: null, mergeable: null },
  files: [{ path: 'a.ts', additions: 1, deletions: 0 }],
  patch: 'patch',
  omittedFiles: [],
  expectedFileCount: 1
} as unknown as PullRequestReview

test('the background anchor key ignores a rebuilt review and follows streamed content', () => {
  const key = reviewScrollAnchorKey(review)
  expect(reviewScrollAnchorKey({ ...review })).toBe(key)
  expect(reviewScrollAnchorKey({
    ...review,
    pullRequest: { ...review.pullRequest, mergeable: 'MERGEABLE' }
  })).toBe(key)
  expect(reviewScrollAnchorKey({ ...review, patchPages: ['patch', 'more'], patchLength: 9 })).not.toBe(key)
  expect(reviewScrollAnchorKey({ ...review, headOid: 'head-4' })).not.toBe(key)
  expect(reviewScrollAnchorKey(null)).toBeNull()
})
