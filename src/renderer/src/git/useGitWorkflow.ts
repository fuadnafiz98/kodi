import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  COMMAND_ABORTED_MESSAGE,
  type GitIntegrationSnapshot,
  type LocalBranchReview,
  type LocalReviewProgress,
  type PullRequestFolderPreview,
  type PullRequestInboxSnapshot,
  type PullRequestMergeStrategy,
  type PullRequestReviewComment,
  type PullRequestReviewEvent,
  type PullRequestSummary,
  type RepositorySnapshot
} from '../../../shared/contracts'
import { extractGitHubPullRequestUrl } from '../../../shared/pullRequestUrl'
import type { WorkspaceView } from '../app/AppView'
import type { ConfirmRequest } from '../app/ConfirmDialog'
import { reviewFolderChip } from '../github/pullRequestOpen'
import { reviewSubmissionRequest, reviewSubmittedMessage } from '../github/reviewSubmission'
import { showToast } from '../app/toast'
import { getErrorMessage, requireRepositoryApi } from '../explorer/repositoryApi'
import { automaticWorkspaceView, firstOpenPathForSnapshot } from '../explorer/workspaceMode'
import { useReviewWorlds, type ReviewWorld } from '../review/useReviewWorlds'

interface UseGitWorkflowOptions {
  snapshot: RepositorySnapshot | null
  selectedPath: string | null
  workspaceView: WorkspaceView
  applySnapshot(snapshot: RepositorySnapshot): void
  activateSnapshot(snapshot: RepositorySnapshot | null): void
  onError(message: string | null): void
  onSelectPath(path: string | null): void
  onWorkspaceViewChange(view: WorkspaceView): void
  confirm(request: ConfirmRequest): Promise<boolean>
}

export type RepositoryPanelTab = 'history' | 'branches' | 'remotes' | 'pull-requests'

// Long enough that closing and reopening the panel — the normal way to check a
// pull request — is free, short enough that a branch you switched in a terminal
// shows up without a manual refresh. Anything that moves HEAD or the branch
// invalidates the entry immediately regardless of the clock.
export const GIT_PANEL_TTL_MS = 30_000

export interface PanelCacheEntry<Value> {
  data: Value | null
  fetchedAt: number
  root: string | null
  head: string | null
  branch: string | null
}

const emptyEntry = <Value,>(): PanelCacheEntry<Value> => ({
  data: null,
  fetchedAt: 0,
  root: null,
  head: null,
  branch: null
})

export function isPanelDataStale(
  entry: PanelCacheEntry<unknown>,
  snapshot: { root?: string | null; head: string | null; branch: string | null } | null,
  now: number,
  ttlMs: number = GIT_PANEL_TTL_MS
): boolean {
  if (entry.data == null) return true
  if (snapshot != null && entry.root !== (snapshot.root ?? null)) return true
  if (snapshot != null && (entry.head !== snapshot.head || entry.branch !== snapshot.branch)) return true
  return now - entry.fetchedAt >= ttlMs
}

export function useGitWorkflow({
  snapshot,
  selectedPath,
  workspaceView,
  applySnapshot,
  activateSnapshot,
  onError,
  onSelectPath,
  onWorkspaceViewChange,
  confirm
}: UseGitWorkflowOptions) {
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelTab, setPanelTab] = useState<RepositoryPanelTab>('pull-requests')
  const [integrationEntry, setIntegrationEntry] = useState<PanelCacheEntry<GitIntegrationSnapshot>>(emptyEntry)
  const [loadingIntegration, setLoadingIntegration] = useState(false)
  const [inboxEntry, setInboxEntry] = useState<PanelCacheEntry<PullRequestInboxSnapshot>>(emptyEntry)
  const [loadingInbox, setLoadingInbox] = useState(false)
  const [actionKey, setActionKey] = useState<string | null>(null)
  const [submittingReview, setSubmittingReview] = useState(false)
  const [submissionMessage, setSubmissionMessage] = useState<string | null>(null)
  const activateRepository = useCallback(
    (root: string) => requireRepositoryApi().activateRepository(root),
    []
  )
  const releaseRepository = useCallback(
    (root: string) => requireRepositoryApi().releaseRepository(root),
    []
  )
  const handleActivationError = useCallback(
    (error: unknown) => onError(getErrorMessage(error)),
    [onError]
  )
  const reviewWorlds = useReviewWorlds({
    snapshot,
    selectedPath,
    workspaceView,
    onActivateSnapshot: activateSnapshot,
    onActivateRepository: activateRepository,
    onReleaseRepository: releaseRepository,
    onActivationError: handleActivationError,
    onSelectPath,
    onWorkspaceViewChange
  })
  const {
    activeReview: repositoryReview,
    activeWorld: activeReviewWorld,
    appendPatchPage,
    closeWorld,
    focusDesk,
    focusWorld: focusRegistryWorld,
    hasRepositoryRoot,
    hasWorld,
    initialReviewScrollTop,
    hibernateWorlds,
    isWorldActive,
    openDeskWorld,
    openNewWorld,
    openPatchWorld,
    rememberReviewScroll,
    replacePatchReview,
    reset: resetReviewWorlds,
    selectInitialPath,
    setNewWorldPending,
    setPatchChecks,
    setPatchExpectedFileCount,
    setPatchLoadStatus,
    syncRepositorySnapshot,
    updateNewWorldLocator,
    updateNewWorldRepositoryRoot,
    worlds: reviewWorldList
  } = reviewWorlds
  const [suggestedReviewFolder, setSuggestedReviewFolder] = useState<PullRequestFolderPreview | null>(null)
  const newWorldId = activeReviewWorld?.source === 'new' ? activeReviewWorld.worldId : null
  const newWorldLocator = activeReviewWorld?.source === 'new' ? activeReviewWorld.locator : ''
  const newWorldRoot = activeReviewWorld?.source === 'new' ? activeReviewWorld.repositoryRoot : null
  useEffect(() => {
    if (newWorldId == null || newWorldRoot != null) {
      setSuggestedReviewFolder(null)
      return
    }
    const url = extractGitHubPullRequestUrl(newWorldLocator)
    const preview = window.repository?.previewPullRequestFolder
    if (url == null || typeof preview !== 'function') {
      setSuggestedReviewFolder(null)
      return
    }
    let cancelled = false
    void preview(url).then((next) => {
      if (!cancelled) setSuggestedReviewFolder(next)
    }).catch(() => {
      if (!cancelled) setSuggestedReviewFolder(null)
    })
    return () => {
      cancelled = true
    }
  }, [newWorldId, newWorldLocator, newWorldRoot])
  const reviewFolder = reviewFolderChip(
    activeReviewWorld?.source === 'new' ? activeReviewWorld : null,
    suggestedReviewFolder
  )
  const chooseReviewFolder = useCallback(() => {
    const choose = window.repository?.chooseFolder
    if (typeof choose !== 'function') return
    void choose().then((path) => {
      if (path != null) updateNewWorldRepositoryRoot(path)
    }).catch((error: unknown) => {
      onError(getErrorMessage(error))
    })
  }, [onError, updateNewWorldRepositoryRoot])
  const activeWorldIdRef = useRef(activeReviewWorld?.worldId ?? null)
  useEffect(() => {
    activeWorldIdRef.current = activeReviewWorld?.worldId ?? null
  })
  const root = snapshot?.root ?? null

  const head = snapshot?.head ?? null
  const branch = snapshot?.branch ?? null
  const integration = integrationEntry.root === root ? integrationEntry.data : null
  const inbox = inboxEntry.root === root ? inboxEntry.data : null
  const reviewGenerationRef = useRef(0)
  const reviewRequestsRef = useRef(new Map<string, { root: string; originWorldId: string | null }>())
  const restoringWorldsRef = useRef(new Set<string>())
  // The cache entries are mirrored into refs so a loader can decide whether it
  // still has anything to do without depending on the render that produced it.
  // Only the writers below touch them, never a render.
  const integrationEntryRef = useRef(integrationEntry)
  const inboxEntryRef = useRef(inboxEntry)
  const writeIntegrationEntry = useCallback((entry: PanelCacheEntry<GitIntegrationSnapshot>) => {
    integrationEntryRef.current = entry
    setIntegrationEntry(entry)
  }, [])
  const writeInboxEntry = useCallback((entry: PanelCacheEntry<PullRequestInboxSnapshot>) => {
    inboxEntryRef.current = entry
    setInboxEntry(entry)
  }, [])

  const reset = useCallback(() => {
    for (const [requestId, request] of reviewRequestsRef.current) {
      requireRepositoryApi().cancelPullRequestReview(request.root, requestId)
    }
    reviewRequestsRef.current.clear()
    resetReviewWorlds()
    setSubmissionMessage(null)
    writeIntegrationEntry(emptyEntry())
    writeInboxEntry(emptyEntry())
    setPanelOpen(false)
  }, [resetReviewWorlds, writeInboxEntry, writeIntegrationEntry])

  const loadIntegration = useCallback(async (force = false) => {
    if (!force && !isPanelDataStale(integrationEntryRef.current, { root, head, branch }, Date.now())) return
    setLoadingIntegration(true)
    onError(null)
    try {
      const data = await requireRepositoryApi().getGitIntegration()
      writeIntegrationEntry({ data, fetchedAt: Date.now(), root, head, branch })
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setLoadingIntegration(false)
    }
  }, [branch, head, onError, root, writeIntegrationEntry])

  const loadInbox = useCallback(async (force = false) => {
    if (!force && !isPanelDataStale(inboxEntryRef.current, { root, head, branch }, Date.now())) return
    setLoadingInbox(true)
    try {
      const data = await requireRepositoryApi().getPullRequestInbox()
      writeInboxEntry({ data, fetchedAt: Date.now(), root, head, branch })
    } catch (error) {
      writeInboxEntry({
        data: { available: false, message: getErrorMessage(error), sections: [] },
        fetchedAt: Date.now(),
        root,
        head,
        branch
      })
    } finally {
      setLoadingInbox(false)
    }
  }, [branch, head, root, writeInboxEntry])

  const refreshPanelData = useCallback(() => {
    void loadIntegration(true)
    void loadInbox(true)
  }, [loadInbox, loadIntegration])

  const mergePullRequest = useCallback(async (
    pullRequest: PullRequestSummary,
    strategy: PullRequestMergeStrategy
  ) => {
    const action = strategy === 'merge' ? 'Merge' : strategy === 'rebase' ? 'Rebase and merge' : 'Squash and merge'
    // A merge is irreversible and the button sits in a dense icon row next to
    // Checkout and Review, where a misclick used to be enough.
    if (!(await confirm({
      title: `${action} #${pullRequest.number}?`,
      detail: `Merge “${pullRequest.title}” into ${pullRequest.baseRefName}. This cannot be undone.`,
      confirmLabel: action,
      destructive: true
    }))) return
    setActionKey(`merge:${pullRequest.number}`)
    onError(null)
    try {
      if (root == null) throw new Error('The repository tab is no longer open.')
      await requireRepositoryApi().mergePullRequest(root, pullRequest.number, strategy)
      // The panel prefers the inbox whenever it has entries, so refreshing only
      // the integration snapshot left the merged row on screen, still labelled
      // open, with its merge button live.
      await Promise.all([loadIntegration(true), loadInbox(true)])
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [confirm, loadInbox, loadIntegration, onError, root])

  const markPullRequestReady = useCallback(async (pullRequest: PullRequestSummary) => {
    if (!(await confirm({
      title: `Mark #${pullRequest.number} ready for review?`,
      detail: `Reviewers will be notified about “${pullRequest.title}”.`,
      confirmLabel: 'Mark ready'
    }))) return
    setActionKey(`ready:${pullRequest.number}`)
    onError(null)
    try {
      if (root == null) throw new Error('The repository tab is no longer open.')
      await requireRepositoryApi().markPullRequestReady(root, pullRequest.number)
      await Promise.all([loadIntegration(true), loadInbox(true)])
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [confirm, loadInbox, loadIntegration, onError, root])

  const openPanel = useCallback(() => {
    setPanelTab('pull-requests')
    setPanelOpen(true)
    void loadIntegration()
    void loadInbox()
  }, [loadIntegration, loadInbox])

  const openBranches = useCallback(() => {
    setPanelTab('branches')
    setPanelOpen(true)
    void loadIntegration()
    void loadInbox()
  }, [loadInbox, loadIntegration])

  const confirmWorkingTreeChange = useCallback(async (action: string): Promise<boolean> => {
    if ((snapshot?.statuses.length ?? 0) === 0) return true
    return confirm({
      title: `Continue with the ${action}?`,
      detail: `The working tree has local changes. Git will stop the ${action} if it would overwrite them.`
    })
  }, [confirm, snapshot?.statuses.length])

  const switchBranch = useCallback(async (name: string) => {
    if (!(await confirmWorkingTreeChange('branch switch'))) return
    setActionKey(`branch:${name}`)
    onError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().switchBranch(name)
      setSubmissionMessage(null)
      applySnapshot(nextSnapshot)
      const nextView = automaticWorkspaceView(nextSnapshot, null)
      focusDesk(firstOpenPathForSnapshot(nextSnapshot), nextView)
      setPanelOpen(false)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [applySnapshot, confirmWorkingTreeChange, focusDesk, onError])

  const openPullRequestReview = useCallback(async (
    selector: number | string,
    repositorySnapshot: RepositorySnapshot | null = snapshot,
    originWorldId = activeReviewWorld?.worldId ?? null,
    options: { refresh?: boolean } = {}
  ): Promise<boolean> => {
    if (repositorySnapshot == null || repositorySnapshot.kind !== 'git') {
      onError('Open a Git repository before opening a pull request.')
      return false
    }
    const generation = ++reviewGenerationRef.current
    const requestId = crypto.randomUUID()
    reviewRequestsRef.current.set(requestId, { root: repositorySnapshot.root, originWorldId })
    setActionKey(`review:${selector}`)
    onError(null)
    // A large review is streamed: its metadata opens the view, then each page of
    // files is appended. Waiting for the whole fetch left the app on a spinner for
    // minutes on pull requests with thousands of files.
    let streamed = false
    let streamDone = false
    let resolveStreamDone: (() => void) | null = null
    const streamDonePromise = new Promise<void>((resolve) => {
      resolveStreamDone = resolve
    })
    let worldId: string | null = null
    const stopListening = requireRepositoryApi().onPullRequestReviewProgress((progress) => {
      if (progress.requestId !== requestId || progress.root !== repositorySnapshot.root) return
      if (!reviewRequestsRef.current.has(requestId)) return
      if (progress.kind === 'metadata') {
        streamed = true
        worldId = openPatchWorld(
          repositorySnapshot,
          progress.review,
          generation,
          true,
          requestId,
          originWorldId
        )
        setSubmissionMessage(null)
        setPanelOpen(false)
        setActionKey((current) => current === `review:${selector}` ? null : current)
        return
      }
      if (worldId == null) return
      if (progress.kind === 'done') {
        streamDone = true
        resolveStreamDone?.()
        setPatchExpectedFileCount(worldId, generation, progress.fileCount)
        return
      }
      if (progress.kind === 'checks') {
        setPatchChecks(worldId, generation, progress.checks, progress.mergeable)
        return
      }
      if (progress.kind === 'revisionAvailable') {
        // The revision watch owns the notice: it raises the banner and adopts the
        // head itself once nobody is reading. A submission message here would be
        // a second, contradictory answer to the same fact.
        return
      }
      appendPatchPage(worldId, generation, progress)
      const firstPath = progress.files[0]?.path
      if (firstPath != null) selectInitialPath(worldId, firstPath)
    })
    try {
      const review = await requireRepositoryApi().getPullRequestReview(
        repositorySnapshot.root,
        selector,
        requestId,
        options.refresh === true
      )
      if (!reviewRequestsRef.current.has(requestId)) return false
      if (streamed) {
        // The resolved review is authoritative: progress events and the reply to
        // this call are separate IPC messages, so a late page can land after the
        // listener is gone. Its patch shares the streamed prefix, so adopting it
        // only costs parsing whatever tail was missed. The expected count becomes
        // what actually arrived — GitHub's own number can exceed what its files API
        // will serve, and nothing is still loading once the fetch has finished.
        if (worldId != null) {
          if (review.patch === '' && review.files.length === 0) {
            if (!streamDone) {
              await Promise.race([
                streamDonePromise,
                new Promise<void>((resolve) => setTimeout(resolve, 5_000))
              ])
            }
            setPatchExpectedFileCount(worldId, generation, review.expectedFileCount)
          } else {
            replacePatchReview(worldId, generation, {
              ...review,
              expectedFileCount: review.files.length
            })
          }
          setPatchLoadStatus(worldId, generation, 'ready')
        }
        return true
      }
      worldId = openPatchWorld(
        repositorySnapshot,
        review,
        generation,
        false,
        requestId,
        originWorldId
      )
      setSubmissionMessage(null)
      setPanelOpen(false)
      return true
    } catch (error) {
      if (!reviewRequestsRef.current.has(requestId)) return false
      const message = getErrorMessage(error)
      // Compare the world being loaded (not the origin tab) with the active
      // world so a failure on tab A cannot paint the banner over tab B.
      const loadingWorldId = worldId ?? originWorldId
      const isForeground = loadingWorldId == null
        || loadingWorldId === activeWorldIdRef.current
      if (isForeground) {
        onError(message)
        setSubmissionMessage(null)
      } else if (worldId != null) {
        setPatchLoadStatus(worldId, generation, 'error', message)
      }
      // The stream is dead either way, so collapse the target onto what actually
      // arrived — otherwise the review sits there looking like it is still loading
      // until the 25 s stall backstop fires.
      if (streamed && worldId != null) {
        setPatchLoadStatus(worldId, generation, 'error', message)
      }
      return false
    } finally {
      stopListening()
      reviewRequestsRef.current.delete(requestId)
      setActionKey((current) => current === `review:${selector}` ? null : current)
    }
  }, [activeReviewWorld, appendPatchPage, onError, openPatchWorld,
    replacePatchReview, selectInitialPath, setPatchChecks, setPatchExpectedFileCount,
    setPatchLoadStatus, snapshot])

  /**
   * A folder opened on a skeleton snapshot picked its view and its first file
   * from an empty status list. Once the git snapshot lands, derive both again —
   * only while the desk for that root is still the tab in front of the reader.
   */
  const resyncDeskNavigation = useCallback((nextSnapshot: RepositorySnapshot) => {
    const active = activeReviewWorld
    if (active == null || active.source !== 'desk' || active.root !== nextSnapshot.root) return
    focusDesk(firstOpenPathForSnapshot(nextSnapshot), automaticWorkspaceView(nextSnapshot, null))
  }, [activeReviewWorld, focusDesk])

  const openPullRequestFromLocator = useCallback(async (pullRequestUrl: string,
    resolvedRoot: string | null = null): Promise<boolean> => {
    const originWorldId = activeReviewWorld?.source === 'new'
      ? activeReviewWorld.worldId
      : openNewWorld()
    // Retargeting this tab abandons whatever it was loading. Without this the old
    // review kept paging — up to eight `gh api` children per wave — against a
    // pull request nobody is going to look at.
    for (const [requestId, request] of reviewRequestsRef.current) {
      if (request.originWorldId !== originWorldId) continue
      reviewRequestsRef.current.delete(requestId)
      requireRepositoryApi().cancelPullRequestReview(request.root, requestId)
    }
    updateNewWorldLocator(pullRequestUrl, originWorldId)
    setNewWorldPending(true, pullRequestUrl, originWorldId)
    setActionKey('resolve:pull-request')
    onError(null)
    try {
      const preferredRoot = resolvedRoot
        ?? (activeReviewWorld?.source === 'new' ? activeReviewWorld.repositoryRoot : null)
      const repositorySnapshot = await requireRepositoryApi()
        .resolvePullRequestRepository(pullRequestUrl, preferredRoot)
      if (repositorySnapshot == null) return false
      if (!hasWorld(originWorldId)) {
        if (!hasRepositoryRoot(repositorySnapshot.root)) {
          await requireRepositoryApi().releaseRepository(repositorySnapshot.root)
        }
        return false
      }
      if (isWorldActive(originWorldId)) {
        await requireRepositoryApi().activateRepository(repositorySnapshot.root)
      }
      await openPullRequestReview(pullRequestUrl, repositorySnapshot, originWorldId)
      return true
    } catch (error) {
      onError(getErrorMessage(error))
      return false
    } finally {
      setNewWorldPending(false, '', originWorldId)
      setActionKey((current) => current === 'resolve:pull-request' ? null : current)
    }
  }, [activeReviewWorld, hasRepositoryRoot, hasWorld, isWorldActive, onError,
    openNewWorld, openPullRequestReview, setNewWorldPending, updateNewWorldLocator])

  const restoreReleasedWorld = useCallback((world: ReviewWorld | null | undefined): void => {
    if (world == null || world.source !== 'patch'
      || world.loadStatus !== 'released' || restoringWorldsRef.current.has(world.worldId)) return
    restoringWorldsRef.current.add(world.worldId)
    if (world.review.kind === 'local') {
      const saved = world.review
      const load = saved.id.startsWith('commit:')
        ? requireRepositoryApi().getCommitReview(saved.headOid)
        : requireRepositoryApi().getLocalSnapshotReview(
            saved.baseOid,
            saved.headOid,
            saved.baseRefName,
            saved.headRefName
          )
      void load.then((review) => {
        replacePatchReview(world.worldId, world.generation, review)
        setPatchLoadStatus(world.worldId, world.generation, 'ready')
      }).catch((error: unknown) => onError(getErrorMessage(error)))
        .finally(() => restoringWorldsRef.current.delete(world.worldId))
      return
    }
    void openPullRequestReview(world.review.pullRequest.url, world.snapshot, world.worldId)
      .finally(() => restoringWorldsRef.current.delete(world.worldId))
  }, [onError, openPullRequestReview, replacePatchReview, setPatchLoadStatus])

  const focusWorld = useCallback(async (worldId: string): Promise<boolean> => {
    const world = reviewWorldList.find((candidate) => candidate.worldId === worldId)
    const focused = await focusRegistryWorld(worldId)
    if (focused) restoreReleasedWorld(world)
    return focused
  }, [focusRegistryWorld, restoreReleasedWorld, reviewWorldList])

  const cycleWorld = useCallback((direction: -1 | 1): void => {
    const activeWorldId = activeReviewWorld?.worldId
    if (activeWorldId == null || reviewWorldList.length < 2) return
    const index = reviewWorldList.findIndex((world) => world.worldId === activeWorldId)
    const nextIndex = (index + direction + reviewWorldList.length) % reviewWorldList.length
    const nextWorld = reviewWorldList[nextIndex]
    if (nextWorld != null) void focusWorld(nextWorld.worldId)
  }, [activeReviewWorld, focusWorld, reviewWorldList])

  const reviewPullRequest = useCallback((pullRequest: PullRequestSummary) => {
    return openPullRequestReview(pullRequest.number)
  }, [openPullRequestReview])

  const openLocalStreamedReview = useCallback(async (
    actionKey: string,
    load: (requestId: string) => Promise<LocalBranchReview>
  ) => {
    if (snapshot == null) return
    const repositorySnapshot = snapshot
    const originWorldId = activeReviewWorld?.worldId ?? null
    const generation = ++reviewGenerationRef.current
    const requestId = crypto.randomUUID()
    setActionKey(actionKey)
    onError(null)
    let streamed = false
    let worldId: string | null = null
    const stopListening = requireRepositoryApi().onLocalReviewProgress((progress: LocalReviewProgress) => {
      if (progress.requestId !== requestId) return
      if (progress.kind === 'metadata') {
        streamed = true
        worldId = openPatchWorld(
          repositorySnapshot,
          progress.review,
          generation,
          true,
          requestId,
          originWorldId
        )
        setSubmissionMessage(null)
        setPanelOpen(false)
        setActionKey((current) => current === actionKey ? null : current)
        return
      }
      if (worldId == null) return
      if (progress.kind === 'done') {
        setPatchExpectedFileCount(worldId, generation, progress.fileCount)
        return
      }
      appendPatchPage(worldId, generation, progress)
      const firstPath = progress.files[0]?.path
      if (firstPath != null) selectInitialPath(worldId, firstPath)
    })
    try {
      const review = await load(requestId)
      if (streamed && worldId != null) {
        setPatchExpectedFileCount(worldId, generation, review.expectedFileCount)
        setPatchLoadStatus(worldId, generation, 'ready')
        return
      }
      openPatchWorld(repositorySnapshot, review, generation, false, requestId, originWorldId)
      setSubmissionMessage(null)
      setPanelOpen(false)
    } catch (error) {
      if (getErrorMessage(error) === COMMAND_ABORTED_MESSAGE) return
      onError(getErrorMessage(error))
      if (streamed && worldId != null) setPatchLoadStatus(worldId, generation, 'error', getErrorMessage(error))
    } finally {
      stopListening()
      setActionKey((current) => current === actionKey ? null : current)
    }
  }, [activeReviewWorld, appendPatchPage, onError, openPatchWorld, selectInitialPath,
    setPatchExpectedFileCount, setPatchLoadStatus, snapshot])

  const reviewLocalBranch = useCallback(async (baseRef: string, headRef: string) => {
    await openLocalStreamedReview(`compare:${headRef}`, (requestId) =>
      requireRepositoryApi().getLocalBranchReview(baseRef, headRef, requestId))
  }, [openLocalStreamedReview])

  const reviewCommit = useCallback(async (oid: string) => {
    await openLocalStreamedReview(`commit:${oid}`, (requestId) =>
      requireRepositoryApi().getCommitReview(oid, requestId))
  }, [openLocalStreamedReview])

  const checkoutPullRequest = useCallback(async (pullRequest: PullRequestSummary) => {
    if (!(await confirmWorkingTreeChange('pull request checkout'))) return
    setActionKey(`checkout:${pullRequest.number}`)
    onError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().checkoutPullRequest(pullRequest.number)
      setSubmissionMessage(null)
      applySnapshot(nextSnapshot)
      const nextView = automaticWorkspaceView(nextSnapshot, null)
      focusDesk(firstOpenPathForSnapshot(nextSnapshot), nextView)
      setPanelOpen(false)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [applySnapshot, confirmWorkingTreeChange, focusDesk, onError])

  const fetchRemote = useCallback(async () => {
    setActionKey('sync:fetch')
    onError(null)
    try {
      writeIntegrationEntry({
        data: await requireRepositoryApi().fetchRemote(),
        fetchedAt: Date.now(),
        root,
        head,
        branch
      })
      void loadInbox(true)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [branch, head, loadInbox, onError, root, writeIntegrationEntry])

  const pullCurrentBranch = useCallback(async () => {
    if (!(await confirmWorkingTreeChange('pull'))) return
    setActionKey('sync:pull')
    onError(null)
    try {
      const nextSnapshot = await requireRepositoryApi().pullCurrentBranch()
      applySnapshot(nextSnapshot)
      const nextView = automaticWorkspaceView(nextSnapshot, null)
      focusDesk(firstOpenPathForSnapshot(nextSnapshot), nextView)
      await Promise.all([loadIntegration(true), loadInbox(true)])
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [applySnapshot, confirmWorkingTreeChange, focusDesk, loadInbox, loadIntegration, onError])

  const pushCurrentBranch = useCallback(async () => {
    setActionKey('sync:push')
    onError(null)
    try {
      writeIntegrationEntry({
        data: await requireRepositoryApi().pushCurrentBranch(),
        fetchedAt: Date.now(),
        root,
        head,
        branch
      })
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [branch, head, onError, root, writeIntegrationEntry])

  const submitReview = useCallback(async (
    reviewEvent: PullRequestReviewEvent,
    body: string,
    comments: PullRequestReviewComment[]
  ): Promise<boolean> => {
    if (repositoryReview?.kind !== 'github' || activeReviewWorld?.source !== 'patch') return false
    if (activeReviewWorld.loadStatus !== 'ready') {
      setSubmissionMessage('Wait for the complete patch before submitting a review.')
      return false
    }
    const pullRequest = repositoryReview.pullRequest
    const selector = repositoryReview.selector
    if (!(await confirm(reviewSubmissionRequest(reviewEvent, pullRequest, comments.length)))) return false

    setSubmittingReview(true)
    setSubmissionMessage(null)
    onError(null)
    try {
      await requireRepositoryApi().submitPullRequestReview(
        activeReviewWorld.root,
        selector,
        repositoryReview.commitId,
        reviewEvent,
        body,
        comments
      )
      // Marked stale rather than cleared: blanking the cache put the panel back
      // on its blocking spinner the next time it opened.
      writeIntegrationEntry({ ...integrationEntryRef.current, fetchedAt: 0 })
      writeInboxEntry({ ...inboxEntryRef.current, fetchedAt: 0 })
      setSubmissionMessage('Review submitted to GitHub.')
      showToast(reviewSubmittedMessage(reviewEvent, pullRequest.number), {
        label: 'View on GitHub',
        run: () => { window.open(pullRequest.url, '_blank', 'noopener') }
      }, { tone: 'success' })
      return true
    } catch (error) {
      onError(getErrorMessage(error))
      return false
    } finally {
      setSubmittingReview(false)
    }
  }, [activeReviewWorld, confirm, onError, repositoryReview,
    writeInboxEntry, writeIntegrationEntry])

  const closeReview = useCallback((worldId?: string) => {
    const target = worldId == null
      ? activeReviewWorld
      : reviewWorldList.find((world) => world.worldId === worldId)
    if (target == null) return
    if (target.source === 'patch' && target.loadStatus === 'loading' && target.requestId != null) {
      // Otherwise up to eight `gh api` children per wave keep paging a patch that
      // is already discarded.
      reviewRequestsRef.current.delete(target.requestId)
      requireRepositoryApi().cancelPullRequestReview(target.root, target.requestId)
    }
    if (target.source === 'new' && target.pending) {
      const roots = new Set<string>()
      for (const [requestId, request] of reviewRequestsRef.current) {
        if (request.originWorldId !== target.worldId) continue
        reviewRequestsRef.current.delete(requestId)
        roots.add(request.root)
        requireRepositoryApi().cancelPullRequestReview(request.root, requestId)
      }
      for (const root of roots) {
        const rootStillLoading = [...reviewRequestsRef.current.values()].some((request) => request.root === root)
        if (!rootStillLoading && !hasRepositoryRoot(root)) {
          void requireRepositoryApi().releaseRepository(root)
        }
      }
    }
    const closingActive = activeReviewWorld?.worldId === target.worldId
    const targetIndex = reviewWorldList.findIndex((world) => world.worldId === target.worldId)
    const remainingWorlds = reviewWorldList.filter((world) => world.worldId !== target.worldId)
    const nextWorld = closingActive
      ? remainingWorlds[targetIndex - 1] ?? remainingWorlds[targetIndex]
      : null
    if (closingActive) setSubmissionMessage(null)
    void closeWorld(target.worldId).then((closed) => {
      if (closed) restoreReleasedWorld(nextWorld)
    })
  }, [activeReviewWorld, closeWorld, hasRepositoryRoot, restoreReleasedWorld, reviewWorldList])

  // While the panel is open a commit or a branch switch made in the terminal
  // invalidates the entry, so ahead/behind and the branch list stop being a
  // snapshot of whenever the panel was last opened.
  useEffect(() => {
    if (!panelOpen) return
    void loadIntegration()
    void loadInbox()
  }, [branch, head, loadInbox, loadIntegration, panelOpen])

  // A review still streaming has no descriptor to restore from, so hibernating
  // mid-flight would lose the stream rather than release a payload.
  const hibernateReviews = useCallback((): string | null => {
    if (reviewRequestsRef.current.size > 0) return 'a review is still loading'
    hibernateWorlds()
    return null
  }, [hibernateWorlds])

  return useMemo(() => ({
    hibernateReviews,
    panelOpen,
    panelTab,
    setPanelOpen,
    integration,
    integrationFetchedAt: integrationEntry.fetchedAt === 0 ? null : integrationEntry.fetchedAt,
    loadingIntegration,
    inbox,
    loadingInbox,
    refreshPanelData,
    actionKey,
    worlds: reviewWorldList,
    activeWorld: activeReviewWorld,
    initialReviewScrollTop,
    repositoryReview,
    submittingReview,
    submissionMessage,
    reset,
    loadIntegration,
    openPanel,
    openBranches,
    switchBranch,
    reviewPullRequest,
    openPullRequestReview,
    openPullRequestFromLocator,
    resyncDeskNavigation,
    openNewWorld,
    updateNewWorldLocator,
    updateNewWorldRepositoryRoot,
    reviewFolderName: reviewFolder.name,
    reviewFolderPath: reviewFolder.path,
    chooseReviewFolder,
    openWorkingTree: openDeskWorld,
    syncRepositorySnapshot,
    reviewLocalBranch,
    reviewCommit,
    checkoutPullRequest,
    fetchRemote,
    pullCurrentBranch,
    pushCurrentBranch,
    submitReview,
    closeReview,
    focusWorld,
    cycleWorld,
    rememberReviewScroll,
    mergePullRequest,
    markPullRequestReady
  }), [
    actionKey,
    activeReviewWorld,
    cycleWorld,
    hibernateReviews,
    focusWorld,
    initialReviewScrollTop,
    openDeskWorld,
    openNewWorld,
    rememberReviewScroll,
    chooseReviewFolder,
    reviewFolder.name,
    reviewFolder.path,
    syncRepositorySnapshot,
    updateNewWorldLocator,
    updateNewWorldRepositoryRoot,
    reviewWorldList,
    integrationEntry.fetchedAt,
    refreshPanelData,
    checkoutPullRequest,
    closeReview,
    fetchRemote,
    inbox,
    integration,
    loadIntegration,
    loadingInbox,
    loadingIntegration,
    markPullRequestReady,
    mergePullRequest,
    openPanel,
    openBranches,
    openPullRequestReview,
    openPullRequestFromLocator,
    resyncDeskNavigation,
    panelOpen,
    panelTab,
    pullCurrentBranch,
    pushCurrentBranch,
    repositoryReview,
    reset,
    reviewCommit,
    reviewLocalBranch,
    reviewPullRequest,
    submissionMessage,
    submitReview,
    submittingReview,
    switchBranch
  ])
}
