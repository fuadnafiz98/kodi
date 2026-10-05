import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { CodeViewItem, FileContents, FileDiffMetadata } from '@pierre/diffs'
import type { CodeViewHandle } from '@pierre/diffs/react'
import type { Editor, EditorOptions } from '@pierre/diffs/edit'

import type { EditCaretPosition } from '../app/AppView'
import { preloadDiffEditor, type WorkingDrafts } from '../diff/useFileEditing'
import { deepActiveElement } from '../settings/keybindings'
import type { ReviewAnnotationMetadata } from './ReviewComments'
import { pathFromReviewItemId } from './reviewItems'

// The working tree's review edits in place: a click on a line of the new side
// turns that one file into an editor, where it sits, with the caret where the
// click landed. Reading costs nothing new — no editor, no whole file, no module
// — until that click.

export type ReviewItem = CodeViewItem<ReviewAnnotationMetadata>
type ReviewDiffItem = Extract<ReviewItem, { type: 'diff' }>

export interface ReviewEdit {
  /** The whole-file diff the editor types into; pinned for the session. */
  fileDiff: FileDiffMetadata
  /** The disk revision a save asserts, and the text that counts as clean. */
  sourceCacheKey: string
  sourceContents: string
  dirty: boolean
  saving: boolean
}

export type ReviewEdits = ReadonlyMap<string, ReviewEdit>

export interface ReviewEditing {
  edits: ReviewEdits
  /** For CodeView: undefined outside the working tree, which is never edited. */
  editorOptions: Omit<EditorOptions<ReviewAnnotationMetadata>, 'onChange'> | undefined
  onItemEditChange(item: ReviewItem, file: FileContents): void
  /** Called from `onPostRender`, with where a click put the caret when one did. */
  handleRender(node: HTMLElement, instance: unknown, item: ReviewItem, phase: string): void
  place(item: ReviewItem, instance: unknown, position: EditCaretPosition): void
  save(path: string): void
  discard(path: string): void
}

const NO_EDITS: ReviewEdits = new Map()

type ReviewEditActions = typeof import('./reviewEditActions')
let loadedReviewEditActions: ReviewEditActions | null = null
let reviewEditActions: Promise<ReviewEditActions> | null = null

function loadReviewEditActions(): Promise<ReviewEditActions> {
  reviewEditActions ??= import('./reviewEditActions').then((module) => {
    loadedReviewEditActions = module
    return module
  })
  return reviewEditActions
}

/** The editor and what drives it in a review, fetched as the pointer arrives over one. */
export function preloadReviewEditing(): Promise<unknown> {
  return Promise.all([preloadDiffEditor(), loadReviewEditActions()])
}

/** What the lazily loaded actions work on: the hook's refs and setters. */
export interface ReviewEditContext {
  workingDrafts: WorkingDrafts
  viewerRef: RefObject<CodeViewHandle<ReviewAnnotationMetadata> | null>
  editsRef: RefObject<ReviewEdits>
  latestTextRef: RefObject<Map<string, string>>
  pendingCaretRef: RefObject<{ path: string; position: EditCaretPosition } | null>
  startingRef: RefObject<Set<string>>
  activePathRef: RefObject<string | null>
  setEdits: Dispatch<SetStateAction<ReviewEdits>>
  onError(message: string | null): void
}

/** Old text, a rename without changes, a picture or a rendered preview is not typed into. */
export function isEditableReviewItem(item: ReviewItem): item is ReviewDiffItem {
  if (item.type !== 'diff' || item.collapsed === true) return false
  const { fileDiff } = item
  if (fileDiff.type === 'deleted' || fileDiff.hunks.length === 0) return false
  const annotations = (item as { annotations?: ReadonlyArray<{ metadata?: ReviewAnnotationMetadata }> }).annotations
  return !(annotations ?? []).some(({ metadata }) => metadata?.kind === 'image' || metadata?.kind === 'markdown')
}


// Every overlay gets a version no annotated item can have (those count up from
// 1), because the viewer keeps an item whose version did not move.
let nextOverlayVersion = 1_000_000_000
const overlays = new WeakMap<ReviewItem, { fileDiff: FileDiffMetadata; item: ReviewItem }>()

/**
 * The items with every edited file swapped for its editable diff. Keyed on the
 * diff, not the edit, so a file turning dirty or saving never resends it: only
 * a new session — or a new base item, a comment say — does.
 */
export function applyReviewEdits(items: ReviewItem[], edits: ReviewEdits): ReviewItem[] {
  if (edits.size === 0) return items
  let changed = false
  const next = items.map((item) => {
    if (item.type !== 'diff') return item
    const edit = edits.get(pathFromReviewItemId(item.id))
    if (edit == null) return item
    changed = true
    const cached = overlays.get(item)
    if (cached?.fileDiff === edit.fileDiff) return cached.item
    const overlaid = { ...item, fileDiff: edit.fileDiff, edit: true, version: nextOverlayVersion++ } as ReviewItem
    overlays.set(item, { fileDiff: edit.fileDiff, item: overlaid })
    return overlaid
  })
  return changed ? next : items
}

export function updateEdit(edits: ReviewEdits, path: string, change: Partial<ReviewEdit>): ReviewEdits {
  const current = edits.get(path)
  if (current == null) return edits
  const next = new Map(edits)
  next.set(path, { ...current, ...change })
  return next
}


// The host each item rendered into, so ⌘S can tell which file has focus.
const renderedHosts = new WeakMap<Node, string>()

function focusedReviewPath(): string | null {
  let element: Element | null = deepActiveElement(document)
  while (element != null) {
    const root = element.getRootNode()
    if (!(root instanceof ShadowRoot)) return null
    const path = renderedHosts.get(root.host)
    if (path != null) return path
    element = root.host
  }
  return null
}

export function useReviewEditing({
  enabled,
  paths,
  loading,
  workingDrafts,
  autosaveOnBlur,
  baseEditorOptions,
  viewerRef,
  onError
}: {
  enabled: boolean
  /** The files in the review: an edited one that leaves it lets its editor go. */
  paths: readonly string[]
  loading: boolean
  workingDrafts: WorkingDrafts | undefined
  autosaveOnBlur: boolean
  baseEditorOptions: EditorOptions<ReviewAnnotationMetadata> | undefined
  viewerRef: RefObject<CodeViewHandle<ReviewAnnotationMetadata> | null>
  onError(message: string | null): void
}): ReviewEditing {
  const [storedEdits, setEdits] = useState<ReviewEdits>(NO_EDITS)
  const active = enabled && workingDrafts != null
  // Only the working tree is edited. Leaving it lets every editor go — drafts
  // are in the store, and a file that has one comes back into it on its return.
  if (!active && storedEdits.size > 0) setEdits(NO_EDITS)
  // Likewise a file that stopped differing — saved back to HEAD, reverted
  // elsewhere — is no longer in the review, and neither is its editor.
  if (active && storedEdits.size > 0 && !loading) {
    const present = new Set(paths)
    if ([...storedEdits.keys()].some((path) => !present.has(path))) {
      setEdits(new Map([...storedEdits].filter(([path]) => present.has(path))))
    }
  }
  const edits = active ? storedEdits : NO_EDITS

  const editsRef = useRef(edits)
  const latestTextRef = useRef(new Map<string, string>())
  const pendingCaretRef = useRef<{ path: string; position: EditCaretPosition } | null>(null)
  const startingRef = useRef(new Set<string>())
  const activePathRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    editsRef.current = edits
  }, [edits])

  // Everything that runs once a file starts being edited lives with the editor
  // module and arrives with it, as the pointer comes over the review.
  const contextRef = useRef<ReviewEditContext | null>(null)
  useLayoutEffect(() => {
    contextRef.current = workingDrafts == null ? null : {
      workingDrafts, viewerRef, editsRef, latestTextRef, pendingCaretRef, startingRef, activePathRef, setEdits, onError
    }
  }, [onError, viewerRef, workingDrafts])
  const start = useCallback(async (item: ReviewItem, instance: unknown, position: EditCaretPosition | null) => {
    if (!active || !isEditableReviewItem(item)) return
    const actions = await loadReviewEditActions()
    if (contextRef.current != null) await actions.startReviewEdit(contextRef.current, item, instance, position)
  }, [active])

  const onItemEditChange = useCallback((item: ReviewItem, file: FileContents) => {
    const path = pathFromReviewItemId(item.id)
    const edit = editsRef.current.get(path)
    if (edit == null || workingDrafts == null) return
    activePathRef.current = path
    latestTextRef.current.set(path, file.contents)
    workingDrafts.put(path, edit.sourceCacheKey, edit.sourceContents, file.contents)
    const dirty = file.contents !== edit.sourceContents
    if (dirty !== edit.dirty) setEdits((current) => updateEdit(current, path, { dirty }))
  }, [workingDrafts])

  const save = useCallback(async (path: string) => {
    const actions = await loadReviewEditActions()
    if (contextRef.current != null) await actions.saveReviewEdit(contextRef.current, path)
  }, [])

  // Back to the disk copy through the editor, so ⌘Z brings the draft back.
  const discard = useCallback((path: string) => {
    if (contextRef.current != null) loadedReviewEditActions?.discardReviewEdit(contextRef.current, path)
  }, [])

  const handleAttach = useCallback((editor: Editor<ReviewAnnotationMetadata>) => {
    if (contextRef.current != null) loadedReviewEditActions?.focusReviewEditor(contextRef.current, editor)
  }, [])

  const handleBlur = useCallback(() => {
    const path = activePathRef.current
    if (!autosaveOnBlur || path == null) return
    void save(path)
  }, [autosaveOnBlur, save])

  const editorOptions = useMemo(() => {
    if (!active || baseEditorOptions == null) return undefined
    // Each item's editor routes its own changes (CodeView supplies onChange); the
    // shared options' handlers belong to the single-file surface.
    const { onChange: _singleFileChange, ...shared } = baseEditorOptions
    return {
      ...shared,
      // A review editor lives for one visit to one file, and its draft is kept
      // by the draft store. Persisted state would put back a scroll saved for
      // the single-file viewer — asynchronously, as IndexedDB answered — and
      // that threw the list to another offset just after the click.
      persistState: false,
      persistStateStorage: undefined,
      // The review has its own selection bar; the editor's would be a second one.
      enabledSelectionAction: false,
      onAttach: handleAttach,
      onBlur: handleBlur
    }
  }, [active, baseEditorOptions, handleAttach, handleBlur])

  const handleRender = useCallback((node: HTMLElement, instance: unknown, item: ReviewItem, phase: string) => {
    if (phase === 'unmount') {
      renderedHosts.delete(node)
      return
    }
    if (!active) return
    const path = pathFromReviewItemId(item.id)
    renderedHosts.set(node, path)
    // A file left with a draft opens back into it as it scrolls into view.
    if (phase === 'mount' && workingDrafts?.has(path) === true) void start(item, instance, null)
  }, [active, start, workingDrafts])

  const place = useCallback((item: ReviewItem, instance: unknown, position: EditCaretPosition) => {
    void start(item, instance, position)
  }, [start])

  const hasEdits = edits.size > 0
  useEffect(() => {
    if (!hasEdits) return
    return window.repository?.onDidChange((change) => {
      const paths = change.invalidateAll === true
        ? [...editsRef.current.keys()]
        : change.changedPaths.filter((path) => editsRef.current.has(path))
      const context = contextRef.current
      if (paths.length > 0 && context != null) void loadedReviewEditActions?.adoptOutsideWrites(context, paths)
    })
  }, [hasEdits])
  useEffect(() => {
    if (!hasEdits) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 's' || !(event.metaKey || event.ctrlKey)) return
      const path = focusedReviewPath() ?? activePathRef.current
      if (path == null || !editsRef.current.has(path)) return
      event.preventDefault()
      void save(path)
    }
    window.addEventListener('keydown', handleKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [hasEdits, save])

  return useMemo(() => ({
    edits,
    editorOptions,
    onItemEditChange,
    handleRender,
    place,
    save: (path: string) => { void save(path) },
    discard
  }), [discard, editorOptions, edits, handleRender, onItemEditChange, place, save])
}
