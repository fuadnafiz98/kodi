import {
  forgetStorageKey,
  persistManagedValue,
  type BudgetStorage
} from '../review/storageBudget'

export interface DraftRecord {
  path: string
  sourceCacheKey: string
  contents: string
  savedAt: number
}

export type DraftMap = Readonly<Record<string, DraftRecord>>

export const EMPTY_DRAFTS: DraftMap = {}

// localStorage is a synchronous ~5 MB budget shared with preferences, recent
// folders and review threads, so a single huge draft must never be able to
// evict all of them. Oversized drafts stay in memory for the session instead.
const MAX_PERSISTED_DRAFT_BYTES = 512_000
const MAX_PERSISTED_DRAFTS = 24
const MAX_PERSISTED_DRAFTS_TOTAL_BYTES = 2 * 1024 * 1024

export type DraftStorage = BudgetStorage

export function draftStorageKey(root: string): string {
  return `kodi:drafts:v1:${root}`
}

function isDraftRecord(value: unknown): value is DraftRecord {
  if (typeof value !== 'object' || value == null) return false
  const record = value as Record<string, unknown>
  return typeof record.path === 'string'
    && record.path !== ''
    && typeof record.sourceCacheKey === 'string'
    && typeof record.contents === 'string'
    && typeof record.savedAt === 'number'
    && Number.isFinite(record.savedAt)
}

export function parseDrafts(raw: string | null): DraftMap {
  if (raw == null || raw === '') return EMPTY_DRAFTS
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY_DRAFTS
  }
  if (!Array.isArray(parsed)) return EMPTY_DRAFTS
  const drafts: Record<string, DraftRecord> = {}
  for (const entry of parsed) {
    if (!isDraftRecord(entry)) continue
    drafts[entry.path] = {
      path: entry.path,
      sourceCacheKey: entry.sourceCacheKey,
      contents: entry.contents,
      savedAt: entry.savedAt
    }
  }
  return drafts
}

export function serializeDrafts(drafts: DraftMap): string {
  const newestFirst = Object.values(drafts)
    .filter((draft) => draft.contents.length <= MAX_PERSISTED_DRAFT_BYTES)
    .sort((left, right) => right.savedAt - left.savedAt)
    .slice(0, MAX_PERSISTED_DRAFTS)
  const persistable: DraftRecord[] = []
  let totalBytes = 2
  for (const draft of newestFirst) {
    const encoded = JSON.stringify(draft)
    const nextBytes = totalBytes + encoded.length + (persistable.length > 0 ? 1 : 0)
    if (nextBytes > MAX_PERSISTED_DRAFTS_TOTAL_BYTES) continue
    persistable.push(draft)
    totalBytes = nextBytes
  }
  return JSON.stringify(persistable)
}

export function putDraft(drafts: DraftMap, draft: DraftRecord): DraftMap {
  const current = drafts[draft.path]
  if (current != null
    && current.contents === draft.contents
    && current.sourceCacheKey === draft.sourceCacheKey) return drafts
  return { ...drafts, [draft.path]: draft }
}

export function removeDraft(drafts: DraftMap, path: string): DraftMap {
  if (drafts[path] == null) return drafts
  const next = { ...drafts }
  delete next[path]
  return next
}

export function draftPaths(drafts: DraftMap): string[] {
  return Object.keys(drafts).sort()
}

export function readDrafts(root: string, storage: DraftStorage | null): DraftMap {
  if (storage == null) return EMPTY_DRAFTS
  try {
    return parseDrafts(storage.getItem(draftStorageKey(root)))
  } catch {
    return EMPTY_DRAFTS
  }
}

export function writeDrafts(root: string, drafts: DraftMap, storage: DraftStorage | null): boolean {
  if (storage == null) return false
  const key = draftStorageKey(root)
  try {
    if (Object.keys(drafts).length === 0) {
      storage.removeItem(key)
      forgetStorageKey(storage, key)
      return true
    }
    return persistManagedValue(storage, key, serializeDrafts(drafts))
  } catch {
    return false
  }
}

export function browserDraftStorage(): DraftStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
