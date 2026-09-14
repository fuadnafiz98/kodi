export const CENTERED_COLLAPSED_SEPARATOR_CSS = `
  /* Pierre mounts the same separator in the gutter and the content column, then
     hides the content copy. Stretching the gutter copy with 100cqi centres the
     label on :host — both split panes — whenever [data-code] is not a valid
     query container (wrap uses display:contents; scroll size-containment often
     falls through). The label belongs in the content column, which is always a
     real track. */

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

  /* A collapsed run of lines reads as a seam in the file: one hairline across
     the code, broken by the count. */
  [data-separator="line-info-basic"] [data-separator-content] {
    min-width: 0;
    width: 100%;
    justify-content: center;
    gap: 8px;
    padding-inline: 12px;
    background: inherit;
  }

  [data-separator="line-info-basic"] [data-separator-content]::before,
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

  /* Split mounts the same hunk in both panes. One count; the new pane keeps a
     seam so the row still reads across the divider. */
  [data-diff-type="split"] [data-additions] [data-unmodified-lines],
  [data-diff-type="split"] [data-additions] [data-expand-button] {
    display: none;
  }

  [data-diff-type="split"] [data-additions] [data-separator-content]::after {
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
