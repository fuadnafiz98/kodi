import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeFileAtomic } from './atomicWrite.js'

import {
  EMPTY_WORKSPACE_CACHE_STORE,
  parseWorkspaceCacheStore,
  type WorkspaceCache,
  type WorkspaceCacheStore
} from '../shared/workspaceCache.js'

const FILE_NAME = 'last-workspace.json'
let pendingSave: Promise<void> = Promise.resolve()

/**
 * Synchronous because the first HTML/React paint needs real folder names
 * before git status returns.
 */
export function loadWorkspaceCache(directory: string): WorkspaceCacheStore {
  try {
    return parseWorkspaceCacheStore(JSON.parse(readFileSync(join(directory, FILE_NAME), 'utf8')))
  } catch {
    return EMPTY_WORKSPACE_CACHE_STORE
  }
}

/**
 * Writes through a sibling temp file that is fsynced before the rename, so a
 * crash or power loss mid-write leaves the previous cache intact rather than a
 * truncated file the next launch has to throw away. Saves are chained so two of
 * them cannot interleave.
 */
export function saveWorkspaceCache(directory: string, store: WorkspaceCacheStore): Promise<void> {
  const path = join(directory, FILE_NAME)
  const serialized = serializeWorkspaceCacheStore(store)
  pendingSave = pendingSave
    .then(() => writeFileAtomic(path, serialized))
    .catch((error: unknown) => {
      console.error('Could not persist the last workspace:', error)
    })
  return pendingSave
}

export function flushWorkspaceCache(): Promise<void> {
  return pendingSave
}

// Every persisted UI change used to stringify all three slots — megabytes of
// path lists — although at most one slot had changed. A slot that is kept is the
// same object (the store is rebuilt around it) and so is a snapshot that
// survived a UI-only change (`capSnapshot` keeps it below the cap), so each is
// serialized once and spliced into the file from then on.
const serializedEntries = new WeakMap<WorkspaceCache, string>()
const serializedSnapshots = new WeakMap<WorkspaceCache['snapshot'], string>()

/**
 * Byte for byte what `JSON.stringify(store)` writes, reusing the text of every
 * entry and snapshot it has seen before. Both are treated as immutable, as the
 * rest of the cache already treats them.
 */
export function serializeWorkspaceCacheStore(store: WorkspaceCacheStore): string {
  const entries = store.entries.map(serializeEntry)
  return spliceJson(store, 'entries', `[${entries.join(',')}]`)
}

function serializeEntry(entry: WorkspaceCache): string {
  const cached = serializedEntries.get(entry)
  if (cached != null) return cached
  let snapshot = serializedSnapshots.get(entry.snapshot)
  if (snapshot == null) {
    snapshot = JSON.stringify(entry.snapshot)
    serializedSnapshots.set(entry.snapshot, snapshot)
  }
  const serialized = spliceJson(entry, 'snapshot', snapshot)
  serializedEntries.set(entry, serialized)
  return serialized
}

/**
 * Stringifies `value` with `key` stood in for by a `0`, then puts `json` where
 * the `0` is. Overriding a key in a spread keeps its position, so the output is
 * what stringifying the whole value would have written. The marker cannot match
 * inside an earlier string value, where every quote is escaped.
 */
function spliceJson(value: object, key: string, json: string): string {
  const shell = JSON.stringify({ ...value, [key]: 0 })
  const marker = `${JSON.stringify(key)}:0`
  const valueAt = shell.indexOf(marker) + marker.length - 1
  return `${shell.slice(0, valueAt)}${json}${shell.slice(valueAt + 1)}`
}
