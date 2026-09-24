export const COLLAPSED_SEPARATOR_CSS = `
  /* Pierre mounts the same separator in the gutter and the content column, then
     hides the content copy. The label belongs in the content column, which is
     always a real track. */

  [data-separator="line-info-basic"] {
    border-block: 0;
    background: transparent;
  }

  [data-gutter] [data-separator="line-info-basic"] [data-separator-wrapper] {
    width: auto;
    background: inherit;
  }

  [data-gutter] [data-separator="line-info-basic"] [data-separator-content],
  [data-gutter] [data-separator="line-info-basic"] [data-expand-button] {
    display: none;
  }

  [data-content] [data-separator="line-info-basic"] [data-separator-wrapper] {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr);
    width: auto;
    inset-inline: 0;
    background: inherit;
  }

  [data-content] [data-separator="line-info-basic"] [data-separator-wrapper][data-separator-multi-button] {
    grid-template-columns: 28px 28px minmax(0, 1fr);
  }

  /* Pierre pins the label to column 2. With one button that is the code column;
     with two it is the second button's 28px track, so the count and the down
     chevron shared one cell — the count clipped to nothing and the seam
     hairlines drew across the chevron. The label belongs in the last track
     either way, and naming it beats auto-placement: a hidden button is not a
     grid item, so the label used to slide a track left in the pane that hides
     its controls. */
  [data-content] [data-separator="line-info-basic"] [data-separator-content] {
    grid-row: 1;
    grid-column: -2 / -1;
  }

  /* Nothing occupies the button tracks in the pane whose controls are hidden, so
     the seam runs the full width and the row reads across the divider. */
  [data-diff-type="split"] [data-additions] [data-content] [data-separator="line-info-basic"] [data-separator-content] {
    grid-column: 1 / -1;
  }

  /* A collapsed run of lines reads as a seam in the file: the count, then a
     hairline across the code.

     The count used to be centred, which only ever worked on a file whose longest
     line was narrower than the pane. This column is the scrolled code column, so
     its width is the longest line's — on anything wider the centre is hundreds of
     pixels past the right edge and the reader saw a hairline running off the pane
     with no count on it. Leading with the count puts it where the eye already is,
     next to the expand controls, at any line length. */
  [data-separator="line-info-basic"] [data-separator-content] {
    min-width: 0;
    width: 100%;
    justify-content: flex-start;
    gap: 8px;
    padding-inline: 12px;
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

  /* Split mounts the same hunk in both panes. One count and one set of controls;
     the new pane keeps the hairline so the row still reads across the divider. */
  [data-diff-type="split"] [data-additions] [data-unmodified-lines],
  [data-diff-type="split"] [data-additions] [data-expand-button] {
    display: none;
  }

  [data-separator="line-info-basic"]:hover [data-unmodified-lines] {
    color: var(--text-secondary);
  }

  [data-content] [data-separator="line-info-basic"] [data-expand-button] {
    position: relative;
    min-width: 28px;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
  }

  [data-content] [data-separator="line-info-basic"] [data-expand-button]::before {
    content: "";
    position: absolute;
    inset: 2px;
    border-radius: var(--corner-compact);
    corner-shape: squircle;
    background: transparent;
    pointer-events: none;
  }

  [data-content] [data-separator="line-info-basic"] [data-expand-button]:hover {
    background: transparent;
    color: var(--text);
  }

  [data-content] [data-separator="line-info-basic"] [data-expand-button]:hover::before {
    background: var(--control-fill-hover);
  }

  [data-content] [data-separator="line-info-basic"] [data-expand-button] [data-icon] {
    position: relative;
    width: 14px;
    height: 14px;
  }

  @media (pointer: fine) {
    [data-content] [data-separator="line-info-basic"] [data-separator-wrapper][data-separator-multi-button] {
      grid-template-rows: 100%;
    }

    [data-content] [data-separator="line-info-basic"] [data-separator-multi-button] [data-expand-up] {
      grid-area: 1 / 1;
    }

    [data-content] [data-separator="line-info-basic"] [data-separator-multi-button] [data-expand-down] {
      grid-area: 1 / 2;
    }
  }
`
