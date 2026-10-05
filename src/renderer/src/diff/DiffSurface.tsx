import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { DiffLineAnnotation, FileContents, LineAnnotation, SelectedLineRange } from '@pierre/diffs'
import type { Editor } from '@pierre/diffs/edit'
import type { FileComparison } from '../../../shared/contracts'
import { isMarkdownPath } from '../../../shared/markdownPreview'
import { DiffCodeView } from './DiffCodeView'
import { DiffStateScreen } from './DiffStateScreen'
import { diffSurfaceState } from './diffSurfaceState'
import { MarkdownFilePreview } from '../markdown/MarkdownFilePreview'
import { createDraftTextChannel } from '../markdown/draftTextChannel'
import { createLazyModule, useLazyModule } from '../app/lazyModule'
import { markdownPreviewSource, markdownSurface, type DocumentView } from '../review/documentView'
import { MarkdownSplitResizer } from '../markdown/MarkdownSplitResizer'
import type { AgentSelection } from '../agent/agentAttachments'
import type { DiffStyle, EditCaretPosition } from '../app/AppView'
import { createSelectionBar, preloadDiffEditor } from './useFileEditing'
import { contentSearchMarkers, markersEqual, type EditorMarker } from '../editor/markers'
import { useSearchResults } from '../palette/searchResultsStore'
import {
  selectionLineRange,
  type SelectionActionContext
} from '../editor/selectionAction'
import { useViewerContext, type EditorAnnotations } from '../editor/ViewerProviders'
import { createDiffAnnotation, createFileAnnotation, selectedRangeLastLine } from '../review/reviewAnnotations'
import { copyCodeReference, copyReviewComment } from '../review/codeReferenceClipboard'
import type { AppPreferences } from '../settings/preferences'
import {
  AnnotationFrame,
  DraftComment,
  ReviewThreadCard,
  type ReviewAnnotationMetadata,
  type ReviewThread
} from '../review/ReviewComments'
import { markRendererStartup } from '../app/startupMetrics'
import { showToast } from '../app/toast'
// Search results are published by the command palette, not threaded through the
// workspace: the tree and the viewer must not re-render while the reader types.

export interface DiffSurfaceProps {
  comparison: FileComparison | null
  loading: boolean
  diffStyle: DiffStyle
  preferences: AppPreferences
  editMode: 'read' | 'edit'
  documentView: DocumentView
  /** Present while the file can be edited and is not yet: a click in its text starts. */
  onStartEdit?(position: EditCaretPosition): void
  getEditor(): Editor<ReviewAnnotationMetadata> | null
  onDraftFileChange(file: FileContents): void
  onEditorAttach(editor: Editor<ReviewAnnotationMetadata>): void
  onEditorBlur(): void
  onAttachToAgent(selection: AgentSelection): void
  threadsByPath: Record<string, ReviewThread[]>
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>
}

// Identity is the viewer's change signal for annotations (syncLineAnnotations
// only bails when the array is the same object), so the empty case must not mint
// a new array per render.
const NO_THREADS: ReviewThread[] = []

type DiffContentsProps = Omit<DiffSurfaceProps, 'threadsByPath'> & { threads: ReviewThread[] }

/**
 * Owns the review-comment cursor for one file: which lines are selected, the
 * draft card, and the annotation collection handed to the viewer.
 */
function useReviewComments(
  comparison: FileComparison | null,
  threads: ReviewThread[],
  setThreadsByPath: Dispatch<SetStateAction<Record<string, ReviewThread[]>>>
) {
  const [reviewCursor, setReviewCursor] = useState<{
    path: string | undefined
    selectedLines: SelectedLineRange | null
    draftRange: SelectedLineRange | null
  }>({ path: undefined, selectedLines: null, draftRange: null })

  const comparisonPath = comparison?.path
  const selectedLines = reviewCursor.path === comparisonPath ? reviewCursor.selectedLines : null
  const draftRange = reviewCursor.path === comparisonPath ? reviewCursor.draftRange : null
  const beginComment = useCallback((range: SelectedLineRange) => {
    setReviewCursor({ path: comparisonPath, selectedLines: range, draftRange: range })
  }, [comparisonPath])

  const saveComment = useCallback((body: string) => {
    if (comparisonPath == null || draftRange == null) return
    const thread: ReviewThread = {
      id: crypto.randomUUID(),
      body,
      lineNumber: selectedRangeLastLine(draftRange),
      side: draftRange.side,
      range: draftRange,
      replies: [],
      resolved: false
    }
    setThreadsByPath((current) => ({
      ...current,
      [comparisonPath]: [...(current[comparisonPath] ?? []), thread]
    }))
    setReviewCursor({ path: comparisonPath, selectedLines: null, draftRange: null })
  }, [comparisonPath, draftRange, setThreadsByPath])

  const updateThread = useCallback((threadId: string, update: (thread: ReviewThread) => ReviewThread | null) => {
    if (comparisonPath == null) return
    setThreadsByPath((current) => ({
      ...current,
      [comparisonPath]: (current[comparisonPath] ?? []).flatMap((thread) => {
        if (thread.id !== threadId) return [thread]
        const nextThread = update(thread)
        return nextThread == null ? [] : [nextThread]
      })
    }))
  }, [comparisonPath, setThreadsByPath])

  const renderReviewAnnotation = useCallback((metadata: ReviewAnnotationMetadata): React.JSX.Element => {
    if (metadata.kind === 'draft') {
      return (
        <AnnotationFrame>
          <DraftComment
            range={metadata.range}
            onCancel={() => setReviewCursor({ path: comparisonPath, selectedLines: null, draftRange: null })}
            onSave={saveComment}
          />
        </AnnotationFrame>
      )
    }
    // The single-file view keeps its direct comment flow, so no selection action
    // bar is produced here; remote threads belong to the multi-file review, and
    // the markdown preview item is only ever minted there too.
    if (metadata.kind === 'remote' || metadata.kind === 'selection'
      || metadata.kind === 'image' || metadata.kind === 'markdown') {
      return <></>
    }
    const { thread } = metadata
    return (
      <AnnotationFrame>
        <ReviewThreadCard
          thread={thread}
          onCopy={() => {
            if (comparisonPath == null) return
            // Threads saved here carry no anchor text, so the comment's code comes
            // from the comparison it is being read against.
            void copyReviewComment(comparisonPath, thread, {
              additions: comparison?.newFile?.contents,
              deletions: comparison?.oldFile?.contents
            })
          }}
          onDelete={() => updateThread(thread.id, () => null)}
          onEdit={(body) => updateThread(thread.id, (current) => ({ ...current, body }))}
          onReply={(body) => updateThread(thread.id, (current) => ({
            ...current,
            replies: [...current.replies, { id: crypto.randomUUID(), body }]
          }))}
          onToggleResolved={() => updateThread(thread.id, (current) => ({ ...current, resolved: !current.resolved }))}
        />
      </AnnotationFrame>
    )
  }, [comparison, comparisonPath, saveComment, updateThread])

  const reviewMetadata = useMemo<ReviewAnnotationMetadata[]>(() => [
    ...threads.map((thread) => ({ kind: 'thread' as const, thread })),
    ...(draftRange == null ? [] : [{ kind: 'draft' as const, range: draftRange }])
  ], [draftRange, threads])

  const fileAnnotations = useMemo<LineAnnotation<ReviewAnnotationMetadata>[]>(
    () => reviewMetadata.map(createFileAnnotation),
    [reviewMetadata]
  )

  const diffAnnotations = useMemo<DiffLineAnnotation<ReviewAnnotationMetadata>[]>(
    () => reviewMetadata.map(createDiffAnnotation),
    [reviewMetadata]
  )

  return {
    selectedLines,
    beginComment,
    setReviewCursor,
    renderReviewAnnotation,
    fileAnnotations,
    diffAnnotations
  }
}

function DiffContents({
  comparison,
  loading,
  diffStyle,
  preferences,
  editMode,
  documentView,
  getEditor,
  onDraftFileChange,
  onEditorAttach,
  onEditorBlur,
  onStartEdit,
  onAttachToAgent,
  threads,
  setThreadsByPath
}: DiffContentsProps): React.JSX.Element {
  const viewer = useViewerContext()
  const comparisonPath = comparison?.path
  const {
    selectedLines,
    beginComment,
    setReviewCursor,
    renderReviewAnnotation,
    fileAnnotations,
    diffAnnotations
  } = useReviewComments(comparison, threads, setThreadsByPath)

  // The editor remaps annotation coordinates as the document changes and hands
  // back the whole authoritative collection. Ignoring it left comment cards on
  // the line numbers they had before the edit. The array identity only changes
  // on a structural edit, so ordinary typing costs nothing here, and the update
  // runs inside the editor's own discrete input event, so React commits it
  // before paint without flushSync.
  const publishRemappedAnnotations = useCallback((annotations: EditorAnnotations) => {
    if (annotations == null || comparisonPath == null) return
    const lineByThreadId = new Map<string, number>()
    for (const annotation of annotations) {
      const { metadata } = annotation
      if (metadata?.kind !== 'thread') continue
      lineByThreadId.set(metadata.thread.id, annotation.lineNumber)
    }
    if (lineByThreadId.size === 0) return
    setThreadsByPath((current) => {
      const threadsForPath = current[comparisonPath]
      if (threadsForPath == null) return current
      let changed = false
      const next = threadsForPath.map((thread) => {
        const lineNumber = lineByThreadId.get(thread.id)
        if (lineNumber == null || lineNumber === thread.lineNumber) return thread
        changed = true
        return { ...thread, lineNumber }
      })
      return changed ? { ...current, [comparisonPath]: next } : current
    })
  }, [comparisonPath, setThreadsByPath])

  const lastAnnotationsRef = useRef<EditorAnnotations>(undefined)
  const [draftChannel] = useState(createDraftTextChannel)
  const handleEditorChange = useCallback((file: FileContents, annotations: EditorAnnotations) => {
    onDraftFileChange(file)
    draftChannel.publish(file.contents)
    if (annotations === lastAnnotationsRef.current) return
    lastAnnotationsRef.current = annotations
    publishRemappedAnnotations(annotations)
  }, [draftChannel, onDraftFileChange, publishRemappedAnnotations])

  const askAgentAboutSelection = useCallback((context: SelectionActionContext) => {
    if (comparisonPath == null || comparison == null) return
    const { startLine, endLine } = selectionLineRange(context.selection)
    const selectedText = context.getSelectionText()
    if (selectedText === '') {
      showToast('Select code before adding it to the agent')
      return
    }
    const side = comparison.newFile == null ? 'deletions' : 'additions'
    const file = side === 'deletions' ? comparison.oldFile : comparison.newFile
    onAttachToAgent({
      path: comparisonPath,
      startLine,
      endLine,
      side,
      selectedText,
      blobOid: file?.cacheKey ?? null
    })
  }, [comparison, comparisonPath, onAttachToAgent])

  const commentOnSelection = useCallback((context: SelectionActionContext) => {
    const { startLine, endLine } = selectionLineRange(context.selection)
    beginComment({ start: startLine, end: endLine, side: 'additions' })
  }, [beginComment])

  const copySelection = useCallback((context: SelectionActionContext) => {
    if (comparisonPath == null) return
    const { startLine, endLine } = selectionLineRange(context.selection)
    void copyCodeReference(
      { path: comparisonPath, first: startLine, last: endLine, side: 'additions' },
      context.getSelectionText()
    )
  }, [comparisonPath])

  const renderSelectionAction = useCallback((context: SelectionActionContext) => (
    // The same three, in the same order, as the review's selection bar.
    createSelectionBar([
      { label: 'Copy selection with file path', tooltip: 'Copy with path', icon: 'copy', run: copySelection },
      { label: 'Add selection to Chat', tooltip: 'Add to Chat ⌘I', icon: 'chat', run: askAgentAboutSelection },
      { label: 'Comment', icon: 'comment', primary: true, run: commentOnSelection }
    ], context)
  ), [askAgentAboutSelection, commentOnSelection, copySelection])

  const setEditorHandlers = viewer?.setEditorHandlers
  useEffect(() => {
    if (setEditorHandlers == null) return
    setEditorHandlers({
      onAttach: onEditorAttach,
      onChange: handleEditorChange,
      onBlur: onEditorBlur,
      renderSelectionAction
    })
    return () => setEditorHandlers(null)
  }, [handleEditorChange, onEditorAttach, onEditorBlur, renderSelectionAction, setEditorHandlers])

  // Markers re-anchor themselves as the document changes, so they only have to
  // be pushed when the provider's own input changes.
  const activeSearch = useSearchResults()
  const searchMarkers = useMemo<EditorMarker[]>(
    () => comparisonPath == null
      ? []
      : contentSearchMarkers(activeSearch.results, comparisonPath, activeSearch.query),
    [activeSearch, comparisonPath]
  )
  const appliedMarkersRef = useRef<EditorMarker[]>([])
  useEffect(() => {
    if (editMode !== 'edit') return
    if (markersEqual(appliedMarkersRef.current, searchMarkers)) return
    // The editor attaches a frame after the surface renders, and setMarkers
    // throws before it has.
    const frame = window.requestAnimationFrame(() => {
      const editor = getEditor()
      if (editor == null) return
      appliedMarkersRef.current = searchMarkers
      editor.setMarkers(searchMarkers)
    })
    return () => window.cancelAnimationFrame(frame)
  }, [editMode, getEditor, searchMarkers])

  const renderFileAnnotation = useCallback(
    (annotation: LineAnnotation<ReviewAnnotationMetadata>) => renderReviewAnnotation(annotation.metadata),
    [renderReviewAnnotation]
  )
  const renderDiffAnnotation = useCallback(
    (annotation: DiffLineAnnotation<ReviewAnnotationMetadata>) => renderReviewAnnotation(annotation.metadata),
    [renderReviewAnnotation]
  )

  const editorOptions = viewer?.editorOptions
  const editing = editMode === 'edit'
  const liveMarkdown = useLazyModule(liveMarkdownModule,
    editing && documentView !== 'source' && comparison != null && isMarkdownPath(comparison.path))

  const state = diffSurfaceState(comparison, loading)
  if (state !== 'code' || comparison == null) {
    return <DiffStateScreen state={state} comparison={comparison} />
  }

  const surface = markdownSurface(comparison, editMode, documentView)
  const previewText = markdownPreviewSource(comparison)
  if (surface === 'preview' && previewText != null) {
    return <MarkdownFilePreview source={previewText} />
  }

  const codeView = (
    <DiffCodeView
      comparison={comparison}
      comparisonPath={comparisonPath}
      editing={editing}
      diffStyle={diffStyle}
      preferences={preferences}
      editorOptions={editorOptions}
      selectedLines={selectedLines}
      fileAnnotations={fileAnnotations}
      diffAnnotations={diffAnnotations}
      renderFileAnnotation={renderFileAnnotation}
      renderDiffAnnotation={renderDiffAnnotation}
      beginComment={beginComment}
      setReviewCursor={setReviewCursor}
      onPlaceEditCaret={onStartEdit}
    />
  )

  if (surface === 'split' && previewText != null) {
    return (
      <div className="markdown-split">
        <div className="markdown-split-source">{codeView}</div>
        <MarkdownSplitResizer />
        {editing && liveMarkdown != null
          ? <liveMarkdown.LiveMarkdownPreview source={previewText} channel={draftChannel} />
          : <MarkdownFilePreview source={previewText} />}
      </div>
    )
  }

  return codeView
}

// Only a markdown split being edited draws a live preview.
const liveMarkdownModule = createLazyModule(() => import('../markdown/LiveMarkdownPreview'))

const MemoizedDiffContents = memo(DiffContents)

function preloadEditorQuietly(): void {
  // A failed fetch surfaces again, with its message, on the click that needs it.
  preloadDiffEditor().catch(() => {})
}

const DiffSurface = memo(function DiffSurface({
  threadsByPath,
  ...props
}: DiffSurfaceProps): React.JSX.Element {
  useLayoutEffect(() => markRendererStartup('viewerCommitted'), [])
  const [staleComparison, setStaleComparison] = useState<FileComparison | null>(null)
  // Only a comparison that is actually on screen is worth remembering, and
  // gating on `loading` keeps a same-path update (a save, an external write)
  // from costing a second render pass.
  if (!props.loading && props.comparison != null && props.comparison !== staleComparison) {
    setStaleComparison(props.comparison)
  }
  // Keep the previous file rendered and dimmed while the next one loads, so
  // file-to-file navigation never flashes to a blank spinner. The host is always
  // rendered: returning two structurally different trees made React reconcile
  // them as different elements and tear the whole diff down every time a load
  // finished, which is also why the 120ms dim could never fade out.
  const dimming = props.loading && staleComparison != null
  const renderedComparison = dimming ? staleComparison : props.comparison
  // Resolved here rather than inside the memoized contents so a comment on
  // another file changes nothing this component hands down, and so the array
  // always belongs to the file that is actually on screen while dimming.
  const renderedPath = renderedComparison?.path
  const threads = (renderedPath == null ? undefined : threadsByPath[renderedPath]) ?? NO_THREADS
  // The editor module is ~1 MB of script: fetched as the pointer arrives over a
  // file it could edit, it is parsed by the time the click lands.
  return (
    <div className="diff-stale-host" onPointerEnter={props.onStartEdit == null ? undefined : preloadEditorQuietly}>
      {dimming ? <div className="diff-loading-bar" aria-hidden="true" /> : null}
      <div className="diff-stale" data-dim={dimming ? '' : undefined}>
        <MemoizedDiffContents
          {...props}
          threads={threads}
          comparison={renderedComparison}
          loading={dimming ? false : props.loading}
        />
      </div>
    </div>
  )
})

export default DiffSurface
