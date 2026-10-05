import { useEffect, useRef } from 'react'
import { IconPlus } from '@pierre/icons'
import './GutterActions.css'

/**
 * The `+` that rides the hovered line's gutter. One control, one gesture: click
 * comments, press-and-drag selects a range — the drag binding keys off
 * `data-utility-button`, the attribute the built-in button used to carry.
 *
 * Slotted content sits in the light DOM, so the button is styled from
 * GutterActions.css — the viewer's unsafeCSS lives in the shadow root and cannot
 * reach it.
 */
interface GutterActionHandlers {
  onComment(): void
}

/**
 * The viewer listens for pointer events on the `pre` inside its shadow root, and
 * slotted light-DOM content still passes through that node on the way up — and
 * with a custom utility the viewer's own click handler is gone, so an unstopped
 * press would start a line selection under the button. React dispatches its own
 * handlers from the app root, further up again — too late. Stopping it has to be
 * a native listener at or below the button. The drag binding listens on the
 * shadow root in capture phase, which runs before this listener, so stopping
 * propagation here does not cost the drag.
 */
function useIntercept(handlers: GutterActionHandlers): React.RefObject<HTMLSpanElement | null> {
  const hostRef = useRef<HTMLSpanElement>(null)
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  useEffect(() => {
    const host = hostRef.current
    if (host == null) return
    const intercept = (event: Event): void => {
      const target = event.target
      // Element, not HTMLElement: the icon's svg/path targets are SVGElements,
      // and the icon is what a click on an 18px button almost always lands on.
      if (!(target instanceof Element)) return
      if (target.closest('[data-gutter-comment]') == null) return
      event.stopPropagation()
      // No preventDefault on pointerdown: a cancelled pointerdown suppresses the
      // click it would have produced, and click is the one that acts.
      if (event.type !== 'click') return
      event.preventDefault()
      handlersRef.current.onComment()
    }
    // Capture, so the button's own container answers before anything above it.
    host.addEventListener('pointerdown', intercept, true)
    host.addEventListener('click', intercept, true)
    return () => {
      host.removeEventListener('pointerdown', intercept, true)
      host.removeEventListener('click', intercept, true)
    }
  }, [])

  return hostRef
}

export function GutterActions({ onComment }: GutterActionHandlers): React.JSX.Element {
  const hostRef = useIntercept({ onComment })
  return (
    <span data-gutter-actions="" ref={hostRef}>
      <button data-utility-button="" data-gutter-comment="" type="button"
        aria-label="Comment on this line" title="Comment on this line">
        <IconPlus aria-hidden="true" />
      </button>
    </span>
  )
}
