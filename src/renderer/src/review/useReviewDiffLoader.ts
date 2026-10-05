import { useEffect, useMemo, useState } from 'react'

import type { FileImagePreview, RepositoryApi, RepositoryReview } from '../../../shared/contracts'
import { createPartialDiffLoader, loadPartialDiffFiles, type PartialDiffLoader } from './partialDiffHydration'
import { markReviewFileHydrated } from './reviewMetrics'

/**
 * A pull request's commits are only local once someone fetched them, and
 * without them no side can be read; the main process fetches whichever are
 * missing. The answer is asked once per loader, on the first load, and every
 * load waits for it. Answering it before handing the viewer a loader made
 * `loadDiffFiles` appear a beat after the review did, and the viewer counts
 * that as a layout change for every item: a pull request rendered twice as it
 * opened.
 */
function revisionReadability(
  repository: Pick<RepositoryApi, 'ensurePullRequestRevisions'>,
  pullRequestUrl: string,
  baseOid: string,
  headOid: string
): () => Promise<boolean> {
  let readable: Promise<boolean> | null = null
  return () => {
    readable ??= repository.ensurePullRequestRevisions(pullRequestUrl, baseOid, headOid).catch(() => false)
    return readable
  }
}

export function useReviewDiffLoader(
  repositoryReview: RepositoryReview | null,
  onImagePreview: (path: string, image: FileImagePreview) => void
): PartialDiffLoader | undefined {
  const kind = repositoryReview?.kind ?? null
  const baseOid = repositoryReview?.baseOid ?? null
  const headOid = repositoryReview?.headOid ?? null
  const pullRequestUrl = repositoryReview?.kind === 'github' ? repositoryReview.pullRequest.url : null
  const headReadable = useMemo(() => {
    const repository = window.repository
    return repository == null || pullRequestUrl == null || baseOid == null || headOid == null
      ? null
      : revisionReadability(repository, pullRequestUrl, baseOid, headOid)
  }, [baseOid, headOid, pullRequestUrl])
  // The common answer is "readable", and it changes nothing. Only a head that
  // could not be fetched takes the loader away, so the viewer stops offering expand
  // controls that could never load — one extra render, for the rare fork that
  // was never fetched.
  const [unreadableHead, setUnreadableHead] = useState<string | null>(null)
  useEffect(() => {
    if (headReadable == null || headOid == null) return
    let cancelled = false
    void headReadable().then((readable) => {
      if (!cancelled && !readable) setUnreadableHead(headOid)
    })
    return () => { cancelled = true }
  }, [headOid, headReadable])
  const headUnavailable = headOid != null && unreadableHead === headOid

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
    if (baseOid == null || headOid == null || headUnavailable) return undefined
    // An unreadable head rejects: the viewer logs it and keeps the patch as it
    // arrived, and auto-hydration stops asking about that file.
    return createPartialDiffLoader(async (fileDiff) => {
      if (headReadable != null && !(await headReadable())) {
        throw new Error(`The pull request head ${headOid} is not available locally.`)
      }
      return loadPartialDiffFiles(fileDiff, [
        { side: 'new', load: () => repository.getRevisionFile(headOid, fileDiff.name) },
        { side: 'old', load: () => repository.getRevisionFile(baseOid, fileDiff.prevName ?? fileDiff.name) }
      ])
    })
  }, [baseOid, headOid, headReadable, headUnavailable, kind, onImagePreview])
}
