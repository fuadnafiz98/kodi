import { describe, expect, test } from 'bun:test'

import type {
  GitIntegrationSnapshot,
  PullRequestInboxSnapshot
} from '../../../shared/contracts'
import { visiblePullRequestsFor } from './gitPanelInbox'

const integration = {
  pullRequests: [{ number: 1 }, { number: 2 }]
} as unknown as GitIntegrationSnapshot

function inbox(available: boolean, sections: number[][]): PullRequestInboxSnapshot {
  return {
    available,
    sections: sections.map((numbers, index) => ({
      label: `s${index}`,
      pullRequests: numbers.map((number) => ({ number }))
    }))
  } as unknown as PullRequestInboxSnapshot
}

describe('visiblePullRequestsFor', () => {
  test('a populated inbox wins over the repository list', () => {
    const result = visiblePullRequestsFor(inbox(true, [[7], [], [8, 9]]), integration)
    expect(result.visible.map((pullRequest) => pullRequest.number)).toEqual([7, 8, 9])
    expect(result.inboxCount).toBe(3)
  })

  test('an empty or unavailable inbox falls back to the repository list', () => {
    expect(visiblePullRequestsFor(inbox(true, [[], []]), integration).visible).toHaveLength(2)
    expect(visiblePullRequestsFor(inbox(false, [[7]]), integration).visible).toHaveLength(2)
    expect(visiblePullRequestsFor(null, integration).inboxCount).toBe(0)
  })

  test('no integration and no inbox is an empty list', () => {
    expect(visiblePullRequestsFor(null, null).visible).toEqual([])
  })
})
