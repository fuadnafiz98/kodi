import { useCallback, useMemo, type CSSProperties } from 'react'
import type { DiffLineAnnotation, LineAnnotation, SelectedLineRange } from '@pierre/diffs'
import { File, MultiFileDiff, Virtualizer } from '@pierre/diffs/react'

import type { FileComparison } from '../../../shared/contracts'
import type { DiffStyle } from '../app/AppView'
import { LIVE_CODE_FONT_SIZE_PROPERTY, LIVE_CODE_LINE_HEIGHT_PROPERTY } from './codeZoom'
import { reportCopiedPath, syncCopyFilePathLifecycle } from './copyFilePath'
import { GutterActions } from './GutterActions'
import { syncDragGuideLifecycle } from './dragSelection'
import { syncSplitDiffResizeLifecycle } from './splitDiffResize'
import { noteEditorLine } from '../review/editorTarget'
import { syncReviewCaretLifecycle, type PlaceEditCaret } from '../review/reviewCaret'
import { VIEWER_BASE_CSS } from './viewerCss'
import { CODE_FONTS, getEditorThemeType, INTERFACE_FONTS, type AppPreferences } from '../settings/preferences'
import type { ReviewAnnotationMetadata } from '../review/ReviewComments'
import { VirtualizedBackToTop } from './VirtualizedBackToTop'
import { useLineReveal } from './useLineReveal'
import { usePrimedComparison } from './usePrimedComparison'
import { noteFirstScreenRender } from '../app/firstScreen'

const DIFF_OPTIONS = {
  diffIndicators: 'bars' as const,
  lineDiffType: 'word-alt' as const,
  stickyHeader: true,
  tokenizeMaxLineLength: 2_000,
  enableLineSelection: true,
  enableGutterUtility: true,
  lineHoverHighlight: 'number' as const
}
const INTERACTION_CSS = `
  ${VIEWER_BASE_CSS}

  ${/* The polygon this used to carry fitted |a|^n + |b|^n = 1 at n≈1.82 — flatter
     than a circle, i.e. a bevel, not a squircle — and clip-path clips the outline,
     so the button had no visible keyboard focus. corner-shape in VIEWER_BASE_CSS
     draws the real thing and leaves the ring alone. */ ''}
  button[data-expand-button][data-expand-button] {
    cursor: pointer;
    color: var(--text-secondary);
  }

  [data-separator-wrapper] {
    min-height: 30px;
  }

  [data-unmodified-lines] {
    color: var(--muted);
    font-family: var(--diffs-header-font-family);
    font-size: 11px;
  }
`

type ReviewCursor = {
  path: string | undefined
  selectedLines: SelectedLineRange | null
  draftRange: SelectedLineRange | null
}

export interface DiffCodeViewProps {
  comparison: FileComparison
  comparisonPath: string | undefined
  editing: boolean
  diffStyle: DiffStyle
  preferences: AppPreferences
  editorOptions: React.ComponentProps<typeof File<ReviewAnnotationMetadata>>['editorOptions']
  selectedLines: SelectedLineRange | null
  fileAnnotations: LineAnnotation<ReviewAnnotationMetadata>[]
  diffAnnotations: DiffLineAnnotation<ReviewAnnotationMetadata>[]
  renderFileAnnotation(annotation: LineAnnotation<ReviewAnnotationMetadata>): React.ReactNode
  renderDiffAnnotation(annotation: DiffLineAnnotation<ReviewAnnotationMetadata>): React.ReactNode
  beginComment(range: SelectedLineRange): void
  setReviewCursor(cursor: ReviewCursor): void
  /** A click on the working file's text: where editing should start. */
  onPlaceEditCaret?: PlaceEditCaret
}

type HoveredLine = { lineNumber: number; side?: 'additions' | 'deletions' }

/** The code itself: one file while editing, a diff otherwise. */
export function DiffCodeView({
  comparison: incomingComparison,
  comparisonPath,
  editing,
  diffStyle,
  preferences,
  editorOptions,
  selectedLines,
  fileAnnotations,
  diffAnnotations,
  renderFileAnnotation,
  renderDiffAnnotation,
  beginComment,
  setReviewCursor,
  onPlaceEditCaret
}: DiffCodeViewProps): React.JSX.Element {
  const comparison = usePrimedComparison(incomingComparison, !editing && incomingComparison.mode === 'diff')
  const codeStyle = useMemo(() => ({
    '--diffs-font-family': CODE_FONTS[preferences.codeFont].fontFamily,
    '--diffs-header-font-family': INTERFACE_FONTS[preferences.interfaceFont].fontFamily,
    '--diffs-font-size': `var(${LIVE_CODE_FONT_SIZE_PROPERTY}, ${preferences.codeFontSize}px)`,
    '--diffs-line-height': `var(${LIVE_CODE_LINE_HEIGHT_PROPERTY}, ${preferences.codeLineHeight}px)`,
    '--diffs-font-features': '"calt" 1, "liga" 1'
  }) as CSSProperties, [preferences])

  // The custom gutter utility means the viewer's own utility click is gone —
  // renderGutterUtility and onGutterUtilityClick are mutually exclusive — so the
  // `+` answers for itself with the single-line range the library used to build.
  const commentOnHoveredLine = useCallback((hovered: HoveredLine | undefined) => {
    if (hovered == null) return
    // A press inside the lines already selected keeps that range — collapsing
    // the draft to the pressed line would throw the selection away.
    if (selectedLines != null) {
      const first = Math.min(selectedLines.start, selectedLines.end)
      const last = Math.max(selectedLines.start, selectedLines.end)
      const sideMatches = selectedLines.side == null
        || hovered.side == null
        || selectedLines.side === hovered.side
      if (hovered.lineNumber >= first && hovered.lineNumber <= last && sideMatches) {
        beginComment(selectedLines)
        return
      }
    }
    beginComment({
      start: hovered.lineNumber,
      end: hovered.lineNumber,
      ...(hovered.side != null ? { side: hovered.side } : {})
    })
  }, [beginComment, selectedLines])

  const selectRevealedLine = useCallback((path: string, range: SelectedLineRange) => {
    setReviewCursor({ path, selectedLines: range, draftRange: null })
  }, [setReviewCursor])
  const reportRender = useLineReveal(comparisonPath, comparison.mode === 'diff' ? 'additions' : undefined, selectRevealedLine)

  const interactionOptions = useMemo(() => ({
    enableLineSelection: DIFF_OPTIONS.enableLineSelection,
    enableGutterUtility: DIFF_OPTIONS.enableGutterUtility,
    lineHoverHighlight: DIFF_OPTIONS.lineHoverHighlight,
    onLineSelectionEnd: (range: SelectedLineRange | null) => {
      noteEditorLine(comparisonPath ?? null, range?.side === 'deletions' ? null : range?.start ?? null)
      if (range == null) {
        setReviewCursor({ path: comparisonPath, selectedLines: null, draftRange: null })
        return
      }
      beginComment(range)
    },
    onPostRender: (node: HTMLElement, instance: unknown, phase: string) => {
      syncDragGuideLifecycle(node, phase, beginComment)
      syncSplitDiffResizeLifecycle(node, phase)
      syncCopyFilePathLifecycle(node, phase, reportCopiedPath)
      syncReviewCaretLifecycle(node, phase, onPlaceEditCaret)
      reportRender(node, instance, phase)
      noteFirstScreenRender(instance, phase)
    }
  }), [beginComment, comparisonPath, onPlaceEditCaret, reportRender, setReviewCursor])

  // `theme` is deliberately absent: the worker pool resolves it and re-renders
  // every instance on a switch, so repeating it here only bought a second full
  // DOM rebuild through the wrapper's forceRender path. `themeType` stays —
  // it colours the chrome and is applied from cached CSS.
  const fileOptions = useMemo(() => ({
    themeType: getEditorThemeType(preferences.editorTheme),
    overflow: preferences.wordWrap ? 'wrap' as const : 'scroll' as const,
    stickyHeader: DIFF_OPTIONS.stickyHeader,
    tokenizeMaxLineLength: DIFF_OPTIONS.tokenizeMaxLineLength,
    disableFileHeader: true,
    disableLineNumbers: !preferences.showLineNumbers,
    unsafeCSS: INTERACTION_CSS,
    ...interactionOptions
  }), [interactionOptions, preferences.editorTheme, preferences.showLineNumbers, preferences.wordWrap])

  const diffOptions = useMemo(() => ({
    ...DIFF_OPTIONS,
    ...interactionOptions,
    themeType: getEditorThemeType(preferences.editorTheme),
    overflow: preferences.wordWrap ? 'wrap' as const : 'scroll' as const,
    disableLineNumbers: !preferences.showLineNumbers,
    diffStyle,
    hunkSeparators: 'line-info-basic' as const,
    // Editing keeps the reader's folds. Expanding every unchanged line the moment
    // a click started editing moved the line under the pointer; folded context
    // is still in the document, and its expand control still opens it.
    expandUnchanged: !preferences.foldUnchanged,
    collapsedContextThreshold: 4,
    unsafeCSS: INTERACTION_CSS
  }), [diffStyle, interactionOptions, preferences.editorTheme, preferences.foldUnchanged,
    preferences.showLineNumbers, preferences.wordWrap])

  if (comparison.mode === 'file' && comparison.newFile != null) {
    return (
      <Virtualizer className="diff-scroll editor-scroll" contentClassName="diff-content editor-content">
        <File<ReviewAnnotationMetadata>
          key={comparison.path}
          file={comparison.newFile}
          edit={editing}
          editorOptions={editorOptions}
          options={fileOptions}
          selectedLines={selectedLines}
          lineAnnotations={fileAnnotations}
          renderAnnotation={renderFileAnnotation}
          renderGutterUtility={(getHoveredLine) => (
            <GutterActions onComment={() => commentOnHoveredLine(getHoveredLine())} />
          )}
          className="pierre-diff editor-file"
          style={codeStyle}
        />
        <VirtualizedBackToTop />
      </Virtualizer>
    )
  }

  const sharedDiffProps = {
    options: diffOptions,
    edit: editing,
    editorOptions,
    selectedLines,
    lineAnnotations: diffAnnotations,
    renderAnnotation: renderDiffAnnotation,
    renderGutterUtility: (getHoveredLine: () => HoveredLine | undefined) => (
      <GutterActions onComment={() => commentOnHoveredLine(getHoveredLine())} />
    ),
    className: 'pierre-diff',
    style: codeStyle
  }
  // Keyed on the path: Pierre's instance updates the body for another file but
  // kept the previous file's header — its name and line counts — so a ⌘P jump
  // read as having opened the wrong file. A save of the same file still updates
  // in place.
  const diff = comparison.oldFile != null && comparison.newFile != null
    ? <MultiFileDiff<ReviewAnnotationMetadata> key={comparison.path} oldFile={comparison.oldFile} newFile={comparison.newFile} {...sharedDiffProps} />
    : comparison.oldFile != null
      ? <MultiFileDiff<ReviewAnnotationMetadata> key={comparison.path} oldFile={comparison.oldFile} newFile={null} {...sharedDiffProps} />
      : <MultiFileDiff<ReviewAnnotationMetadata> key={comparison.path} oldFile={null} newFile={comparison.newFile!} {...sharedDiffProps} />
  return <Virtualizer className="diff-scroll" contentClassName="diff-content">{diff}<VirtualizedBackToTop /></Virtualizer>
}
