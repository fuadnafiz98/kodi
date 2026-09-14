import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { CodeViewItem } from '@pierre/diffs'

import type { ReviewAnnotationMetadata, ReviewThread } from './ReviewComments'
import {
  loadStoredReviewThreads,
  reviewThreadStorageKey,
  saveStoredReviewThreads
} from './reviewThreadStorage'
import {
  loadStoredViewedFiles,
  saveStoredViewedFiles,
  viewedFileStorageKey,
  type ViewedFileSignatures
} from './viewedFileStorage'
import { reanchorReviewThreads } from './reviewThreadAnchors'
import { notifyStorageWriteFailed } from './storageBudget'
import { showToast } from '../app/toast'
import { useDebouncedPersist } from '../app/useDebouncedPersist'

interface ReviewSession {
  threadsByPath: Record<string, ReviewThread[]>
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>
  viewedFiles: ViewedFileSignatures
  setViewedFiles: Dispatch<SetStateAction<ViewedFileSignatures>>
}

interface ReviewReanchorSource {
  items: readonly CodeViewItem<ReviewAnnotationMetadata>[]
  loading: boolean
  enabled: boolean
}

const REVIEW_PERSIST_DELAY_MS = 400
export const MAX_REVIEW_SESSION_MEMORY_ENTRIES = 32
export const MAX_REVIEW_SESSION_MEMORY_BYTES = 8 * 1024 * 1024

interface ReviewSessionMemory {
  threadsByPath: Record<string, ReviewThread[]>
  viewedFiles: ViewedFileSignatures
}

interface ReviewSessionEntry {
  value: ReviewSessionMemory
  bytes: number
}

// Insertion order is the eviction order, so a re-read moves its entry to the
// back and the front is always the least recently touched review.
const sessionMemory = new Map<string, ReviewSessionEntry>()
let sessionMemoryBytes = 0

function reviewSessionBytes(value: ReviewSessionMemory): number {
  return JSON.stringify(value).length * 2
}

function trimReviewSessionMemory(protectedKey: string): void {
  for (const [key, entry] of sessionMemory) {
    if (sessionMemory.size <= MAX_REVIEW_SESSION_MEMORY_ENTRIES
      && sessionMemoryBytes <= MAX_REVIEW_SESSION_MEMORY_BYTES) return
    if (key === protectedKey) continue
    sessionMemory.delete(key)
    sessionMemoryBytes -= entry.bytes
  }
}

function sessionMemoryKey(root: string, reviewIdentity: string): string {
  return `${root}\0${reviewIdentity}`
}

export function clearReviewSessionMemory(): void {
  sessionMemory.clear()
  sessionMemoryBytes = 0
}

function rememberReviewSession(
  root: string,
  reviewIdentity: string,
  threadsByPath: Record<string, ReviewThread[]>,
  viewedFiles: ViewedFileSignatures
): ReviewSessionMemory {
  const key = sessionMemoryKey(root, reviewIdentity)
  const remembered = { threadsByPath, viewedFiles }
  // Only the entry being written is measured. Summing the whole map on every
  // write would make each remembered thread cost a full serialization of every
  // other open review.
  const bytes = reviewSessionBytes(remembered)
  const previous = sessionMemory.get(key)
  if (previous != null) sessionMemoryBytes -= previous.bytes
  sessionMemory.delete(key)
  sessionMemory.set(key, { value: remembered, bytes })
  sessionMemoryBytes += bytes
  trimReviewSessionMemory(key)
  return remembered
}

function readReviewSession(root: string, reviewIdentity: string): ReviewSessionMemory {
  const key = sessionMemoryKey(root, reviewIdentity)
  const entry = sessionMemory.get(key)
  if (entry != null) {
    sessionMemory.delete(key)
    sessionMemory.set(key, entry)
    return entry.value
  }
  return rememberReviewSession(
    root,
    reviewIdentity,
    loadStoredReviewThreads(reviewThreadStorageKey(root, reviewIdentity)),
    loadStoredViewedFiles(viewedFileStorageKey(root, reviewIdentity))
  )
}

// Draft comments and viewed marks belong to one review of one repository, and
// both outlive the window: they are restored on mount and saved after changes settle.
export function useReviewSession(
  root: string,
  reviewIdentity: string,
  reanchorSource: ReviewReanchorSource
): ReviewSession {
  const [dataIdentity, setDataIdentity] = useState({ root, reviewIdentity })
  const [threadsByPath, setThreadsByPath] = useState<Record<string, ReviewThread[]>>(
    () => readReviewSession(root, reviewIdentity).threadsByPath
  )
  const [viewedFiles, setViewedFiles] = useState<ViewedFileSignatures>(
    () => readReviewSession(root, reviewIdentity).viewedFiles
  )
  const previousReanchorRef = useRef<{
    enabled: boolean
    items: ReviewReanchorSource['items']
    loading: boolean
  } | null>(null)
  const provisionalReanchorRef = useRef(false)
  if (dataIdentity.root !== root || dataIdentity.reviewIdentity !== reviewIdentity) {
    rememberReviewSession(dataIdentity.root, dataIdentity.reviewIdentity, threadsByPath, viewedFiles)
    saveStoredReviewThreads(
      reviewThreadStorageKey(dataIdentity.root, dataIdentity.reviewIdentity),
      threadsByPath
    )
    saveStoredViewedFiles(
      viewedFileStorageKey(dataIdentity.root, dataIdentity.reviewIdentity),
      viewedFiles
    )
    setDataIdentity({ root, reviewIdentity })
    const next = readReviewSession(root, reviewIdentity)
    setThreadsByPath(next.threadsByPath)
    setViewedFiles(next.viewedFiles)
  }
  const persistThreadKey = reviewThreadStorageKey(dataIdentity.root, dataIdentity.reviewIdentity)
  const persistViewedKey = viewedFileStorageKey(dataIdentity.root, dataIdentity.reviewIdentity)
  const identityMatches = dataIdentity.root === root && dataIdentity.reviewIdentity === reviewIdentity
  const threadsToPersist = useMemo(
    () => ({ key: persistThreadKey, value: threadsByPath }),
    [persistThreadKey, threadsByPath]
  )
  const viewedToPersist = useMemo(
    () => ({ key: persistViewedKey, value: viewedFiles }),
    [persistViewedKey, viewedFiles]
  )

  useDebouncedPersist(threadsToPersist, ({ key, value }) => {
    if (!saveStoredReviewThreads(key, value)) notifyStorageWriteFailed('comments', showToast)
  }, REVIEW_PERSIST_DELAY_MS)

  useLayoutEffect(() => {
    previousReanchorRef.current = null
    provisionalReanchorRef.current = false
  }, [reviewIdentity, root])

  useEffect(() => {
    const previous = previousReanchorRef.current
    const streamStarted = reanchorSource.loading
      && (previous == null || !previous.enabled || !previous.loading)
    if (streamStarted) provisionalReanchorRef.current = false
    const itemsChanged = previous?.items !== reanchorSource.items
    const provisional = reanchorSource.loading
      && reanchorSource.items.length > 0
      && !provisionalReanchorRef.current
    const committed = !reanchorSource.loading
      && (previous == null || !previous.enabled || previous.loading || itemsChanged)
    previousReanchorRef.current = {
      enabled: reanchorSource.enabled,
      items: reanchorSource.items,
      loading: reanchorSource.loading
    }

    if (!identityMatches || !reanchorSource.enabled) {
      provisionalReanchorRef.current = false
      return
    }
    if (!provisional && !committed) return
    if (provisional) provisionalReanchorRef.current = true
    setThreadsByPath((current) => reanchorReviewThreads(
      reanchorSource.items,
      current,
      committed
    ))
  }, [identityMatches, reanchorSource.enabled, reanchorSource.items, reanchorSource.loading])

  useDebouncedPersist(viewedToPersist, ({ key, value }) => {
    if (!saveStoredViewedFiles(key, value)) notifyStorageWriteFailed('viewed', showToast)
  }, REVIEW_PERSIST_DELAY_MS)

  return { threadsByPath, setThreadsByPath, viewedFiles, setViewedFiles }
}
