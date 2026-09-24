import { describe, expect, test } from 'bun:test'

import type { PullRequestSummary } from '../../../shared/contracts'
import { reviewSubmissionRequest, reviewSubmittedMessage } from './reviewSubmission'

const pullRequest = {
  number: 792,
  title: 'Add superadmin user erasure endpoint',
  url: 'https://github.com/acme/app/pull/792',
  headRefName: 'FMX-867',
  baseRefName: 'dev'
} as PullRequestSummary

describe('reviewSubmissionRequest', () => {
  test('an approval names the verdict on the title and the button, in the success tone', () => {
    const request = reviewSubmissionRequest('approve', pullRequest, 0)
    expect(request.title).toBe('Approve #792?')
    expect(request.confirmLabel).toBe('Approve')
    expect(request.tone).toBe('success')
    expect(request.detail).toBe('Your approval is posted to GitHub.')
    expect(request.context).toEqual({ title: 'Add superadmin user erasure endpoint', meta: '#792 · FMX-867 → dev' })
  })

  test('inline comments are counted in the sentence', () => {
    expect(reviewSubmissionRequest('approve', pullRequest, 2).detail).toBe('Your approval is posted to GitHub with 2 inline comments.')
    expect(reviewSubmissionRequest('comment', pullRequest, 1).detail)
      .toBe('Your 1 inline comment is posted to GitHub without approving or requesting changes.')
  })

  test('requesting changes reads as a warning, not a destructive action', () => {
    const request = reviewSubmissionRequest('request-changes', pullRequest, 0)
    expect(request.confirmLabel).toBe('Request changes')
    expect(request.tone).toBe('warning')
    expect(request.destructive).toBeUndefined()
  })
})

test('the success toast says what happened to which pull request', () => {
  expect(reviewSubmittedMessage('approve', 792)).toBe('Approved #792')
  expect(reviewSubmittedMessage('request-changes', 792)).toBe('Requested changes on #792')
  expect(reviewSubmittedMessage('comment', 792)).toBe('Commented on #792')
})
