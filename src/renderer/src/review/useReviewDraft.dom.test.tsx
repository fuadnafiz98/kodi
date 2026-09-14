import { afterEach, expect, test } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'

import { EMPTY_REVIEW_FILE_FILTER } from './reviewFileFilter'
import { useReviewDraft, type ReviewDraft } from './useReviewDraft'

afterEach(cleanup)

let latest: ReviewDraft | null = null
let renders = 0

function Probe({ reviewIdentity }: { reviewIdentity: string }): React.JSX.Element {
  renders += 1
  latest = useReviewDraft(reviewIdentity)
  return <span>{latest.composerBody}</span>
}

test('the filter and the composer survive re-renders of the same review', () => {
  const { rerender } = render(<Probe reviewIdentity="github:one" />)
  act(() => {
    latest?.setFileFilter({ ...EMPTY_REVIEW_FILE_FILTER, query: 'src/' })
    latest?.setComposerExpanded(true)
    latest?.setComposerBody('Looks good')
  })
  rerender(<Probe reviewIdentity="github:one" />)

  expect(latest?.fileFilter.query).toBe('src/')
  expect(latest?.composerExpanded).toBe(true)
  expect(latest?.composerBody).toBe('Looks good')
})

test('a new review identity clears them without painting the previous values', () => {
  const { container, rerender } = render(<Probe reviewIdentity="github:one" />)
  act(() => {
    latest?.setFileFilter({ ...EMPTY_REVIEW_FILE_FILTER, query: 'src/', hideTests: true })
    latest?.setComposerExpanded(true)
    latest?.setComposerBody('Looks good')
  })
  expect(container.textContent).toBe('Looks good')

  renders = 0
  rerender(<Probe reviewIdentity="github:two" />)

  expect(latest?.fileFilter).toBe(EMPTY_REVIEW_FILE_FILTER)
  expect(latest?.composerExpanded).toBe(false)
  expect(latest?.composerBody).toBe('')
  // The stale draft never reaches the DOM: the reset happens during the render
  // that brings the new identity in, not in an effect after it commits.
  expect(container.textContent).toBe('')
  expect(renders).toBeGreaterThan(1)
})
