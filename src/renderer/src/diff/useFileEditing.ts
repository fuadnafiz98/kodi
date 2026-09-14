import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FileContents } from '@pierre/diffs'
import type { Editor, EditorOptions } from '@pierre/diffs/edit'

import type { FileComparison, RepositoryReview } from '../../../shared/contracts'
import type { FileEditControls, WorkspaceView } from '../app/AppView'
import type { DocumentView } from '../review/documentView'
import type { ReviewAnnotationMetadata } from '../review/ReviewComments'
import {
  browserDraftStorage,
  draftPaths,
  putDraft,
  readDrafts,
  removeDraft,
  writeDrafts,
  type DraftMap
} from '../editor/draftStore'
import { resolveDiskState, resolveDraftFile, type DraftText } from '../editor/editSession'
import { getErrorMessage, requireRepositoryApi } from '../explorer/repositoryApi'
import { notifyStorageWriteFailed } from '../review/storageBudget'
import { showToast } from '../app/toast'

let editorModule: Promise<typeof import('@pierre/diffs/edit')> | null = null
let EditorConstructor: typeof import('@pierre/diffs/edit').Editor | null = null

export async function preloadDiffEditor(): Promise<void> {
  editorModule ??= import('@pierre/diffs/edit')
  const loaded = await editorModule
  EditorConstructor = loaded.Editor
}

export function createDiffEditor<LAnnotation>(options: EditorOptions<LAnnotation>): Editor<LAnnotation> {
  if (EditorConstructor == null) throw new Error('The editor module is not loaded.')
  return new EditorConstructor(options)
}

interface FileEditSession {
  path: string
  mode: 'edit' | 'preview'
  /**
   * The comparison the session renders. Its identity is pinned for the whole
   * session: the surface must never receive a new `newFile` while typing, or
   * the library re-diffs and re-tokenizes the file and rebuilds the editor's
   * text document — losing undo history — on every keystroke.
   */
  base: FileComparison
  sourceCacheKey: string
  sourceContents: string
  dirty: boolean
}

export interface EditConflict {
  path: string
  comparison: FileComparison
}

interface UseFileEditingOptions {
  root: string
  comparison: FileComparison | null
  selectedPath: string | null
  workspaceView: WorkspaceView
  repositoryReview: RepositoryReview | null
  autosaveOnBlur: boolean
  onWorkspaceViewChange(view: WorkspaceView): void
  onSelectPath(path: string): void
  onComparisonChange(comparison: FileComparison): void
  onError(message: string | null): void
}

interface FileEditingController {
  hasSession: boolean
  activeSession: FileEditSession | null
  renderedComparison: FileComparison | null
  controls: FileEditControls
  conflict: EditConflict | null
  keepDraft(): void
  reloadFromDisk(): void
  attachEditor(editor: Editor<ReviewAnnotationMetadata>): void
  updateDraftFile(file: FileContents): void
  handleEditorBlur(): void
  getEditor(): Editor<ReviewAnnotationMetadata> | null
}

function createSession(comparison: FileComparison, draft?: DraftText): FileEditSession | null {
  const file = comparison.newFile
  if (file == null || comparison.binary || comparison.oversized) return null
  const draftContents = resolveDraftFile(file, draft).contents
  return {
    path: comparison.path,
    mode: 'edit',
    base: comparison,
    sourceCacheKey: file.cacheKey,
    sourceContents: file.contents,
    // Leaving edit mode keeps the draft, and the editor keeps its cached text
    // document under the same cacheKey, so resuming has to start out dirty.
    dirty: draftContents !== file.contents
  }
}

const DRAFT_PERSIST_DEBOUNCE_MS = 400
const restoredDraftRoots = new Set<string>()

export function shouldAutosaveOnBlur(options: {
  enabled: boolean
  dirty: boolean
  saving: boolean
  conflict: boolean
}): boolean {
  return options.enabled && options.dirty && !options.saving && !options.conflict
}

export function useFileEditing({
  root,
  comparison,
  selectedPath,
  workspaceView,
  repositoryReview,
  autosaveOnBlur,
  onWorkspaceViewChange,
  onSelectPath,
  onComparisonChange,
  onError
}: UseFileEditingOptions): FileEditingController {
  const [session, setSession] = useState<FileEditSession | null>(null)
  const [documentView, setDocumentView] = useState<DocumentView>('split')
  const [saving, setSaving] = useState(false)
  const [history, setHistory] = useState({ canUndo: false, canRedo: false })
  const [drafts, setDrafts] = useState<DraftMap>(() => readDrafts(root, browserDraftStorage()))
  const editorRef = useRef<Editor<ReviewAnnotationMetadata> | null>(null)
  const savingRef = useRef(false)
  const editRequestRef = useRef(0)
  const attachedPathsRef = useRef(new Set<string>())
  // Keyed by the cacheKey the draft was typed against, so a draft that predates
  // an external write is never replayed over the newer file.
  const [draftContents] = useState(() => new Map<string, DraftText>(
    Object.values(drafts).map((draft) => [draft.path, {
      baseCacheKey: draft.sourceCacheKey,
      contents: draft.contents
    }])
  ))
  const persistTimerRef = useRef<number | null>(null)
  const selectedPathRef = useRef(selectedPath)
  useEffect(() => {
    selectedPathRef.current = selectedPath
  }, [selectedPath])

  // An external write (agent, checkout, formatter) makes the revision the next
  // save asserts about disk stale. A clean session adopts the new revision as it
  // renders; a dirty one has to ask, because either answer loses somebody's work.
  const diskFile = comparison != null && comparison.path === session?.path ? comparison.newFile : null
  const diskState = resolveDiskState(session, diskFile)
  const activeSession = useMemo<FileEditSession | null>(() => {
    if (session == null || comparison == null || session.path !== comparison.path) return null
    if (diskState !== 'adopt' || diskFile == null) return session
    return { ...session, base: comparison, sourceContents: diskFile.contents, sourceCacheKey: diskFile.cacheKey }
  }, [comparison, diskFile, diskState, session])
  const conflictComparison = diskState === 'conflict' ? comparison : null
  const conflict = useMemo<EditConflict | null>(
    () => conflictComparison == null ? null : { path: conflictComparison.path, comparison: conflictComparison },
    [conflictComparison]
  )
  const sessionRef = useRef<FileEditSession | null>(activeSession)
  const conflictRef = useRef<EditConflict | null>(conflict)
  useEffect(() => {
    sessionRef.current = activeSession
    conflictRef.current = conflict
  }, [activeSession, conflict])

  const sessionBase = activeSession?.base
  const sessionPath = activeSession?.path
  const sessionMode = activeSession?.mode
  // Only session boundaries — entering, resuming, switching between edit and
  // preview — publish draft text to the surface. Typing updates the ref, and
  // the library keeps the rendered DOM and the diff in sync from the editor's
  // own document, so the file prop identity must not move while it happens.
  const sessionComparison = useMemo(() => {
    if (sessionBase == null || sessionPath == null || sessionMode == null) return null
    const file = sessionBase.newFile
    if (file == null) return sessionBase
    const rendered = resolveDraftFile(file, draftContents.get(sessionPath))
    return rendered === file ? sessionBase : { ...sessionBase, newFile: rendered }
    // sessionMode is a dependency because switching to preview and back is a
    // boundary that has to republish the draft, not because it is read here.
  }, [draftContents, sessionBase, sessionMode, sessionPath])

  const renderedComparison = activeSession == null ? comparison : sessionComparison
  const canEditLoadedFile = comparison?.newFile != null
    && !comparison.binary
    && !comparison.oversized
  const canRequestEdit = repositoryReview == null
    && selectedPath != null
    && (workspaceView === 'multi' || canEditLoadedFile)
  const unavailableReason = repositoryReview != null
    ? 'Editing is disabled while a review is open.'
    : comparison?.binary === true
      ? 'Binary files cannot be edited.'
      : comparison?.oversized === true
        ? 'Files larger than 2 MB cannot be edited.'
        : null

  const syncHistory = useCallback(() => {
    const editor = editorRef.current
    const canUndo = editor?.canUndo ?? false
    const canRedo = editor?.canRedo ?? false
    setHistory((current) => current.canUndo === canUndo && current.canRedo === canRedo
      ? current
      : { canUndo, canRedo })
  }, [])

  const attachEditor = useCallback((editor: Editor<ReviewAnnotationMetadata>) => {
    editorRef.current = editor
    syncHistory()
    const path = sessionRef.current?.path
    // `persistState` restores the caret and scroll of a file this session has
    // already edited, so the initial placement only owns a file's first attach.
    const firstAttach = path == null || !attachedPathsRef.current.has(path)
    if (path != null) attachedPathsRef.current.add(path)
    window.requestAnimationFrame(() => {
      editor.focus(firstAttach ? { lineNumber: 'first-visible', preventScroll: true } : { preventScroll: true })
    })
  }, [syncHistory])

  // React can replay a state updater, so the next map is computed from a mirror
  // ref and the storage write happens outside the setter.
  const draftsRef = useRef(drafts)
  const applyDrafts = useCallback((update: (current: DraftMap) => DraftMap) => {
    const next = update(draftsRef.current)
    if (next === draftsRef.current) return
    draftsRef.current = next
    setDrafts(next)
    if (persistTimerRef.current != null) window.clearTimeout(persistTimerRef.current)
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null
      if (!writeDrafts(root, next, browserDraftStorage())) {
        notifyStorageWriteFailed('drafts', showToast)
      }
    }, DRAFT_PERSIST_DEBOUNCE_MS)
  }, [root])

  const updateDraftFile = useCallback((file: FileContents) => {
    const current = sessionRef.current
    if (current == null || current.path !== file.name) return
    draftContents.set(current.path, {
      baseCacheKey: current.base.newFile?.cacheKey ?? current.sourceCacheKey,
      contents: file.contents
    })
    const dirty = file.contents !== current.sourceContents
    setSession((previous) => previous == null || previous.path !== current.path || previous.dirty === dirty
      ? previous
      : { ...previous, dirty })
    applyDrafts((previous) => dirty
      ? putDraft(previous, {
        path: current.path,
        sourceCacheKey: current.sourceCacheKey,
        contents: file.contents,
        savedAt: Date.now()
      })
      : removeDraft(previous, current.path))
    queueMicrotask(syncHistory)
  }, [applyDrafts, draftContents, syncHistory])

  const startEditing = useCallback(async () => {
    if (session != null && activeSession == null) {
      try {
        await preloadDiffEditor()
        onSelectPath(session.path)
        onWorkspaceViewChange('file')
      } catch (error) {
        onError(getErrorMessage(error))
      }
      return
    }
    if (repositoryReview != null || selectedPath == null) return
    if (workspaceView === 'multi') {
      const requestId = editRequestRef.current + 1
      editRequestRef.current = requestId
      onError(null)
      try {
        const [loadedComparison] = await Promise.all([
          requireRepositoryApi().getComparison(selectedPath),
          preloadDiffEditor()
        ])
        if (requestId !== editRequestRef.current || selectedPathRef.current !== selectedPath) return
        const nextSession = createSession(loadedComparison, draftContents.get(selectedPath))
        if (nextSession == null) throw new Error('This working file is not editable.')
        onComparisonChange(loadedComparison)
        setSession(nextSession)
        onWorkspaceViewChange('file')
      } catch (error) {
        onError(getErrorMessage(error))
      }
      return
    }
    if (comparison == null) return
    try {
      await preloadDiffEditor()
      const nextSession = createSession(comparison, draftContents.get(comparison.path))
      if (nextSession != null) setSession(nextSession)
    } catch (error) {
      onError(getErrorMessage(error))
    }
  }, [activeSession, comparison, draftContents, onComparisonChange, onError, onSelectPath, onWorkspaceViewChange,
    repositoryReview, selectedPath, session, workspaceView])

  const setMode = useCallback((mode: 'edit' | 'preview') => {
    setSession((current) => current == null || current.mode === mode
      ? current
      : { ...current, mode })
  }, [])

  // Leaving edit mode keeps the draft: the editor holds the text document under
  // the same cacheKey either way, so discarding here would only desynchronise
  // the two. Revert is the explicit way back, and it is undoable.
  const close = useCallback(() => {
    editorRef.current = null
    setHistory({ canUndo: false, canRedo: false })
    setSession(null)
  }, [])

  const revert = useCallback(() => {
    const current = sessionRef.current
    const editor = editorRef.current
    if (current == null || editor == null || !current.dirty) return
    const draft = draftContents.get(current.path)?.contents ?? ''
    const lines = draft.split('\n')
    const lastLine = Math.max(0, lines.length - 1)
    editor.applyEdits([{
      range: {
        start: { line: 0, character: 0 },
        end: { line: lastLine, character: lines[lastLine]?.length ?? 0 }
      },
      newText: current.sourceContents
    }])
    queueMicrotask(syncHistory)
  }, [draftContents, syncHistory])

  const undo = useCallback(() => {
    editorRef.current?.undo()
    queueMicrotask(syncHistory)
  }, [syncHistory])

  const redo = useCallback(() => {
    editorRef.current?.redo()
    queueMicrotask(syncHistory)
  }, [syncHistory])

  const save = useCallback(async () => {
    const current = sessionRef.current
    if (current == null || !current.dirty || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    onError(null)
    // The ref is written by every onChange; getText is the cross-check for the
    // rare case where the editor detached before the last change landed.
    const contents = draftContents.get(current.path)?.contents
      ?? editorRef.current?.getText()
      ?? current.sourceContents
    try {
      const savedComparison = await requireRepositoryApi().saveWorkingFile({
        path: current.path,
        contents,
        expectedCacheKey: current.sourceCacheKey
      })
      const savedFile = savedComparison.newFile
      // The session stays alive so the caret, scroll and undo history survive a
      // save; only the disk revision the next save checks against moves on.
      setSession((previous) => previous == null || previous.path !== current.path
        ? previous
        : {
          ...previous,
          sourceCacheKey: savedFile?.cacheKey ?? previous.sourceCacheKey,
          sourceContents: contents,
          dirty: false
        })
      applyDrafts((previous) => removeDraft(previous, current.path))
      onComparisonChange(savedComparison)
      showToast(`Saved ${current.path}`)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [applyDrafts, draftContents, onComparisonChange, onError])

  const handleEditorBlur = useCallback(() => {
    const current = sessionRef.current
    if (!shouldAutosaveOnBlur({
      enabled: autosaveOnBlur,
      dirty: current?.dirty ?? false,
      saving: savingRef.current,
      conflict: conflictRef.current != null
    })) return
    void save()
  }, [autosaveOnBlur, save])

  const keepDraft = useCallback(() => {
    const pending = conflictRef.current
    if (pending == null) return
    // Adopting the disk revision lets the next save pass the conflict check and
    // deliberately overwrite what landed underneath the draft.
    setSession((current) => current == null || current.path !== pending.path
      ? current
      : { ...current, sourceCacheKey: pending.comparison.newFile?.cacheKey ?? current.sourceCacheKey })
  }, [])

  const reloadFromDisk = useCallback(() => {
    const pending = conflictRef.current
    if (pending == null) return
    draftContents.delete(pending.path)
    attachedPathsRef.current.delete(pending.path)
    applyDrafts((previous) => removeDraft(previous, pending.path))
    const nextSession = createSession(pending.comparison)
    setSession(nextSession)
    onComparisonChange(pending.comparison)
  }, [applyDrafts, draftContents, onComparisonChange])

  useEffect(() => {
    if (activeSession == null) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      void save()
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [activeSession, save])

  const dirtyPaths = useMemo(() => draftPaths(drafts), [drafts])

  useEffect(() => {
    if (dirtyPaths.length === 0 || restoredDraftRoots.has(root)) return
    restoredDraftRoots.add(root)
    const firstPath = dirtyPaths[0]!
    showToast(`${dirtyPaths.length} unsaved ${dirtyPaths.length === 1 ? 'draft' : 'drafts'} restored`, {
      label: 'Open',
      run: () => onSelectPath(firstPath)
    })
  }, [dirtyPaths, onSelectPath, root])

  useEffect(() => {
    if (dirtyPaths.length === 0) return
    const confirmClose = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', confirmClose)
    return () => window.removeEventListener('beforeunload', confirmClose)
  }, [dirtyPaths.length])

  useEffect(() => () => {
    if (persistTimerRef.current != null) window.clearTimeout(persistTimerRef.current)
  }, [])

  const getEditor = useCallback(() => editorRef.current, [])

  const controls = useMemo<FileEditControls>(() => ({
    available: canRequestEdit || session != null,
    unavailableReason: canRequestEdit || session != null ? null : unavailableReason,
    startLabel: session != null && activeSession == null ? 'Resume draft' : 'Edit',
    mode: activeSession?.mode ?? 'read',
    documentView,
    dirty: activeSession?.dirty ?? false,
    saving,
    canUndo: activeSession?.mode === 'edit' && history.canUndo,
    canRedo: activeSession?.mode === 'edit' && history.canRedo,
    unsavedPaths: dirtyPaths,
    onStart: () => { void startEditing() },
    onModeChange: setMode,
    onDocumentViewChange: setDocumentView,
    onUndo: undo,
    onRedo: redo,
    onCancel: close,
    onRevert: revert,
    onSave: () => { void save() },
    onOpenPath: onSelectPath
  }), [activeSession, canRequestEdit, close, dirtyPaths, documentView, history, onSelectPath, redo,
    revert, save, saving, session, setMode, startEditing, unavailableReason, undo])

  return {
    hasSession: session != null,
    activeSession,
    renderedComparison,
    controls,
    conflict,
    keepDraft,
    reloadFromDisk,
    attachEditor,
    updateDraftFile,
    handleEditorBlur,
    getEditor
  }
}
