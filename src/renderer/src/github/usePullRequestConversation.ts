import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { PullRequestConversation, RemoteReviewThread, RepositoryReview } from '../../../shared/contracts'
import { getErrorMessage } from '../explorer/repositoryApi'
import { worldViewCache } from '../review/worldViewCache'

// Every tick is a `gh api graphql` process. At 15 s a half-hour review was ~120
// spawns of a query that almost always returns the same bytes, and with GitHub
// unreachable it was 120 failing spawns with nothing on screen to explain why
// remote comments had vanished.
const CONVERSATION_POLL_INTERVAL_MS = 30_000
const MAX_CONVERSATION_POLL_INTERVAL_MS = 300_000
const CONVERSATION_POLL_SCROLL_IDLE_MS = 2_000

export function nextConversationPollDelay(
  currentDelayMs: number,
  available: boolean,
  baseMs: number = CONVERSATION_POLL_INTERVAL_MS,
  maxMs: number = MAX_CONVERSATION_POLL_INTERVAL_MS
): number {
  if (available) return baseMs
  return Math.min(maxMs, Math.max(baseMs, currentDelayMs) * 2)
}

interface PullRequestConversationApi {
  conversation: PullRequestConversation | null
  threadsByPath: ReadonlyMap<string, RemoteReviewThread[]>
  pendingThreadId: string | null
  unavailableMessage: string | null
  reply(threadId: string, body: string): void
  setResolved(threadId: string, resolved: boolean): void
  refresh(): void
}

export function sameConversation(
  current: PullRequestConversation | null,
  next: PullRequestConversation
): boolean {
  if (current == null) return false
  if (current.available !== next.available || current.message !== next.message) return false
  if (current.complete !== next.complete || current.stale !== next.stale || current.partialError !== next.partialError) return false
  if (current.body !== next.body) return false
  if (current.threads.length !== next.threads.length) return false
  if (current.reviews.length !== next.reviews.length) return false
  for (let index = 0; index < current.threads.length; index += 1) {
    const currentThread = current.threads[index]!
    const nextThread = next.threads[index]!
    if (currentThread.id !== nextThread.id) return false
    if (currentThread.path !== nextThread.path || currentThread.startLine !== nextThread.startLine) return false
    if (currentThread.side !== nextThread.side) return false
    if (currentThread.resolved !== nextThread.resolved) return false
    if (currentThread.outdated !== nextThread.outdated) return false
    if (currentThread.line !== nextThread.line) return false
    if (currentThread.comments.length !== nextThread.comments.length) return false
    for (let commentIndex = 0; commentIndex < currentThread.comments.length; commentIndex += 1) {
      const currentComment = currentThread.comments[commentIndex]!
      const nextComment = nextThread.comments[commentIndex]!
      if (currentComment.id !== nextComment.id || currentComment.body !== nextComment.body) return false
      if (currentComment.authorLogin !== nextComment.authorLogin) return false
      if (currentComment.authorAvatarUrl !== nextComment.authorAvatarUrl) return false
      if (currentComment.createdAt !== nextComment.createdAt) return false
    }
  }
  for (let index = 0; index < current.reviews.length; index += 1) {
    const currentReview = current.reviews[index]!
    const nextReview = next.reviews[index]!
    if (currentReview.id !== nextReview.id || currentReview.state !== nextReview.state) return false
    if (currentReview.body !== nextReview.body || currentReview.authorLogin !== nextReview.authorLogin) return false
    if (currentReview.authorAvatarUrl !== nextReview.authorAvatarUrl) return false
    if (currentReview.submittedAt !== nextReview.submittedAt) return false
  }
  return true
}

export function groupRemoteThreadsByPath(
  threads: readonly RemoteReviewThread[]
): Map<string, RemoteReviewThread[]> {
  const byPath = new Map<string, RemoteReviewThread[]>()
  for (const thread of threads) {
    const existing = byPath.get(thread.path)
    if (existing == null) byPath.set(thread.path, [thread])
    else existing.push(thread)
  }
  return byPath
}

// GitHub is the source of truth for other people's comments, so an open review
// re-reads the conversation on a timer and after every write of our own.
export function usePullRequestConversation(
  root: string,
  repositoryReview: RepositoryReview | null,
  onError: (message: string | null) => void,
  worldId: string | null = null
): PullRequestConversationApi {
  const selector = repositoryReview?.kind === 'github' ? repositoryReview.selector : null
  const [conversationWorldId, setConversationWorldId] = useState(worldId)
  const [conversation, setConversation] = useState<PullRequestConversation | null>(
    () => worldId == null ? null : worldViewCache.get(worldId)?.conversation ?? null
  )
  if (conversationWorldId !== worldId) {
    setConversationWorldId(worldId)
    setConversation(worldId == null ? null : worldViewCache.get(worldId)?.conversation ?? null)
  }
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null)
  const [refreshRevision, setRefreshRevision] = useState(0)
  const refreshGenerationRef = useRef(0)
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  }, [onError])
  useLayoutEffect(() => {
    if (worldId != null) worldViewCache.rememberConversation(worldId, conversation)
  }, [conversation, worldId])

  useEffect(() => {
    if (selector == null) {
      setConversation(null)
      if (worldId != null) worldViewCache.rememberConversation(worldId, null)
      return
    }
    let cancelled = false
    let loading = false
    let delay = CONVERSATION_POLL_INTERVAL_MS
    let timer: number | null = null

    const schedule = (): void => {
      if (cancelled) return
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(tick, delay)
    }
    const load = async (): Promise<void> => {
      const repository = window.repository
      if (repository == null || loading) return
      loading = true
      try {
        const next = await repository.getPullRequestConversation(root, selector)
        if (cancelled) return
        // An unchanged conversation must keep its identity, or every poll would
        // rebuild every annotated review item.
        setConversation((current) => {
          const resolved = sameConversation(current, next) ? current : next
          if (worldId != null) worldViewCache.rememberConversation(worldId, resolved)
          return resolved
        })
        // Backing off on an unreachable GitHub is the difference between a
        // failing subprocess every 30 s forever and one every five minutes.
        delay = nextConversationPollDelay(delay, next.available)
      } catch (error) {
        if (cancelled) return
        delay = nextConversationPollDelay(delay, false)
        onErrorRef.current(getErrorMessage(error))
      } finally {
        loading = false
      }
    }
    let lastScrollAt = 0
    const noteScroll = (): void => {
      lastScrollAt = performance.now()
    }
    const tick = (): void => {
      // A hidden window must not keep spawning GitHub reads.
      if (document.hidden) {
        schedule()
        return
      }
      // A `gh` subprocess in the middle of a fling spikes CPU on the same thread
      // that is already highlighting. Wait until scrolling has been idle.
      const scrollAge = performance.now() - lastScrollAt
      if (lastScrollAt > 0 && scrollAge < CONVERSATION_POLL_SCROLL_IDLE_MS) {
        if (timer != null) window.clearTimeout(timer)
        timer = window.setTimeout(tick, CONVERSATION_POLL_SCROLL_IDLE_MS - scrollAge)
        return
      }
      void load().finally(schedule)
    }

    const cached = worldId == null ? null : worldViewCache.get(worldId)?.conversation ?? null
    const forced = refreshRevision !== refreshGenerationRef.current
    refreshGenerationRef.current = refreshRevision
    if (cached == null || forced) void load().finally(schedule)
    else schedule()
    // Returning focus catches up immediately instead of waiting out a backed-off
    // interval, and resets the back-off because the user is watching again.
    const handleVisibility = (): void => {
      if (document.hidden) return
      delay = CONVERSATION_POLL_INTERVAL_MS
      void load().finally(schedule)
    }
    document.addEventListener('visibilitychange', handleVisibility)
    document.addEventListener('scroll', noteScroll, { capture: true, passive: true })
    return () => {
      cancelled = true
      if (timer != null) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', handleVisibility)
      document.removeEventListener('scroll', noteScroll, true)
    }
  }, [refreshRevision, root, selector, worldId])

  const refresh = useCallback(() => setRefreshRevision((revision) => revision + 1), [])

  const runThreadAction = useCallback(async (
    threadId: string,
    action: (repository: NonNullable<typeof window.repository>) => Promise<void>
  ) => {
    const repository = window.repository
    if (repository == null) return
    setPendingThreadId(threadId)
    try {
      await action(repository)
      setRefreshRevision((revision) => revision + 1)
    } catch (error) {
      onErrorRef.current(getErrorMessage(error))
    } finally {
      setPendingThreadId(null)
    }
  }, [])

  const reply = useCallback((threadId: string, body: string) => {
    void runThreadAction(threadId, (repository) => repository.replyToPullRequestThread(root, threadId, body))
  }, [root, runThreadAction])

  const setResolved = useCallback((threadId: string, resolved: boolean) => {
    void runThreadAction(threadId, (repository) => repository.setPullRequestThreadResolved(root, threadId, resolved))
  }, [root, runThreadAction])

  const threadsByPath = useMemo(
    () => groupRemoteThreadsByPath(conversation?.threads ?? []),
    [conversation]
  )

  const unavailableMessage = conversation != null && !conversation.available
    ? conversation.message ?? 'GitHub is unavailable, so remote review comments are not shown.'
    : null

  return { conversation, threadsByPath, pendingThreadId, unavailableMessage, reply, setResolved, refresh }
}
