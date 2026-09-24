import { COLLAPSED_SEPARATOR_CSS } from './collapsedSeparator'
import { COPY_FILE_PATH_CSS } from './copyFilePath'
import { DRAG_SELECTION_CSS } from './dragSelection'
import { SPLIT_DIFF_RESIZE_CSS } from './splitDiffResize'
import { REVIEW_CARET_CSS } from '../review/reviewCaret'

/**
 * A document stylesheet cannot match inside a shadow root, so styles.css's
 * reduced-motion block never reached the two surfaces a keyboard user spends the
 * whole session in. Degrading identically inside and outside the viewer means the
 * scale drops and the background tint stays as the confirmation.
 */
export const IMAGE_DIFF_PREVIEW_CSS = `
  .image-diff-preview {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: start;
    gap: 16px;
    padding: 16px 18px 24px;
  }

  .image-diff-preview.is-compare {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .image-diff-side {
    margin: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .image-diff-side figcaption {
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-strong);
  }

  .image-diff-side img {
    max-width: 100%;
    max-height: min(70vh, 720px);
    height: auto;
    object-fit: contain;
    border: 1px solid var(--border);
    border-radius: var(--corner-card);
    corner-shape: squircle;
    background:
      linear-gradient(45deg, var(--panel-subtle) 25%, transparent 25%) 0 0 / 12px 12px,
      linear-gradient(-45deg, var(--panel-subtle) 25%, transparent 25%) 0 6px / 12px 12px,
      var(--canvas);
  }
`

/**
 * The review-surface markdown preview renders inside the file item's shadow
 * root, so none of GitHubMarkdownRenderer.css reaches it. These rules are the
 * standalone preview's typography retuned for an inline card: left-aligned,
 * slightly denser, and scoped to a different class so the two never collide.
 */
export const MARKDOWN_REVIEW_PREVIEW_CSS = `
  .markdown-review-preview {
    padding: 10px 20px 26px;
    color: var(--text);
    font-family: var(--font-ui);
    font-size: var(--text-lg);
    line-height: 1.7;
  }

  .markdown-review-partial {
    margin: 0 0 14px;
    color: var(--muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-strong);
    letter-spacing: var(--track-caps-9);
    text-transform: uppercase;
  }

  .markdown-review-body {
    max-width: 72ch;
    overflow-wrap: anywhere;
  }
  .markdown-review-body > * + * { margin-top: 0.85em; }
  .markdown-review-body > :first-child { margin-top: 0; }
  .markdown-review-body > :last-child { margin-bottom: 0; }
  .markdown-review-body h1, .markdown-review-body h2, .markdown-review-body h3,
  .markdown-review-body h4, .markdown-review-body h5, .markdown-review-body h6 {
    color: var(--text);
    font-weight: var(--weight-strong);
    letter-spacing: -0.02em;
    line-height: 1.25;
    text-wrap: pretty;
  }
  .markdown-review-body h1 { font-size: var(--text-2xl); }
  .markdown-review-body h2 { font-size: var(--text-xl); }
  .markdown-review-body h3 { font-size: var(--text-lg); }
  .markdown-review-body h4, .markdown-review-body h5, .markdown-review-body h6 { font-size: var(--text-lg); }
  .markdown-review-body p { margin: 0; text-wrap: pretty; }
  .markdown-review-body ul, .markdown-review-body ol { margin: 0; padding-left: 1.4em; }
  .markdown-review-body li + li { margin-top: 0.3em; }
  .markdown-review-body strong { font-weight: var(--weight-bold); }
  .markdown-review-body a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  .markdown-review-body code {
    border-radius: var(--corner-inline);
    corner-shape: squircle;
    padding: 1px 5px;
    background: var(--control-recessed);
    font-family: var(--font-mono);
    font-size: 0.92em;
  }
  .markdown-review-body pre {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--corner-control);
    corner-shape: squircle;
    padding: 12px 14px;
    background: var(--control-recessed);
  }
  .markdown-review-body pre code { padding: 0; background: transparent; }
  .markdown-review-body blockquote {
    margin: 0;
    border-left: 2px solid var(--border-strong);
    padding-left: 12px;
    color: var(--muted);
  }
  .markdown-review-body hr { border: 0; border-top: 1px solid var(--border); }
  .markdown-review-body img { max-width: 100%; }
  .markdown-review-body table {
    width: max-content;
    min-width: 100%;
    max-width: 100%;
    display: block;
    overflow-x: auto;
    border-spacing: 0;
    border-collapse: collapse;
  }
  .markdown-review-body th, .markdown-review-body td {
    border: 1px solid var(--border);
    padding: 7px 10px;
    text-align: left;
    vertical-align: top;
  }
  .markdown-review-body th { background: var(--control-fill); font-weight: var(--weight-strong); }
  .markdown-review-body details { border: 1px solid var(--border); border-radius: var(--corner-control); corner-shape: squircle; }
  .markdown-review-body details > summary { padding: 8px 10px; cursor: pointer; font-weight: var(--weight-strong); }
  .markdown-review-body details[open] > summary { border-bottom: 1px solid var(--border); }
  .markdown-review-body details > :not(summary) { margin: 10px; }
  .markdown-review-body .github-markdown-fallback {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .markdown-review-body .markdown-video { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
  .markdown-review-body .markdown-video video { max-width: min(100%, 720px); border-radius: var(--corner-control); corner-shape: squircle; background: #000; }
  .markdown-review-body .markdown-video a { color: var(--muted); font-size: var(--text-xs); }
`

export const REDUCED_MOTION_CSS = `
  @media (prefers-reduced-motion: reduce) {
    button {
      transition-property: background-color, color, border-color !important;
      transition-duration: var(--duration-base) !important;
      transition-timing-function: ease !important;
    }

    button:active:not(:disabled) {
      scale: 1 !important;
      transform: none !important;
    }

    [data-collapse-chevron],
    [data-expand-button] {
      transition: none !important;
    }
  }
`

/**
 * Pierre injects annotations as a row after the line. A pointer on that row is
 * mapped to the previous line, then data-selected-line is copied onto this row
 * and the paired split column — the “section” on the left and right.
 * The row itself carries no padding: a floating child (the selection action
 * bar) must collapse it to zero height, or selecting a line pushes the diff
 * down. Cards that do earn a row inset themselves with `.review-annotation`.
 */
export const ANNOTATION_LAYOUT_CSS = `
  [data-annotation-content] {
    box-sizing: border-box;
  }

  [data-line-annotation][data-selected-line],
  [data-gutter-buffer="annotation"][data-selected-line] {
    --mix-selection-light: 100%;
    --mix-selection-dark: 100%;
    --diffs-selection-mix-target: var(--diffs-computed-decoration-bg);
    --diffs-computed-selected-line-bg: var(--diffs-computed-decoration-bg);
  }

  [data-line-annotation][data-hovered],
  [data-gutter-buffer="annotation"][data-hovered] {
    --diffs-computed-hovered-line-bg: var(--diffs-computed-decoration-bg);
  }
`

/**
 * Rules every diff shadow root needs. The single-file and multi-file viewers
 * used to carry their own near-identical copy and had already drifted (the
 * expand button was 24% in one and 22% in the other); both now take the absolute
 * --corner-compact token, because a percentage radius on a non-square button
 * resolves to stretched ellipses rather than a squircle.
 */
export const VIEWER_BASE_CSS = `
  /* The document's universal rule stops at the shadow boundary, so every corner
     the viewer actually rounds is named here. The list is explicit rather than a
     bare \`*\`: matching it against each token span and line of every virtual
     window was measurable, and only these carry a radius. Word-level diff spans
     are on the list — they round 3px and read as chips, so a round corner there
     is the one place the shape visibly breaks rank inside a diff. */
  button,
  [data-expand-button],
  [data-utility-button],
  [data-separator-wrapper],
  [data-separator-content],
  [data-selection-action],
  [data-diff-span],
  [data-code]::-webkit-scrollbar-thumb,
  /* The editor appends its own stylesheet into this same shadow root, so its
     find panel, its inputs and the corners of a selection box are ours to shape
     too — they round 9, 6 and 3px otherwise. */
  [data-editor-widget],
  [data-input-box] input,
  [data-rtl], [data-rtr], [data-rbl], [data-rbr] {
    corner-shape: squircle;
  }

  /* Custom properties cross the shadow boundary, so the curve is the app's one
     curve rather than a fourth copy of the literal that drifts when it is retuned.
     Same press model as the light DOM: lands on pointer-down, eases on release,
     and rides the standalone scale property so a library transform cannot take
     the slot. */
  button {
    touch-action: manipulation;
    transition: scale var(--duration-fast) var(--ease-out), background-color var(--duration-fast) var(--ease-out);
  }

  button:active:not(:disabled) {
    scale: 0.96;
    transition-duration: 0s, var(--duration-fast);
  }

  [data-separator="line-info-basic"] {
    border-block: 1px solid var(--border);
    background: var(--control-fill);
  }

  /* The gutter utility lives inside the number cell. Pierre's default slot is
     a zero-width box on the cell's right edge whose 1lh button hangs left into
     the 2ch padding lane via negative margin — and covers the digits on wide
     numbers. The lane is instead widened into a real utility lane and the slot
     becomes the lane itself: pinned to the cell's left edge, button parked at
     its right end so it sits beside the digits the way Pierre's button does,
     at any digit width. The lane keeps clear of the number text, so digits
     stay uncovered and selectable. */
  [data-column-number] {
    padding-left: 26px;
  }

  [data-gutter-utility-slot] {
    left: 0;
    right: auto;
    width: 26px;
    box-sizing: border-box;
    padding-right: 4px;
    justify-content: flex-end;
    align-items: center;
  }

  /* A percentage radius resolves horizontally against width and vertically
     against height, so on this non-square button it drew stretched ellipses
     rather than a squircle. */
  [data-expand-button] {
    border-radius: var(--corner-compact) !important;
    corner-shape: squircle !important;
  }

  [data-expand-button]:hover {
    background: var(--accent-soft);
    color: var(--path-text);
  }

  ${DRAG_SELECTION_CSS}
  ${COLLAPSED_SEPARATOR_CSS}
  ${SPLIT_DIFF_RESIZE_CSS}
  ${COPY_FILE_PATH_CSS}
  ${REVIEW_CARET_CSS}
  ${IMAGE_DIFF_PREVIEW_CSS}
  ${ANNOTATION_LAYOUT_CSS}
  ${REDUCED_MOTION_CSS}
`

/** Styles the popover the editor renders for a ranged selection. */
export const SELECTION_ACTION_CSS = `
  [data-selection-action] {
    display: flex;
    gap: 4px;
    padding: 4px;
    border: 0;
    border-radius: var(--corner-control);
    background: var(--floating-surface);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 8%, transparent);
  }

  /* Concentric: the shell's radius minus its 4px inset. */
  [data-selection-action] button {
    border: 0;
    border-radius: calc(var(--corner-control) - 4px);
    padding: 6px 10px;
    background: transparent;
    color: var(--text-secondary);
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  [data-selection-action] button:first-child {
    background: var(--accent-soft);
    color: var(--path-text);
  }

  [data-selection-action] button:hover {
    background: var(--control-fill-hover);
    color: var(--text);
  }

  [data-selection-action] button:active:not(:disabled) {
    scale: 0.96;
  }
`
