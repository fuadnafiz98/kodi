export const COLLAPSED_SEPARATOR_CSS = `
  ${/* Pierre mounts the same separator in the gutter and the content column, then
     hides the content copy. The expand chevrons stay in the gutter, right under
     the line numbers they open, as GitHub draws them: in the content column they
     sat a track past the numbers, ~25 px from what they expand. The label belongs
     in the content column, which is always a real track, so the gutter copy keeps
     only its buttons and the content copy only its label. */ ''}

  [data-separator="line-info-basic"] {
    border-block: 0;
    background: transparent;
  }

  [data-gutter] [data-separator="line-info-basic"] [data-separator-wrapper] {
    display: flex;
    justify-content: flex-end;
    width: auto;
    height: 100%;
    background: inherit;
  }

  [data-gutter] [data-separator="line-info-basic"] [data-separator-content],
  [data-content] [data-separator="line-info-basic"] [data-expand-button] {
    display: none;
  }

  ${/* One row: a separator with both chevrons is two half-height rows in the
     library, which lifted the count above the chevrons beside it. */ ''}
  [data-content] [data-separator="line-info-basic"] [data-separator-wrapper] {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr);
    width: auto;
    inset-inline: 0;
    background: inherit;
  }

  [data-content] [data-separator="line-info-basic"] [data-separator-content] {
    grid-row: 1;
    grid-column: 1 / -1;
  }

  ${/* A collapsed run of lines reads as a seam in the file: the count, then a
     hairline across the code.

     The count used to be centred, which only ever worked on a file whose longest
     line was narrower than the pane. This column is the scrolled code column, so
     its width is the longest line's — on anything wider the centre is hundreds of
     pixels past the right edge and the reader saw a hairline running off the pane
     with no count on it. Leading with the count puts it where the eye already is,
     next to the expand controls, at any line length. */ ''}
  [data-separator="line-info-basic"] [data-separator-content] {
    min-width: 0;
    width: 100%;
    justify-content: flex-start;
    gap: 8px;
    padding-inline: 4px 12px;
    background: inherit;
  }

  [data-separator="line-info-basic"] [data-separator-content]::after {
    content: "";
    flex: 1 1 0;
    min-width: 0;
    height: 1px;
    background: color-mix(in srgb, var(--border) 72%, transparent);
  }

  [data-separator="line-info-basic"] [data-unmodified-lines] {
    flex: 0 1 auto;
    max-width: 46ch;
    border: 0;
    border-radius: 0;
    padding-inline: 4px;
    background: transparent;
    color: var(--faint);
    font-family: var(--font-ui);
    font-size: 10.5px;
    font-weight: 570;
    line-height: 16px;
    font-variant-numeric: tabular-nums;
  }

  ${/* Split mounts the same hunk in both panes. One count and one set of controls;
     the new pane keeps the hairline so the row still reads across the divider. */ ''}
  [data-diff-type="split"] [data-additions] [data-unmodified-lines],
  [data-diff-type="split"] [data-additions] [data-separator="line-info-basic"] [data-expand-button] {
    display: none;
  }

  [data-separator="line-info-basic"]:hover [data-unmodified-lines] {
    color: var(--text-secondary);
  }

  [data-separator="line-info-basic"] [data-expand-all-button] {
    display: none;
  }

  ${/* The library hides its "Expand all" word (a click on the count expands
     the run); matching every expand button here showed it in the gutter, where
     it spilled over the code and onto the count. */ ''}
  [data-gutter] [data-separator="line-info-basic"] [data-expand-button]:not([data-expand-all-button]) {
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    min-width: 28px;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
  }

  [data-gutter] [data-separator="line-info-basic"] [data-expand-button]::before {
    content: "";
    position: absolute;
    inset: 2px;
    border-radius: var(--corner-compact);
    corner-shape: squircle;
    background: transparent;
    pointer-events: none;
  }

  [data-gutter] [data-separator="line-info-basic"] [data-expand-button]:hover {
    background: transparent;
    color: var(--text);
  }

  [data-gutter] [data-separator="line-info-basic"] [data-expand-button]:hover::before {
    background: var(--control-fill-hover);
  }

  [data-gutter] [data-separator="line-info-basic"] [data-expand-button] [data-icon] {
    position: relative;
    width: 14px;
    height: 14px;
  }

`
