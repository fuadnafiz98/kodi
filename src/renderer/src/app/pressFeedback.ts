/**
 * Past this width a button is a row, not a control. The press scale is a ratio,
 * so 0.96 is a 1px squeeze on a 28px icon button and a 38px collapse on a
 * 950px pull request row — the row visibly jumps. Rows answer with a tint.
 */
export const PRESS_ROW_MIN_WIDTH = 200

function markPressTarget(target: EventTarget | null): void {
  if (!(target instanceof Element)) return
  const button = target.closest('button')
  if (button == null) return
  const row = button.offsetWidth >= PRESS_ROW_MIN_WIDTH
  if (row === (button.dataset.press === 'row')) return
  if (row) button.dataset.press = 'row'
  else delete button.dataset.press
}

/**
 * Measured at the moment of the press rather than per component, so every wide
 * button in the app — present or future — gets it without opting in. It runs
 * before the browser applies `:active`, so the first pressed frame is already right.
 */
export function installPressFeedback(root: Document = document): () => void {
  const onPointerDown = (event: PointerEvent): void => markPressTarget(event.target)
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === ' ' || event.key === 'Enter') markPressTarget(event.target)
  }
  root.addEventListener('pointerdown', onPointerDown, true)
  root.addEventListener('keydown', onKeyDown, true)
  return () => {
    root.removeEventListener('pointerdown', onPointerDown, true)
    root.removeEventListener('keydown', onKeyDown, true)
  }
}
