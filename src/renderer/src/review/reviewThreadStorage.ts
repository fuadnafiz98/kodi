import type { ReviewThread } from './ReviewComments'
import type { ReviewCommentAnchor } from './reviewThreadAnchors'
import {
  browserBudgetStorage,
  forgetStorageKey,
  persistManagedValue
} from './storageBudget'

const STORAGE_PREFIX = 'kodi:review-threads:'
const MAX_SERIALIZED_UTF16_UNITS = 512 * 1024

export function reviewThreadStorageKey(root: string, reviewIdentity: string): string {
  return `${STORAGE_PREFIX}${root}:${reviewIdentity}`
}

function isReviewCommentAnchor(value: unknown): value is ReviewCommentAnchor {
  if (typeof value !== 'object' || value == null) return false
  const anchor = value as Partial<ReviewCommentAnchor>
  return anchor.version === 1
    && typeof anchor.selectedText === 'string'
    && typeof anchor.beforeContextHash === 'string'
    && typeof anchor.afterContextHash === 'string'
    && (anchor.side === 'additions' || anchor.side === 'deletions')
    && (anchor.blobOid == null || typeof anchor.blobOid === 'string')
    && (anchor.symbol == null || typeof anchor.symbol === 'string')
}

function isReviewSide(value: unknown): value is 'additions' | 'deletions' {
  return value === 'additions' || value === 'deletions'
}

function isReviewRange(value: unknown): value is ReviewThread['range'] {
  if (typeof value !== 'object' || value == null) return false
  const range = value as Partial<ReviewThread['range']>
  return Number.isInteger(range.start) && Number.isInteger(range.end)
    && Number(range.start) >= 0 && Number(range.end) >= 0
    && (range.side == null || isReviewSide(range.side))
    && (range.endSide == null || isReviewSide(range.endSide))
}

function isReviewReply(value: unknown): value is ReviewThread['replies'][number] {
  if (typeof value !== 'object' || value == null) return false
  const reply = value as Partial<ReviewThread['replies'][number]>
  return typeof reply.id === 'string' && reply.id !== '' && typeof reply.body === 'string'
}

function isReviewThread(value: unknown): value is ReviewThread {
  if (typeof value !== 'object' || value == null) return false
  const thread = value as Partial<ReviewThread>
  return typeof thread.id === 'string'
    && typeof thread.body === 'string'
    && Number.isInteger(thread.lineNumber) && Number(thread.lineNumber) >= 0
    && (thread.side == null || isReviewSide(thread.side))
    && typeof thread.resolved === 'boolean'
    && Array.isArray(thread.replies) && thread.replies.every(isReviewReply)
    && isReviewRange(thread.range)
    && (thread.anchor == null || isReviewCommentAnchor(thread.anchor))
    && (thread.orphaned == null || typeof thread.orphaned === 'boolean')
}

export function parseStoredReviewThreads(serialized: string | null): Record<string, ReviewThread[]> {
  if (serialized == null) return {}
  try {
    const parsed = JSON.parse(serialized) as unknown
    if (typeof parsed !== 'object' || parsed == null || Array.isArray(parsed)) return {}
    const threadsByPath: Record<string, ReviewThread[]> = {}
    for (const [path, threads] of Object.entries(parsed)) {
      if (!Array.isArray(threads)) continue
      const validThreads = threads.filter(isReviewThread)
      if (validThreads.length > 0) threadsByPath[path] = validThreads
    }
    return threadsByPath
  } catch {
    return {}
  }
}

export function loadStoredReviewThreads(key: string): Record<string, ReviewThread[]> {
  try {
    return parseStoredReviewThreads(localStorage.getItem(key))
  } catch {
    return {}
  }
}

export function saveStoredReviewThreads(
  key: string,
  threadsByPath: Readonly<Record<string, ReviewThread[]>>
): boolean {
  const storage = browserBudgetStorage()
  if (storage == null) return false
  try {
    if (Object.values(threadsByPath).every((threads) => threads.length === 0)) {
      storage.removeItem(key)
      forgetStorageKey(storage, key)
      return true
    }
    const serialized = JSON.stringify(threadsByPath)
    if (serialized.length > MAX_SERIALIZED_UTF16_UNITS) return false
    return persistManagedValue(storage, key, serialized)
  } catch {
    return false
  }
}
