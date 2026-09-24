import { useCallback, useEffect, useRef, useState } from 'react'

import { deepActiveElement, isTypingElement } from '../settings/keybindings'

// Long enough that a pause to read a hunk does not count as walking away, short
// enough that coming back from a terminal finds the tab already caught up.
export const REVIEW_IDLE_MS = 10_000
const INTERACTION_EVENTS = ['scroll', 'keydown', 'pointerdown', 'wheel'] as const

export interface RevisionAdoptionState {
  hidden: boolean
  msSinceInteraction: number
  /** A composer or comment field owns the caret; a reload would eat the draft. */
  typing?: boolean
  idleMs?: number
}

/**
 * Whether a commit pushed to the open pull request should be adopted without
 * asking.
 *
 * A review tab is a snapshot of base→head, and that is deliberate: hunks that
 * move while they are being read cost the reader their place, their scroll
 * position and the meaning of every file they had already marked viewed. So the
 * rule is about whether anyone is looking. Nobody is looking at a hidden window,
 * or at a review that has not been touched in ten seconds; a caret in a comment
 * field means somebody very much is.
 */
export function shouldAdoptNewRevision(state: RevisionAdoptionState): boolean {
  if (state.hidden) return true
  if (state.typing === true) return false
  return state.msSinceInteraction >= (state.idleMs ?? REVIEW_IDLE_MS)
}

/** How long a still, visible reader has left before adoption fires. */
export function msUntilIdleAdoption(msSinceInteraction: number, idleMs = REVIEW_IDLE_MS): number {
  return Math.max(0, idleMs - msSinceInteraction)
}

export interface NewRevisionWatch {
  /** The head commit this tab has not adopted yet, short-form for display. */
  pendingHeadOid: string | null
  adopt(): void
}

export interface NewRevisionWatchOptions {
  /**
   * What the pending head belongs to — a pull request URL. The workspace this
   * hook lives in survives a tab switch, so without it a head left pending on
   * one review would be adopted against whichever review is in front when the
   * reader finally goes still.
   */
  reviewIdentity?: string | null
  /** Policy, and policy belongs to the caller; a test can also shorten it. */
  idleMs?: number
}

function isTyping(): boolean {
  return isTypingElement(deepActiveElement(document))
}

/**
 * Notices that the pull request moved ahead of the tab showing it, and adopts
 * the new head the moment nobody is reading — immediately if the window is
 * hidden or the review is already idle, otherwise as soon as it becomes so.
 *
 * Whether anyone is looking is the whole question, and it has to keep being
 * asked: a reader who was mid-scroll when the poll landed goes still a moment
 * later, and a decision taken once at that instant would leave them with a
 * banner that outlives their attention. The head rides along with the
 * conversation poll, so none of this costs an extra read.
 */
export function useNewRevisionWatch(
  conversationHeadOid: string | null | undefined,
  reviewHeadOid: string | null | undefined,
  onAdopt: (() => void | boolean | Promise<boolean>) | null,
  { reviewIdentity = null, idleMs = REVIEW_IDLE_MS }: NewRevisionWatchOptions = {}
): NewRevisionWatch {
  const [pendingHeadOid, setPendingHeadOid] = useState<string | null>(null)
  const lastInteractionRef = useRef(performance.now())
  // The head a reload has already been asked for. Until the review catches up,
  // `reviewHeadOid` still lags and every poll would ask again.
  const requestedHeadRef = useRef<string | null>(null)
  const onAdoptRef = useRef(onAdopt)
  useEffect(() => {
    onAdoptRef.current = onAdopt
  }, [onAdopt])

  const adoptHead = useCallback((headOid: string) => {
    requestedHeadRef.current = headOid
    setPendingHeadOid(null)
    // A reload that failed must not count as answered, or the early return above
    // silences this watch until somebody pushes again.
    void Promise.resolve(onAdoptRef.current?.()).then((adopted) => {
      if (adopted !== false) return
      requestedHeadRef.current = null
      setPendingHeadOid(headOid)
    })
  }, [])

  // A pending head belongs to the review it was read from; another review's tab
  // must start clean rather than inherit it.
  useEffect(() => {
    requestedHeadRef.current = null
    setPendingHeadOid(null)
  }, [reviewIdentity])

  useEffect(() => {
    const note = (): void => {
      lastInteractionRef.current = performance.now()
    }
    for (const event of INTERACTION_EVENTS) {
      document.addEventListener(event, note, { capture: true, passive: true })
    }
    return () => {
      for (const event of INTERACTION_EVENTS) document.removeEventListener(event, note, true)
    }
  }, [])

  useEffect(() => {
    if (conversationHeadOid == null || conversationHeadOid === ''
      || reviewHeadOid == null || reviewHeadOid === '') return
    if (conversationHeadOid === reviewHeadOid) {
      requestedHeadRef.current = null
      setPendingHeadOid(null)
      return
    }
    if (requestedHeadRef.current === conversationHeadOid) return
    if (shouldAdoptNewRevision({
      hidden: document.hidden,
      typing: isTyping(),
      msSinceInteraction: performance.now() - lastInteractionRef.current,
      idleMs
    })) {
      adoptHead(conversationHeadOid)
      return
    }
    setPendingHeadOid(conversationHeadOid)
  }, [adoptHead, conversationHeadOid, idleMs, reviewHeadOid])

  // Armed only while a banner is up. One timer that re-asks, never a listener
  // per interaction: `scroll` and `wheel` fire at frame rate through a diff, and
  // the timestamp those events already keep is enough to answer from. Each miss
  // reschedules for exactly as long as the reader has left, so a hand that never
  // stops moving pushes the deadline ahead of itself without costing a frame.
  useEffect(() => {
    if (pendingHeadOid == null) return
    let timer: number | null = null

    const attempt = (): void => {
      const msSinceInteraction = performance.now() - lastInteractionRef.current
      const typing = isTyping()
      if (shouldAdoptNewRevision({ hidden: document.hidden, typing, msSinceInteraction, idleMs })) {
        adoptHead(pendingHeadOid)
        return
      }
      // A caret has no deadline of its own: `keydown` keeps pushing the stamp
      // forward, and a field left focused is checked again a window later.
      const wait = typing ? idleMs : msUntilIdleAdoption(msSinceInteraction, idleMs)
      timer = window.setTimeout(attempt, Math.max(wait, 1))
    }
    const onVisibility = (): void => {
      if (document.hidden) attempt()
    }

    attempt()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer != null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [adoptHead, idleMs, pendingHeadOid])

  const adopt = useCallback(() => {
    if (pendingHeadOid != null) adoptHead(pendingHeadOid)
  }, [adoptHead, pendingHeadOid])

  return { pendingHeadOid, adopt }
}
