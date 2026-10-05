import type { SelectionAction, SelectionActionContext } from './selectionAction'

// The editor's selection bar, loaded with the editor module: only a file being
// edited ever shows it. It is plain DOM inside the viewer's shadow root, so it
// brings its icons as markup (@pierre/icons' own SVGs) and its styles with it.

const ICONS: Record<SelectionAction['icon'], string> = {
  copy: '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path opacity="0.4" d="M2.25 5.5C1.83579 5.5 1.5 5.83579 1.5 6.25V13.75C1.5 14.1642 1.83579 14.5 2.25 14.5H9.75C10.1642 14.5 10.5 14.1642 10.5 13.75V13H12V13.75C12 14.9926 10.9926 16 9.75 16H2.25C1.00736 16 0 14.9926 0 13.75V6.25C0 5.00736 1.00736 4 2.25 4H2.875V5.5H2.25Z" fill="currentColor"/><path d="M4 2.25C4 1.00736 5.00736 0 6.25 0H13.75C14.9926 0 16 1.00736 16 2.25V9.75C16 10.9926 14.9926 12 13.75 12H6.25C5.00736 12 4 10.9926 4 9.75V2.25ZM6.25 1.5C5.83579 1.5 5.5 1.83579 5.5 2.25V9.75C5.5 10.1642 5.83579 10.5 6.25 10.5H13.75C14.1642 10.5 14.5 10.1642 14.5 9.75V2.25C14.5 1.83579 14.1642 1.5 13.75 1.5H6.25Z" fill="currentColor"/></svg>',
  chat: '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12.1176 8.88235C13.1324 9.89711 14.9428 10.1162 15.6772 10.1635C15.8555 10.1749 16 10.3213 16 10.5C16 10.6787 15.8555 10.8251 15.6772 10.8365C14.9428 10.8838 13.1324 11.1029 12.1176 12.1176C11.1029 13.1324 10.8838 14.9428 10.8365 15.6772C10.8251 15.8555 10.6787 16 10.5 16C10.3213 16 10.1749 15.8555 10.1635 15.6772C10.1162 14.9428 9.89711 13.1324 8.88235 12.1176C7.8676 11.1029 6.05715 10.8838 5.32279 10.8365C5.14448 10.8251 5 10.6787 5 10.5C5 10.3213 5.14448 10.1749 5.32279 10.1635C6.05715 10.1162 7.8676 9.89711 8.88235 8.88235C9.89711 7.8676 10.1162 6.05715 10.1635 5.32279C10.1749 5.14448 10.3213 5 10.5 5C10.6787 5 10.8251 5.14448 10.8365 5.32279C10.8838 6.05715 11.1029 7.8676 12.1176 8.88235Z" fill="currentColor"/><path d="M4.52941 5.47059C5.17516 6.11634 6.32727 6.25574 6.79459 6.28583C6.90806 6.29314 7 6.38629 7 6.5C7 6.61371 6.90806 6.70686 6.79459 6.71417C6.32727 6.74426 5.17516 6.88366 4.52941 7.52941C3.88366 8.17516 3.74426 9.32727 3.71417 9.79459C3.70686 9.90806 3.61371 10 3.5 10C3.38629 10 3.29314 9.90806 3.28583 9.79459C3.25574 9.32727 3.11634 8.17516 2.47059 7.52941C1.82484 6.88366 0.672734 6.74426 0.205411 6.71417C0.09194 6.70686 0 6.61371 0 6.5C0 6.38629 0.09194 6.29314 0.205411 6.28583C0.672734 6.25574 1.82484 6.11634 2.47059 5.47059C3.11634 4.82484 3.25574 3.67273 3.28583 3.20541C3.29314 3.09194 3.38629 3 3.5 3C3.61371 3 3.70686 3.09194 3.71417 3.20541C3.74426 3.67273 3.88366 4.82484 4.52941 5.47059Z" fill="currentColor"/><path d="M9.23529 1.76471C9.69655 2.22596 10.5195 2.32553 10.8533 2.34702C10.9343 2.35224 11 2.41878 11 2.5C11 2.58122 10.9343 2.64776 10.8533 2.65298C10.5195 2.67447 9.69655 2.77404 9.23529 3.23529C8.77404 3.69655 8.67447 4.51948 8.65298 4.85328C8.64776 4.93433 8.58122 5 8.5 5C8.41878 5 8.35224 4.93433 8.34702 4.85328C8.32553 4.51948 8.22596 3.69655 7.76471 3.23529C7.30345 2.77404 6.48052 2.67447 6.14672 2.65298C6.06567 2.64776 6 2.58122 6 2.5C6 2.41878 6.06567 2.35224 6.14672 2.34702C6.48052 2.32553 7.30345 2.22596 7.76471 1.76471C8.22596 1.30345 8.32553 0.480524 8.34702 0.146722C8.35224 0.0656713 8.41878 0 8.5 0C8.58122 0 8.64776 0.0656713 8.65298 0.146722C8.67447 0.480524 8.77404 1.30345 9.23529 1.76471Z" fill="currentColor"/></svg>',
  comment: '<svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M8.00002 1.5C4.41017 1.5 1.50002 4.41015 1.50002 8C1.50002 9.79513 2.22674 11.4191 3.40383 12.5962C3.69672 12.8891 3.69672 13.364 3.40383 13.6569L2.56068 14.5H8.00002C11.5899 14.5 14.5 11.5899 14.5 8C14.5 7.3768 14.4125 6.7753 14.2496 6.20649C13.7233 4.36854 12.4061 2.86183 10.6893 2.08049C9.87073 1.70792 8.96067 1.5 8.00002 1.5ZM2.19411e-05 8C2.19411e-05 3.58172 3.58174 0 8.00002 0C9.17929 0 10.3009 0.255639 11.3107 0.715237C13.4225 1.67636 15.0429 3.52827 15.6917 5.79351C15.8926 6.49527 16 7.23572 16 8C16 12.4183 12.4183 16 8.00002 16H0.750022C0.446675 16 0.173198 15.8173 0.0571123 15.537C-0.0589735 15.2568 0.00519335 14.9342 0.219692 14.7197L1.83763 13.1017C0.690449 11.7174 2.19411e-05 9.93877 2.19411e-05 8Z" fill="currentColor"/><path d="M8 4.5C8.41421 4.5 8.75 4.83579 8.75 5.25V7.25H10.75C11.1642 7.25 11.5 7.58579 11.5 8C11.5 8.41421 11.1642 8.75 10.75 8.75H8.75V10.75C8.75 11.1642 8.41421 11.5 8 11.5C7.58579 11.5 7.25 11.1642 7.25 10.75V8.75H5.25C4.83579 8.75 4.5 8.41421 4.5 8C4.5 7.58579 4.83579 7.25 5.25 7.25H7.25V5.25C7.25 4.83579 7.58579 4.5 8 4.5Z" fill="currentColor"/></svg>'
}

// The review's selection bar (`.selection-actions`), drawn in the shadow root.
const SELECTION_BAR_CSS = `
  /* The editor wraps the bar in a widget with a border, fill and padding of its
     own; that wrapper is the one surface, or the bar sat framed inside a frame. */
  [data-selection-action-popover] {
    padding: 3px;
    border: 0;
    border-radius: var(--corner-control);
    background: var(--floating-surface);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 8%, transparent), var(--elev-1);
  }

  [data-selection-action] {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  [data-selection-action] button {
    width: 24px;
    height: 24px;
    position: relative;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--corner-inset);
    padding: 0;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: scale var(--duration-fast) var(--ease-out), background-color var(--duration-fast) var(--ease-out), color var(--duration-fast) var(--ease-out);
  }

  [data-selection-action] button svg {
    width: var(--icon-md);
    height: var(--icon-md);
    flex: none;
  }

  [data-selection-action] button:hover {
    background: var(--control-fill-hover);
    color: var(--text);
  }

  [data-selection-action] button:active:not(:disabled) {
    scale: 0.96;
  }

  [data-selection-action] button:focus-visible {
    outline: var(--focus-ring) solid var(--focus);
    outline-offset: -1px;
  }

  /* Comment is what a selection is for: the accent is in the glyph, not a fill. */
  [data-selection-action] button[data-primary] {
    color: var(--accent);
  }

  [data-selection-action] button[data-primary]:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }

  /* Icons alone, so the tooltip is the name: on hover and focus, no delay. */
  [data-selection-action] button[data-tooltip]::after {
    content: attr(data-tooltip);
    width: max-content;
    position: absolute;
    z-index: 4;
    top: calc(100% + 6px);
    left: 0;
    border: 1px solid var(--border-strong);
    border-radius: var(--corner-compact);
    padding: 5px 7px;
    background: var(--floating-surface);
    color: var(--text-secondary);
    font-family: var(--font-ui);
    font-size: var(--text-xs);
    font-weight: var(--weight-strong);
    line-height: 1;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transform: translateY(-2px);
    transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
  }

  [data-selection-action] button[data-tooltip]:hover::after,
  [data-selection-action] button[data-tooltip]:focus-visible::after {
    opacity: 1;
    transform: translateY(0);
  }
`

export function createSelectionActionElement(
  actions: readonly SelectionAction[],
  context: SelectionActionContext
): HTMLElement {
  const container = document.createElement('div')
  container.dataset.selectionAction = 'true'
  const style = document.createElement('style')
  style.textContent = SELECTION_BAR_CSS
  container.append(style)
  for (const action of actions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('aria-label', action.label)
    button.dataset.tooltip = action.tooltip ?? action.label
    if (action.primary === true) button.dataset.primary = ''
    button.innerHTML = ICONS[action.icon]
    // Without this the click blurs the editor first, which collapses the very
    // selection the action is about to read.
    button.addEventListener('mousedown', (event) => event.preventDefault())
    button.addEventListener('click', () => {
      action.run(context)
      context.close()
    })
    container.append(button)
  }
  return container
}
