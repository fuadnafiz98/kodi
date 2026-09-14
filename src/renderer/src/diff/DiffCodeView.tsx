import { useMemo, type CSSProperties } from 'react'
import type { DiffLineAnnotation, LineAnnotation, SelectedLineRange } from '@pierre/diffs'
import { File, MultiFileDiff, Virtualizer } from '@pierre/diffs/react'

import type { FileComparison } from '../../../shared/contracts'
import type { DiffStyle } from '../app/AppView'
import { LIVE_CODE_FONT_SIZE_PROPERTY, LIVE_CODE_LINE_HEIGHT_PROPERTY } from './codeZoom'
import { reportCopiedPath, syncCopyFilePathLifecycle } from './copyFilePath'
import { syncDragGuideLifecycle } from './dragSelection'
import { syncSplitDiffResizeLifecycle } from './splitDiffResize'
import { syncReviewCaretLifecycle } from '../review/reviewCaret'
import { SELECTION_ACTION_CSS, VIEWER_BASE_CSS } from './viewerCss'
import { CODE_FONTS, getEditorThemeType, INTERFACE_FONTS, type AppPreferences } from '../settings/preferences'
import type { ReviewAnnotationMetadata } from '../review/ReviewComments'
import { VirtualizedBackToTop } from './VirtualizedBackToTop'

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
  ${SELECTION_ACTION_CSS}

  /* The polygon this used to carry fitted |a|^n + |b|^n = 1 at n≈1.82 — flatter
     than a circle, i.e. a bevel, not a squircle — and clip-path clips the outline,
     so the button had no visible keyboard focus. corner-shape in VIEWER_BASE_CSS
     draws the real thing and leaves the ring alone. */
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
}

/** The code itself: one file while editing, a diff otherwise. */
export function DiffCodeView({
  comparison,
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
  setReviewCursor
}: DiffCodeViewProps): React.JSX.Element {
  const codeStyle = useMemo(() => ({
    '--diffs-font-family': CODE_FONTS[preferences.codeFont].fontFamily,
    '--diffs-header-font-family': INTERFACE_FONTS[preferences.interfaceFont].fontFamily,
    '--diffs-font-size': `var(${LIVE_CODE_FONT_SIZE_PROPERTY}, ${preferences.codeFontSize}px)`,
    '--diffs-line-height': `var(${LIVE_CODE_LINE_HEIGHT_PROPERTY}, ${preferences.codeLineHeight}px)`,
    '--diffs-font-features': '"calt" 1, "liga" 1'
  }) as CSSProperties, [preferences])

  const interactionOptions = useMemo(() => ({
    enableLineSelection: DIFF_OPTIONS.enableLineSelection,
    enableGutterUtility: DIFF_OPTIONS.enableGutterUtility,
    lineHoverHighlight: DIFF_OPTIONS.lineHoverHighlight,
    onLineSelectionEnd: (range: SelectedLineRange | null) => {
      if (range == null) {
        setReviewCursor({ path: comparisonPath, selectedLines: null, draftRange: null })
        return
      }
      beginComment(range)
    },
    onGutterUtilityClick: beginComment,
    onPostRender: (node: HTMLElement, _instance: unknown, phase: string) => {
      syncDragGuideLifecycle(node, phase, beginComment)
      syncSplitDiffResizeLifecycle(node, phase)
      syncCopyFilePathLifecycle(node, phase, reportCopiedPath)
      syncReviewCaretLifecycle(node, phase)
    }
  }), [beginComment, comparisonPath, setReviewCursor])

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
    // Folded context is unreachable text: while editing, every line has to be
    // there to be typed in. The fold preference comes back on exit.
    expandUnchanged: editing || !preferences.foldUnchanged,
    collapsedContextThreshold: 4,
    unsafeCSS: INTERACTION_CSS
  }), [diffStyle, editing, interactionOptions, preferences.editorTheme, preferences.foldUnchanged,
    preferences.showLineNumbers, preferences.wordWrap])

  if (comparison.mode === 'file' && comparison.newFile != null) {
    return (
      <Virtualizer className="diff-scroll editor-scroll" contentClassName="diff-content editor-content">
        <File<ReviewAnnotationMetadata>
          file={comparison.newFile}
          edit={editing}
          editorOptions={editorOptions}
          options={fileOptions}
          selectedLines={selectedLines}
          lineAnnotations={fileAnnotations}
          renderAnnotation={renderFileAnnotation}
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
    className: 'pierre-diff',
    style: codeStyle
  }
  const diff = comparison.oldFile != null && comparison.newFile != null
    ? <MultiFileDiff<ReviewAnnotationMetadata> oldFile={comparison.oldFile} newFile={comparison.newFile} {...sharedDiffProps} />
    : comparison.oldFile != null
      ? <MultiFileDiff<ReviewAnnotationMetadata> oldFile={comparison.oldFile} newFile={null} {...sharedDiffProps} />
      : <MultiFileDiff<ReviewAnnotationMetadata> oldFile={null} newFile={comparison.newFile!} {...sharedDiffProps} />
  return <Virtualizer className="diff-scroll" contentClassName="diff-content">{diff}<VirtualizedBackToTop /></Virtualizer>
}
