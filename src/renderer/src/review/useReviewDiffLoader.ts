import { useEffect, useMemo, useState } from 'react'

import type { FileImagePreview, RepositoryReview } from '../../../shared/contracts'
import { createPartialDiffLoader, loadPartialDiffFiles, type PartialDiffLoader } from './partialDiffHydration'
import { markReviewFileHydrated } from './reviewMetrics'

/**
 * A pull request's head commit is only local once someone fetched it. Without
 * it no side can be read, so the viewer keeps the patch as it arrived rather
 * than offering expand buttons that would fail.
 */
function usePullRequestHeadReadable(headOid: string | null): boolean {
  const [readable, setReadable] = useState<{ oid: string; readable: boolean } | null>(null)
  useEffect(() => {
    const repository = window.repository
    if (headOid == null || repository == null) return
    let cancelled = false
    repository.hasRevision(headOid).then((value) => {
      if (!cancelled) setReadable({ oid: headOid, readable: value })
    }, () => {})
    return () => { cancelled = true }
  }, [headOid])
  return headOid != null && readable?.oid === headOid && readable.readable
}

export function useReviewDiffLoader(
  repositoryReview: RepositoryReview | null,
  onImagePreview: (path: string, image: FileImagePreview) => void
): PartialDiffLoader | undefined {
  const kind = repositoryReview?.kind ?? null
  const baseOid = repositoryReview?.baseOid ?? null
  const headOid = repositoryReview?.headOid ?? null
  const headReadable = usePullRequestHeadReadable(kind === 'github' ? headOid : null)

  return useMemo(() => {
    const repository = window.repository
    if (repository == null) return undefined
    if (kind == null) {
      return createPartialDiffLoader((fileDiff) => {
        const comparison = repository.getComparison(fileDiff.name).then((result) => {
          markReviewFileHydrated(fileDiff.name)
          if (result.image != null && (result.image.old != null || result.image.new != null)) {
            onImagePreview(fileDiff.name, result.image)
          }
          return result
        })
        return loadPartialDiffFiles(fileDiff, [
          { side: 'new', load: async () => (await comparison).newFile },
          { side: 'old', load: async () => (await comparison).oldFile }
        ])
      })
    }
    if (baseOid == null || headOid == null || (kind === 'github' && !headReadable)) return undefined
    return createPartialDiffLoader((fileDiff) => loadPartialDiffFiles(fileDiff, [
      { side: 'new', load: () => repository.getRevisionFile(headOid, fileDiff.name) },
      { side: 'old', load: () => repository.getRevisionFile(baseOid, fileDiff.prevName ?? fileDiff.name) }
    ]))
  }, [baseOid, headOid, headReadable, kind, onImagePreview])
}
