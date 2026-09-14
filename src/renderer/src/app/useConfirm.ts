import { useCallback, useRef, useState } from 'react'

import type { ConfirmRequest } from './ConfirmDialog'

export interface ConfirmController {
  /** The request currently on screen, or null. Render `<ConfirmDialog>` from it. */
  request: ConfirmRequest | null
  /** Awaits the user's answer; resolves false on Escape, backdrop or Cancel. */
  confirm(request: ConfirmRequest): Promise<boolean>
  resolve(confirmed: boolean): void
}

/**
 * Keeps the promise-returning shape of `window.confirm` so a call site stays a
 * one-line `await`, while the answer comes from the app's own dialog.
 */
export function useConfirm(): ConfirmController {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)
  const pendingRef = useRef<((confirmed: boolean) => void) | null>(null)

  const resolve = useCallback((confirmed: boolean) => {
    const pending = pendingRef.current
    pendingRef.current = null
    setRequest(null)
    pending?.(confirmed)
  }, [])

  const confirm = useCallback((next: ConfirmRequest) => {
    // A second prompt arriving while one is open answers the first as declined
    // rather than stranding its caller.
    pendingRef.current?.(false)
    setRequest(next)
    return new Promise<boolean>((resolvePromise) => {
      pendingRef.current = resolvePromise
    })
  }, [])

  return { request, confirm, resolve }
}
