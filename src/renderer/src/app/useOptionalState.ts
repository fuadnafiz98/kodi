import { useState } from 'react'

/**
 * State a parent may own or leave alone. When `controlled` is `undefined` the
 * hook keeps its own value; otherwise the prop wins and the setter only reports.
 */
export function useOptionalState<T>(
  controlled: T | undefined,
  initial: T,
  onChange?: (next: T) => void
): [T, (next: T) => void] {
  const [uncontrolled, setUncontrolled] = useState(initial)
  const value = controlled ?? uncontrolled
  const set = (next: T): void => {
    onChange?.(next)
    if (controlled == null) setUncontrolled(next)
  }
  return [value, set]
}
