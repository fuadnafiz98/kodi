import { useEffect, useEffectEvent, useRef } from 'react'

export function useDebouncedPersist<T>(
  value: T,
  persist: (value: T) => void,
  delayMs: number
): void {
  const timerRef = useRef<number | null>(null)
  const lastPersistedRef = useRef<T>(value)
  const persistLatest = useEffectEvent(() => {
    lastPersistedRef.current = value
    persist(value)
  })

  useEffect(() => {
    if (Object.is(value, lastPersistedRef.current)) return
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      persistLatest()
    }, delayMs)
  }, [delayMs, value])

  useEffect(() => {
    const flush = (): void => {
      if (timerRef.current == null) return
      window.clearTimeout(timerRef.current)
      timerRef.current = null
      persistLatest()
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])
}
