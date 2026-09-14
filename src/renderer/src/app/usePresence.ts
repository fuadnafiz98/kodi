import { useEffect, useRef, useState } from 'react'

export interface Presence {
  /** True while the node must stay in the tree — open, or still transitioning out. */
  mounted: boolean
  /** True only during the exit, so the caller can flip a `data-state` hook. */
  closing: boolean
}

export function presenceFrom(retained: boolean, open: boolean): Presence {
  return { mounted: retained || open, closing: retained && !open }
}

/**
 * Holds a node in the tree for the length of its exit transition. React removing
 * it in the same commit that flips the flag is the reason so many surfaces here
 * animate in and teleport out; the CSS for both directions already exists.
 *
 * Re-opening during the exit clears the pending unmount and the transition
 * retargets from its current computed value, so there is no flicker and no
 * remount.
 */
export function usePresence(open: boolean, exitMs: number): Presence {
  const [retained, setRetained] = useState(open)

  useEffect(() => {
    if (open) {
      setRetained(true)
      return
    }
    const timer = window.setTimeout(() => setRetained(false), exitMs)
    return () => window.clearTimeout(timer)
  }, [open, exitMs])

  return presenceFrom(retained, open)
}

/**
 * `usePresence` for a surface whose content comes from the same value that
 * closes it: the last non-null value is kept so the exit still has something to
 * render. The copy lives in a ref written from an effect — it must never cause a
 * render of its own, or the exit would restart.
 */
export function useRetainedPresence<T>(value: T | null, exitMs: number): Presence & { retained: T | null } {
  const presence = usePresence(value != null, exitMs)
  const lastValue = useRef<T | null>(value)

  useEffect(() => {
    if (value != null) lastValue.current = value
  }, [value])

  return { ...presence, retained: value ?? lastValue.current }
}
