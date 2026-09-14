import { useEffect, type RefObject } from 'react'

/** Closes a non-modal popover on a click outside it or on Escape. */
export function usePopoverDismiss(
  open: boolean,
  hostRef: RefObject<HTMLElement | null>,
  onDismiss: () => void
): void {
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (hostRef.current?.contains(event.target as Node) === true) return
      onDismiss()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onDismiss()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [hostRef, onDismiss, open])
}
