import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeFileAtomic } from './atomicWrite.js'

import {
  EMPTY_WORKSPACE_CACHE_STORE,
  parseWorkspaceCacheStore,
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
  const serialized = JSON.stringify(store)
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
