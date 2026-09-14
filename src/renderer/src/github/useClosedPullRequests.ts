import { useState } from 'react'

import type { PullRequestSummary } from '../../../shared/contracts'
import { getErrorMessage, requireRepositoryApi } from '../explorer/repositoryApi'

export interface ClosedPullRequests {
  shown: boolean
  loading: boolean
  error: string | null
  pullRequests: PullRequestSummary[] | null
  toggle(): void
}

/**
 * Closed and merged pull requests are a second network round trip, so they load
 * the first time somebody asks to see them rather than on every panel open.
 */
export function useClosedPullRequests(): ClosedPullRequests {
  const [shown, setShown] = useState(false)
  const [pullRequests, setPullRequests] = useState<PullRequestSummary[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (): void => {
    if (shown) {
      setShown(false)
      return
    }
    setShown(true)
    if ((pullRequests != null && error == null) || loading) return
    setLoading(true)
    void (async () => {
      try {
        setPullRequests(await requireRepositoryApi().getClosedPullRequests())
        setError(null)
      } catch (loadError) {
        setError(getErrorMessage(loadError))
      } finally {
        setLoading(false)
      }
    })()
  }

  return { shown, loading, error, pullRequests, toggle }
}
