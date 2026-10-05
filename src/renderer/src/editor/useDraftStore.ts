import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { FileComparison } from '../../../shared/contracts'
import { showToast } from '../app/toast'
import { requireRepositoryApi } from '../explorer/repositoryApi'
import { notifyStorageWriteFailed } from '../review/storageBudget'
import {
  browserDraftStorage,
  draftPaths,
  putDraft,
  readDrafts,
  removeDraft,
  writeDrafts,
  type DraftMap
} from './draftStore'
import type { DraftText } from './editSession'

/**
 * The drafts, for a surface that edits files itself — the review. One store, so
 * a draft typed in either place is the draft in both, and every one of them
 * counts towards the unsaved pill, hibernation and quitting.
 */
export interface WorkingDrafts {
  /** Whether the file has unsaved text anywhere. */
  has(path: string): boolean
  /** The draft typed against this exact disk revision, if there is one. */
  get(path: string, sourceCacheKey: string): string | undefined
  /** Records the text; text equal to the disk copy drops the draft. */
  put(path: string, sourceCacheKey: string, sourceContents: string, contents: string): void
  /** Writes the file, asserting the revision the draft was typed against. */
  save(path: string, contents: string, expectedCacheKey: string): Promise<FileComparison>
}

export interface DraftStore {
  /** Which files have unsaved text; the text itself is in `draftContents`. */
  dirtyPaths: readonly string[]
  draftContents: Map<string, DraftText>
  applyDrafts(update: (current: DraftMap) => DraftMap): void
  workingDrafts: WorkingDrafts
}

const DRAFT_PERSIST_DEBOUNCE_MS = 400
const restoredDraftRoots = new Set<string>()

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((path, index) => path === right[index])
}

/**
 * Every unsaved draft in a repository: kept across leaving a file, persisted
 * for a reload, offered back on launch, and guarding the window from closing.
 */
export function useDraftStore({
  root,
  onSelectPath,
  onComparisonChange
}: {
  root: string
  onSelectPath(path: string): void
  onComparisonChange(comparison: FileComparison): void
}): DraftStore {
  const [initialDrafts] = useState<DraftMap>(() => readDrafts(root, browserDraftStorage()))
  // Only which files have drafts is state; their text changes on every keystroke
  // and lives in `draftsRef`. Holding the map in state re-rendered the whole
  // workspace per character typed.
  const [dirtyPaths, setDirtyPaths] = useState<readonly string[]>(() => draftPaths(initialDrafts))
  // Keyed by the cacheKey the draft was typed against, so a draft that predates
  // an external write is never replayed over the newer file.
  const [draftContents] = useState(() => new Map<string, DraftText>(
    Object.values(initialDrafts).map((draft) => [draft.path, {
      baseCacheKey: draft.sourceCacheKey,
      contents: draft.contents
    }])
  ))
  const persistTimerRef = useRef<number | null>(null)

  // React can replay a state updater, so the next map is computed from a mirror
  // ref and the storage write happens outside the setter.
  const draftsRef = useRef(initialDrafts)
  const applyDrafts = useCallback((update: (current: DraftMap) => DraftMap) => {
    const next = update(draftsRef.current)
    if (next === draftsRef.current) return
    draftsRef.current = next
    const nextPaths = draftPaths(next)
    setDirtyPaths((current) => samePaths(current, nextPaths) ? current : nextPaths)
    if (persistTimerRef.current != null) window.clearTimeout(persistTimerRef.current)
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null
      if (!writeDrafts(root, next, browserDraftStorage())) {
        notifyStorageWriteFailed('drafts', showToast)
      }
    }, DRAFT_PERSIST_DEBOUNCE_MS)
  }, [root])

  const workingDrafts = useMemo<WorkingDrafts>(() => ({
    has(path) {
      return draftsRef.current[path] != null
    },
    get(path, sourceCacheKey) {
      const draft = draftContents.get(path)
      return draft?.baseCacheKey === sourceCacheKey ? draft.contents : undefined
    },
    put(path, sourceCacheKey, sourceContents, contents) {
      draftContents.set(path, { baseCacheKey: sourceCacheKey, contents })
      applyDrafts((previous) => contents === sourceContents
        ? removeDraft(previous, path)
        : putDraft(previous, { path, sourceCacheKey, contents, savedAt: Date.now() }))
    },
    async save(path, contents, expectedCacheKey) {
      const saved = await requireRepositoryApi().saveWorkingFile({ path, contents, expectedCacheKey })
      draftContents.delete(path)
      applyDrafts((previous) => removeDraft(previous, path))
      onComparisonChange(saved)
      showToast(`Saved ${path}`)
      return saved
    }
  }), [applyDrafts, draftContents, onComparisonChange])

  // Only drafts found in storage were restored. Announcing the first draft of the
  // session instead told the reader so on their first keystroke.
  const [restoredPaths] = useState(() => draftPaths(initialDrafts))
  useEffect(() => {
    if (restoredPaths.length === 0 || restoredDraftRoots.has(root)) return
    restoredDraftRoots.add(root)
    const firstPath = restoredPaths[0]!
    showToast(`${restoredPaths.length} unsaved ${restoredPaths.length === 1 ? 'draft' : 'drafts'} restored`, {
      label: 'Open',
      run: () => onSelectPath(firstPath)
    })
  }, [onSelectPath, restoredPaths, root])

  useEffect(() => {
    if (dirtyPaths.length === 0) return
    const confirmClose = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', confirmClose)
    return () => window.removeEventListener('beforeunload', confirmClose)
  }, [dirtyPaths.length])

  // The page can go before the debounced write fires: a quit by signal closes
  // it without asking, and the last keystrokes were lost with it. Leaving the
  // repository's workspace dropped them the same way.
  useEffect(() => {
    const flush = (): void => {
      if (persistTimerRef.current == null) return
      window.clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
      if (!writeDrafts(root, draftsRef.current, browserDraftStorage())) {
        notifyStorageWriteFailed('drafts', showToast)
      }
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [root])

  return { dirtyPaths, draftContents, applyDrafts, workingDrafts }
}
