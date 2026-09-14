/**
 * When this bundle was built.
 *
 * `__BUILD_TIME__` is substituted by `electron.vite.config.ts` at bundle time.
 * A test run or any other unbundled entry has no substitution, and the `typeof`
 * guard is what keeps that from throwing a ReferenceError. The fallback is
 * `null` rather than `Date.now()` on purpose: an unknown build time has to read
 * as unknown, because reporting the moment the app happened to start as the
 * moment it was built is worse than showing nothing.
 */
declare const __BUILD_TIME__: string | undefined

export const BUILD_TIME: string | null =
  typeof __BUILD_TIME__ === 'string' && __BUILD_TIME__ !== '' ? __BUILD_TIME__ : null

/**
 * `2026-09-14 22:12` — the stamp is UTC, the display is the reader's own
 * timezone, because the question "when was this build made" is asked from where
 * the app is running, not from where it was compiled.
 */
export function formatBuildTime(isoTime: string | null): string | null {
  if (isoTime == null || isoTime === '') return null
  const built = new Date(isoTime)
  if (Number.isNaN(built.getTime())) return null
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${built.getFullYear()}-${pad(built.getMonth() + 1)}-${pad(built.getDate())}`
  return `${date} ${pad(built.getHours())}:${pad(built.getMinutes())}`
}
