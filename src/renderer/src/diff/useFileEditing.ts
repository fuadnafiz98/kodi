import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { FileContents } from '@pierre/diffs'
import type { Editor, EditorOptions } from '@pierre/diffs/edit'

import type { FileComparison, RepositoryReview } from '../../../shared/contracts'
import { CACHED_TEXT_KEY_PREFIX } from '../../../shared/workspaceCache'
import type { EditCaretPosition, FileEditControls, WorkspaceView } from '../app/AppView'
import type { DocumentView } from '../review/documentView'
import type { ReviewAnnotationMetadata } from '../review/ReviewComments'
import { putDraft, removeDraft } from '../editor/draftStore'
import { resolveDiskState, resolveDraftFile, type DraftText } from '../editor/editSession'
import { getErrorMessage, requireRepositoryApi } from '../explorer/repositoryApi'
import { showToast } from '../app/toast'
import type { TextEdit } from '../editor/minimalTextEdit'
import { useDraftStore, type DraftStore, type WorkingDrafts } from '../editor/useDraftStore'

export type { WorkingDrafts } from '../editor/useDraftStore'

let editorModule: Promise<[
  typeof import('@pierre/diffs/edit'),
  typeof import('../editor/minimalTextEdit'),
  typeof import('../editor/selectionActionBar')
]> | null = null
let EditorConstructor: typeof import('@pierre/diffs/edit').Editor | null = null
// Only an editor ever needs these, so they travel with the editor module rather
// than with the workspace, which every launch loads.
let textEdit: typeof import('../editor/minimalTextEdit').minimalTextEdit | null = null
let selectionBar: typeof import('../editor/selectionActionBar').createSelectionActionElement | null = null

export async function preloadDiffEditor(): Promise<void> {
  editorModule ??= Promise.all([
    import('@pierre/diffs/edit'),
    import('../editor/minimalTextEdit'),
    import('../editor/selectionActionBar')
  ])
  const [loaded, edits, bar] = await editorModule
  EditorConstructor = loaded.Editor
  textEdit = edits.minimalTextEdit
  selectionBar = bar.createSelectionActionElement
}

/** The bar a ranged selection shows; only an editor, loaded with it, asks. */
export function createSelectionBar(
  ...args: Parameters<typeof import('../editor/selectionActionBar').createSelectionActionElement>
): HTMLElement {
  if (selectionBar == null) throw new Error('The editor module is not loaded.')
  return selectionBar(...args)
}

/** See `minimalTextEdit`; loaded with the editor, so any attached editor has it. */
function minimalTextEdit(from: string, to: string): TextEdit | null {
  if (textEdit == null) throw new Error('The editor module is not loaded.')
  return textEdit(from, to)
}

export function createDiffEditor<LAnnotation>(options: EditorOptions<LAnnotation>): Editor<LAnnotation> {
  if (EditorConstructor == null) throw new Error('The editor module is not loaded.')
  return new EditorConstructor(options)
}

interface FileEditSession {
  path: string
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
  /** The cacheKey the surface renders under (see renderKeyFor). */
  renderKey: string
}

// The editor keeps each file's text document by cacheKey for the life of the
// app, and the cacheKey is the disk content's hash. A document that has been
// typed into no longer holds the text its key names, so when the disk came
// back to that content — the edit undone from outside, a checkout — the stale
// document was put back on screen. A key typed into is never rendered again;
// an untouched one is, and keeps the viewer's highlight cache warm.
const typedRenderKeys = new Set<string>()
let renderKeySalt = 0

function renderKeyFor(cacheKey: string): string {
  if (!typedRenderKeys.has(cacheKey)) return cacheKey
  renderKeySalt += 1
  return `${cacheKey}:edit${renderKeySalt}`
}

// Reading goes through the same cache: the viewer's rendered file for a key an
// edit went through is the edited text. A read of that key gets a stand-in of
// its own, one per key, and the same object for the same comparison.
const readKeys = new Map<string, string>()
const readComparisons = new WeakMap<FileComparison, FileComparison>()

function readableComparison(comparison: FileComparison | null): FileComparison | null {
  const file = comparison?.newFile
  if (comparison == null || file == null || !typedRenderKeys.has(file.cacheKey)) return comparison
  const cached = readComparisons.get(comparison)
  if (cached != null) return cached
  let key = readKeys.get(file.cacheKey)
  if (key == null) {
    renderKeySalt += 1
    key = `${file.cacheKey}:read${renderKeySalt}`
    readKeys.set(file.cacheKey, key)
  }
  const readable = { ...comparison, newFile: { ...file, cacheKey: key } }
  readComparisons.set(comparison, readable)
  return readable
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
  onSelectPath(path: string): void
  onComparisonChange(comparison: FileComparison): void
  onError(message: string | null): void
}


interface FileEditingController {
  hasSession: boolean
  workingDrafts: WorkingDrafts
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
    base: comparison,
    renderKey: renderKeyFor(file.cacheKey),
    sourceCacheKey: file.cacheKey,
    sourceContents: file.contents,
    // Leaving a file keeps its draft, and the editor keeps its cached text
    // document under the same cacheKey, so coming back has to start out dirty.
    dirty: draftContents !== file.contents
  }
}


export function shouldAutosaveOnBlur(options: {
  enabled: boolean
  dirty: boolean
  saving: boolean
  conflict: boolean
}): boolean {
  return options.enabled && options.dirty && !options.saving && !options.conflict
}

/** The text a launch painted from the workspace cache, before main's copy. */
export function isCachedTextComparison(comparison: FileComparison | null): boolean {
  return comparison?.newFile?.cacheKey.startsWith(CACHED_TEXT_KEY_PREFIX) === true
}

/** Whether the open file can be edited here, and if not, the reason to show. */
function editAvailability(
  comparison: FileComparison | null,
  selectedPath: string | null,
  workspaceView: WorkspaceView,
  repositoryReview: RepositoryReview | null
): { canRequestEdit: boolean; unavailableReason: string | null } {
  if (repositoryReview != null) return { canRequestEdit: false, unavailableReason: 'Editing is disabled while a review is open.' }
  if (comparison?.binary === true) return { canRequestEdit: false, unavailableReason: 'Binary files cannot be edited.' }
  if (comparison?.oversized === true) return { canRequestEdit: false, unavailableReason: 'Files larger than 2 MB cannot be edited.' }
  // The text a launch painted is not the file on disk yet: a click there waits
  // for main's copy, a moment later, rather than typing into a stand-in.
  const canRequestEdit = selectedPath != null && workspaceView === 'file' && comparison?.path === selectedPath
    && comparison.newFile != null && !isCachedTextComparison(comparison)
  return { canRequestEdit, unavailableReason: null }
}

/** A draft typed against exactly the file now on disk, with text that differs from it. */
function hasDraftToResume(comparison: FileComparison | null, draftContents: ReadonlyMap<string, DraftText>): boolean {
  const file = comparison?.newFile
  if (comparison == null || file == null) return false
  const draft = draftContents.get(comparison.path)
  return draft != null && resolveDraftFile(file, draft) !== file
}

function useSessionComparison(
  activeSession: FileEditSession | null,
  draftContents: ReadonlyMap<string, DraftText>
): FileComparison | null {
  const sessionBase = activeSession?.base
  const sessionPath = activeSession?.path
  const sessionRenderKey = activeSession?.renderKey
  // Only session boundaries — starting, coming back to a draft — publish draft
  // text to the surface. Typing updates the ref, and the library keeps the
  // rendered DOM and the diff in sync from the editor's own document, so the
  // file prop identity must not move while it happens.
  return useMemo(() => {
    if (sessionBase == null || sessionPath == null) return null
    const file = sessionBase.newFile
    if (file == null || sessionRenderKey == null) return sessionBase
    const rendered = resolveDraftFile(file, draftContents.get(sessionPath))
    if (rendered === file && sessionRenderKey === file.cacheKey) return sessionBase
    return { ...sessionBase, newFile: { ...rendered, cacheKey: sessionRenderKey } }
  }, [draftContents, sessionBase, sessionPath, sessionRenderKey])
}

/**
 * The session as the file on screen sees it. It ends when the reader leaves the
 * file — the draft is kept, in storage and in the editor's cached document, and
 * coming back to a file with a draft starts a new one — and when a write from
 * outside lands under a clean session (a formatter, an agent, a checkout): the
 * attached editor keeps its own document whatever file it is handed, so the only
 * way to show the disk is to read it again. Nothing unsaved is lost, and the next
 * click edits the new text. A dirty session asks instead (`diskState`), because
 * either answer loses somebody's work.
 */
function sessionOnScreen(
  session: FileEditSession | null,
  comparison: FileComparison | null,
  selectedPath: string | null,
  workspaceView: WorkspaceView
): { ended: boolean; activeSession: FileEditSession | null; diskState: ReturnType<typeof resolveDiskState> } {
  if (session == null) return { ended: false, activeSession: null, diskState: 'unchanged' }
  if (session.path !== selectedPath || workspaceView !== 'file') return { ended: true, activeSession: null, diskState: 'unchanged' }
  if (comparison == null || comparison.path !== session.path) return { ended: false, activeSession: null, diskState: 'unchanged' }
  const diskState = resolveDiskState(session, comparison.newFile)
  // The comparison the session opened on is still the prop for a beat after a
  // save moved the revision on; only a comparison that arrived since is a write.
  if (diskState === 'adopt' && comparison !== session.base) return { ended: true, activeSession: null, diskState }
  return { ended: false, activeSession: session, diskState }
}

function withDirty(session: FileEditSession | null, path: string, dirty: boolean): FileEditSession | null {
  return session == null || session.path !== path || session.dirty === dirty ? session : { ...session, dirty }
}

/** The editor the surface attached, and where its caret goes when it does. */
function useEditorAttachment(
  sessionRef: RefObject<FileEditSession | null>,
  draftContents: ReadonlyMap<string, DraftText>
) {
  const editorRef = useRef<Editor<ReviewAnnotationMetadata> | null>(null)
  // Where the reader clicked to start editing: the caret goes there once the
  // editor attaches, a frame or two after the click.
  const pendingCaretRef = useRef<EditCaretPosition | null>(null)
  const attachedPathsRef = useRef(new Set<string>())
  const attachEditor = useCallback((editor: Editor<ReviewAnnotationMetadata>) => {
    editorRef.current = editor
    const path = sessionRef.current?.path
    // The click that started the session owns the caret. Without one — a draft
    // resumed on arrival — `persistState` restores the caret of a file already
    // edited, so the initial placement only owns a file's first attach.
    const caret = pendingCaretRef.current
    pendingCaretRef.current = null
    const firstAttach = path == null || !attachedPathsRef.current.has(path)
    if (path != null) attachedPathsRef.current.add(path)
    // A draft resumed as its file opens reaches a viewer that has already drawn
    // the disk copy, and the editor adopts what is drawn: the toolbar said
    // Unsaved over the disk text. The session's own text is put in, once.
    const draft = path == null ? undefined : draftContents.get(path)
    const session = sessionRef.current
    const resumed = session != null && draft != null && draft.baseCacheKey === session.sourceCacheKey
      ? minimalTextEdit(editor.getText(), draft.contents)
      : null
    if (resumed != null) editor.applyEdits([resumed])
    window.requestAnimationFrame(() => {
      if (caret != null) editor.focus({ ...caret, preventScroll: true })
      else editor.focus(firstAttach ? { lineNumber: 'first-visible', preventScroll: true } : { preventScroll: true })
    })
  }, [draftContents, sessionRef])
  const getEditor = useCallback(() => editorRef.current, [])
  return { editorRef, pendingCaretRef, attachedPathsRef, attachEditor, getEditor }
}

/** What a session can be told to do: save, go back to disk, settle a conflict. */
function useSessionCommands({
  active,
  sessionRef,
  conflictRef,
  editorRef,
  attachedPathsRef,
  draftContents,
  applyDrafts,
  setSession,
  autosaveOnBlur,
  onComparisonChange,
  onError
}: {
  active: boolean
  sessionRef: RefObject<FileEditSession | null>
  conflictRef: RefObject<EditConflict | null>
  editorRef: RefObject<Editor<ReviewAnnotationMetadata> | null>
  attachedPathsRef: RefObject<Set<string>>
  draftContents: Map<string, DraftText>
  applyDrafts: DraftStore['applyDrafts']
  setSession: Dispatch<SetStateAction<FileEditSession | null>>
  autosaveOnBlur: boolean
  onComparisonChange(comparison: FileComparison): void
  onError(message: string | null): void
}) {
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  const revert = useCallback(() => {
    const current = sessionRef.current
    const editor = editorRef.current
    if (current == null || editor == null || !current.dirty) return
    // Only what was typed goes back, so the caret stays where the change was.
    const edit = minimalTextEdit(editor.getText(), current.sourceContents)
    if (edit != null) editor.applyEdits([edit])
  }, [editorRef, sessionRef])

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
      // Saved text is the disk's now; left here it would be replayed as a draft
      // the next time the disk shows the revision it was typed against. Text
      // typed while the write was out is still a draft and stays.
      if (draftContents.get(current.path)?.contents === contents) draftContents.delete(current.path)
      onComparisonChange(savedComparison)
      showToast(`Saved ${current.path}`)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [applyDrafts, draftContents, editorRef, onComparisonChange, onError, sessionRef, setSession])

  const handleEditorBlur = useCallback(() => {
    const current = sessionRef.current
    if (!shouldAutosaveOnBlur({
      enabled: autosaveOnBlur,
      dirty: current?.dirty ?? false,
      saving: savingRef.current,
      conflict: conflictRef.current != null
    })) return
    void save()
  }, [autosaveOnBlur, conflictRef, save, sessionRef])

  const keepDraft = useCallback(() => {
    const pending = conflictRef.current
    if (pending == null) return
    // Adopting the disk revision lets the next save pass the conflict check and
    // deliberately overwrite what landed underneath the draft.
    setSession((current) => current == null || current.path !== pending.path
      ? current
      : { ...current, sourceCacheKey: pending.comparison.newFile?.cacheKey ?? current.sourceCacheKey })
  }, [conflictRef, setSession])

  const reloadFromDisk = useCallback(() => {
    const pending = conflictRef.current
    if (pending == null) return
    draftContents.delete(pending.path)
    attachedPathsRef.current.delete(pending.path)
    applyDrafts((previous) => removeDraft(previous, pending.path))
    const nextSession = createSession(pending.comparison)
    setSession(nextSession)
    onComparisonChange(pending.comparison)
  }, [applyDrafts, attachedPathsRef, conflictRef, draftContents, onComparisonChange, setSession])

  useEffect(() => {
    if (!active) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      void save()
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [active, save])

  return { saving, revert, save, handleEditorBlur, keepDraft, reloadFromDisk }
}

export function useFileEditing({
  root,
  comparison,
  selectedPath,
  workspaceView,
  repositoryReview,
  autosaveOnBlur,
  onSelectPath,
  onComparisonChange,
  onError
}: UseFileEditingOptions): FileEditingController {
  const [session, setSession] = useState<FileEditSession | null>(null)
  const [documentView, setDocumentView] = useState<DocumentView>('split')
  const { dirtyPaths, draftContents, applyDrafts, workingDrafts } = useDraftStore({ root, onSelectPath, onComparisonChange })

  const onScreen = sessionOnScreen(session, comparison, selectedPath, workspaceView)
  if (onScreen.ended) setSession(null)
  const { activeSession, diskState } = onScreen
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
  const { editorRef, pendingCaretRef, attachedPathsRef, attachEditor, getEditor } = useEditorAttachment(sessionRef, draftContents)

  const sessionComparison = useSessionComparison(activeSession, draftContents)

  const renderedComparison = activeSession == null ? readableComparison(comparison) : sessionComparison
  const { canRequestEdit, unavailableReason } = editAvailability(comparison, selectedPath, workspaceView, repositoryReview)


  const updateDraftFile = useCallback((file: FileContents) => {
    const current = sessionRef.current
    if (current == null || current.path !== file.name) return
    // Keyed by the disk revision the text is typed against — after a save that
    // is the saved file, not the one the session opened on, or leaving and
    // coming back would find the draft stale and drop it.
    draftContents.set(current.path, {
      baseCacheKey: current.sourceCacheKey,
      contents: file.contents
    })
    typedRenderKeys.add(current.renderKey)
    const dirty = file.contents !== current.sourceContents
    setSession((previous) => withDirty(previous, current.path, dirty))
    applyDrafts((previous) => dirty
      ? putDraft(previous, {
        path: current.path,
        sourceCacheKey: current.sourceCacheKey,
        contents: file.contents,
        savedAt: Date.now()
      })
      : removeDraft(previous, current.path))
  }, [applyDrafts, draftContents])

  // Editing starts where the reader clicks: nothing about reading a file — its
  // render, its fold state, the editor module — changes until then.
  const startEditing = useCallback(async (position?: EditCaretPosition) => {
    if (!canRequestEdit || comparison == null || session?.path === comparison.path) return
    pendingCaretRef.current = position ?? null
    try {
      await preloadDiffEditor()
      const nextSession = createSession(comparison, draftContents.get(comparison.path))
      if (nextSession != null) setSession((current) => current ?? nextSession)
    } catch (error) {
      onError(getErrorMessage(error))
    }
  }, [canRequestEdit, comparison, draftContents, onError, pendingCaretRef, session])

  // A file that still has a draft opens straight into it, so the unsaved text is
  // what is on screen rather than the disk copy behind a button.
  const resumesDraft = session == null && canRequestEdit && hasDraftToResume(comparison, draftContents)
  useEffect(() => {
    if (resumesDraft) void startEditing()
  }, [resumesDraft, startEditing])

  useEffect(() => {
    if (activeSession == null) editorRef.current = null
  }, [activeSession, editorRef])

  const { saving, revert, save, handleEditorBlur, keepDraft, reloadFromDisk } = useSessionCommands({
    active: activeSession != null,
    sessionRef,
    conflictRef,
    editorRef,
    attachedPathsRef,
    draftContents,
    applyDrafts,
    setSession,
    autosaveOnBlur,
    onComparisonChange,
    onError
  })

  const controls = useMemo<FileEditControls>(() => ({
    available: canRequestEdit || activeSession != null,
    unavailableReason: canRequestEdit || activeSession != null ? null : unavailableReason,
    mode: activeSession == null ? 'read' : 'edit',
    documentView,
    dirty: activeSession?.dirty ?? false,
    saving,
    unsavedPaths: dirtyPaths,
    onStart: (position) => { void startEditing(position) },
    onDocumentViewChange: setDocumentView,
    onRevert: revert,
    onSave: () => { void save() },
    onOpenPath: onSelectPath
  }), [activeSession, canRequestEdit, dirtyPaths, documentView, onSelectPath, revert, save, saving,
    startEditing, unavailableReason])

  return {
    hasSession: session != null,
    workingDrafts,
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
