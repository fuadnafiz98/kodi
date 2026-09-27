/**
 * Progress events and the reply to the call that started them are separate IPC
 * messages, and Electron does not order one against the other: the reply can
 * land before pages main sent ahead of it. A load that trusted the reply marked
 * the review complete with whatever had arrived — often just the first file, so
 * ⌘K had nothing to jump to — or, with no page yet, read an empty reply as "no
 * patch" and fetched every file one by one. Events on one channel do arrive in
 * the order they were sent, so the stream's own `done` event is what says every
 * page is in.
 */
export const STREAM_DONE_TIMEOUT_MS = 5_000

export interface StreamCompletion {
  /** Records the stream's `done` event. */
  markDone(): void
  readonly done: boolean
  /**
   * Resolves once `done` has arrived, or after `timeoutMs` if it never does — a
   * main process that never sends it must not hold the review forever. Resolves
   * `true` when the stream finished, `false` on the timeout.
   */
  wait(timeoutMs?: number): Promise<boolean>
}

export function createStreamCompletion(): StreamCompletion {
  let done = false
  let resolveDone: (() => void) | null = null
  const finished = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  return {
    markDone() {
      done = true
      resolveDone?.()
    },
    get done() {
      return done
    },
    async wait(timeoutMs = STREAM_DONE_TIMEOUT_MS) {
      if (done) return true
      let timer: ReturnType<typeof setTimeout> | undefined
      const timedOut = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
      })
      const result = await Promise.race([finished.then(() => true as const), timedOut])
      clearTimeout(timer)
      return result
    }
  }
}
