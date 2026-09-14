export const STORAGE_INDEX_KEY = 'kodi:storage-index:v1'
export const DEFAULT_STORAGE_BUDGET = 3 * 1024 * 1024

const MANAGED_PREFIXES = [
  'kodi:viewed-files:',
  'kodi:review-threads:',
  'kodi:review-checkpoint:',
  'kodi:drafts:v1:'
] as const

export interface StorageIndexEntry {
  bytes: number
  touchedAt: number
}

export type StorageIndex = Record<string, StorageIndexEntry>

export interface BudgetStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  readonly length: number
  key(index: number): string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function isIndexEntry(value: unknown): value is StorageIndexEntry {
  if (!isRecord(value)) return false
  return typeof value.bytes === 'number' && Number.isFinite(value.bytes)
    && typeof value.touchedAt === 'number' && Number.isFinite(value.touchedAt)
}

export function isManagedStorageKey(key: string): boolean {
  return MANAGED_PREFIXES.some((prefix) => key.startsWith(prefix))
}

export function serializedSize(value: string): number {
  return value.length
}

export function parseStorageIndex(serialized: string | null): StorageIndex | null {
  if (serialized == null || serialized === '') return {}
  try {
    const parsed = JSON.parse(serialized) as unknown
    if (!isRecord(parsed)) return null
    const index: StorageIndex = {}
    for (const [key, entry] of Object.entries(parsed)) {
      if (key === '' || !isIndexEntry(entry)) return null
      index[key] = { bytes: entry.bytes, touchedAt: entry.touchedAt }
    }
    return index
  } catch {
    return null
  }
}

export function rebuildStorageIndex(storage: BudgetStorage, now = Date.now()): StorageIndex {
  const index: StorageIndex = {}
  for (let offset = 0; offset < storage.length; offset += 1) {
    const key = storage.key(offset)
    if (key == null || key === STORAGE_INDEX_KEY || !isManagedStorageKey(key)) continue
    const value = storage.getItem(key)
    if (value == null) continue
    index[key] = { bytes: serializedSize(value), touchedAt: now }
  }
  return index
}

export function loadStorageIndex(storage: BudgetStorage, now = Date.now()): StorageIndex {
  const parsed = parseStorageIndex(storage.getItem(STORAGE_INDEX_KEY))
  if (parsed != null) return parsed
  const rebuilt = rebuildStorageIndex(storage, now)
  persistIndex(storage, rebuilt)
  return rebuilt
}

function persistIndex(storage: BudgetStorage, index: StorageIndex): void {
  try {
    storage.setItem(STORAGE_INDEX_KEY, JSON.stringify(index))
  } catch {
    // The index is advisory; a failed write must not block the user payload.
  }
}

export function touchStorageKey(
  storage: BudgetStorage,
  key: string,
  bytes: number,
  now = Date.now()
): StorageIndex {
  const index = loadStorageIndex(storage, now)
  index[key] = { bytes, touchedAt: now }
  persistIndex(storage, index)
  return index
}

export function forgetStorageKey(storage: BudgetStorage, key: string): StorageIndex {
  const index = loadStorageIndex(storage)
  if (index[key] == null) return index
  delete index[key]
  persistIndex(storage, index)
  return index
}

export function enforceStorageBudget(
  storage: BudgetStorage,
  totalBudget = DEFAULT_STORAGE_BUDGET,
  preserveKey?: string,
  now = Date.now()
): string[] {
  const index = loadStorageIndex(storage, now)
  const evicted: string[] = []
  let retained = Object.values(index).reduce((bytes, entry) => bytes + entry.bytes, 0)
  if (retained <= totalBudget) return evicted

  const candidates = Object.entries(index)
    .filter(([key]) => key !== preserveKey)
    .sort((left, right) => left[1].touchedAt - right[1].touchedAt)

  for (const [key, entry] of candidates) {
    if (retained <= totalBudget) break
    try {
      storage.removeItem(key)
    } catch {
      continue
    }
    delete index[key]
    retained -= entry.bytes
    evicted.push(key)
  }
  persistIndex(storage, index)
  return evicted
}

export function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException
    && (error.name === 'QuotaExceededError' || error.code === 22)
}

export function persistManagedValue(
  storage: BudgetStorage,
  key: string,
  serialized: string,
  totalBudget = DEFAULT_STORAGE_BUDGET
): boolean {
  const write = (): void => {
    enforceStorageBudget(storage, totalBudget, key)
    storage.setItem(key, serialized)
    touchStorageKey(storage, key, serializedSize(serialized))
  }
  try {
    write()
    return true
  } catch (error) {
    if (!isQuotaExceeded(error)) return false
    try {
      enforceStorageBudget(storage, totalBudget, key)
      write()
      return true
    } catch {
      return false
    }
  }
}

const shownStorageToasts = new Set<string>()

export function notifyStorageWriteFailed(
  kind: 'comments' | 'viewed' | 'drafts' | 'checkpoint',
  show: (message: string) => void
): void {
  if (shownStorageToasts.has(kind)) return
  shownStorageToasts.add(kind)
  const messages = {
    comments: 'Review comments could not be saved locally (storage full).',
    viewed: 'Viewed-file marks could not be saved locally (storage full).',
    drafts: 'Unsaved drafts could not be saved locally (storage full).',
    checkpoint: 'The review checkpoint could not be saved locally (storage full).'
  } as const
  show(messages[kind])
}

export function browserBudgetStorage(): BudgetStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
