import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  COMMAND_ABORTED_MESSAGE,
  type CommitRequest,
  type GitIntegrationSnapshot,
  type LocalBranchReview,
  type LocalReviewProgress,
  type PullRequestFolderPreview,
  type PullRequestInboxSnapshot,
  type PullRequestMergeStrategy,
  type PullRequestReviewComment,
  type PullRequestReviewEvent,
  type PullRequestSummary,
  type RepositoryPullRequests,
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
import { createStreamCompletion } from '../review/streamCompletion'
import { useReviewWorlds, type ReviewWorld } from '../review/useReviewWorlds'
import { sensitiveNewFiles } from './sensitiveFiles'

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

export type RepositoryPanelTab = 'changes' | 'history' | 'branches' | 'remotes' | 'pull-requests'

export interface CommitOptions extends CommitRequest {
  /** Push the branch once the commit lands. */
  push?: boolean
}

const NO_PULL_REQUESTS: RepositoryPullRequests = { pullRequests: [], githubAvailable: true, githubMessage: null }

function pullRequestFields(data: GitIntegrationSnapshot | null): RepositoryPullRequests {
  if (data == null) return NO_PULL_REQUESTS
  return { pullRequests: data.pullRequests, githubAvailable: data.githubAvailable, githubMessage: data.githubMessage }
}

// Electron prefixes a rejected invoke's message with the channel it came from.
function isCommandAborted(error: unknown): boolean {
  return getErrorMessage(error).includes(COMMAND_ABORTED_MESSAGE)
}

/**
 * A rejected list is an answer too. Dropping it left the placeholder in place,
 * which reads as "GitHub answered with no pull requests" rather than "GitHub
 * did not answer". A cancelled one is not: it resolves null, and the last
 * answer stands.
 */
function requestPullRequests(api: ReturnType<typeof requireRepositoryApi>): Promise<RepositoryPullRequests | null> {
  return api.getRepositoryPullRequests().catch((error: unknown) => isCommandAborted(error)
    ? null
    : { pullRequests: [], githubAvailable: false, githubMessage: getErrorMessage(error) })
}

interface SnapshotIdentity {
  root: string | null
  head: string | null
  branch: string | null
}

function requireOpenRoot(root: string | null): string {
  if (root == null) throw new Error('The repository tab is no longer open.')
  return root
}

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
  const [panelTab, setPanelTab] = useState<RepositoryPanelTab>('changes')
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
  // What the reader is looking at now. A write that lands after an await — the
  // push behind a commit, a stage queued behind a tab switch — reads this, not
  // the render that started it, which still names the old head or repository.
  const viewedRef = useRef<SnapshotIdentity>({ root, head, branch })
  useEffect(() => {
    viewedRef.current = { root, head, branch }
  })
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

  /**
   * Paints the snapshot a Source Control write answered with, unless the reader
   * has since moved to another repository: applying it there would swap the tab
   * in front back to the one the write was for. Resolves false in that case so
   * the caller leaves the reader's view alone too.
   */
  const adoptSnapshot = useCallback((next: RepositorySnapshot): boolean => {
    if (next.root !== viewedRef.current.root) return false
    viewedRef.current = { root: next.root, head: next.head ?? null, branch: next.branch ?? null }
    applySnapshot(next)
    return true
  }, [applySnapshot])

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

  /**
   * Local git answers in tens of milliseconds; `gh pr list` takes seconds. The
   * two are asked for together and written as they land, so branches, history
   * and ahead/behind paint straight away and the pull request list keeps the
   * previous answer until the new one arrives instead of blanking.
   */
  const integrationRunRef = useRef(0)
  const writeLocalIntegration = useCallback((local: GitIntegrationSnapshot, forRoot: string | null) => {
    const viewed = viewedRef.current
    // The cache holds one repository; an answer for one no longer in front
    // would evict the entry of the one that is.
    if (viewed.root !== forRoot) return
    const previous = integrationEntryRef.current
    // Local git cannot know whether GitHub answers, so its GitHub fields are
    // placeholders: the last pull request answer for this root stands instead.
    const carried = previous.root === forRoot ? pullRequestFields(previous.data) : NO_PULL_REQUESTS
    writeIntegrationEntry({ data: { ...local, ...carried }, fetchedAt: Date.now(), ...viewed })
  }, [writeIntegrationEntry])

  const writePullRequests = useCallback((pullRequests: RepositoryPullRequests | null, forRoot: string | null) => {
    const current = integrationEntryRef.current
    if (pullRequests == null || current.data == null || current.root !== forRoot) return
    writeIntegrationEntry({ ...current, data: { ...current.data, ...pullRequests } })
  }, [writeIntegrationEntry])

  const loadIntegration = useCallback(async (force = false) => {
    if (!force && !isPanelDataStale(integrationEntryRef.current, { root, head, branch }, Date.now())) return
    const run = ++integrationRunRef.current
    setLoadingIntegration(true)
    onError(null)
    const api = requireRepositoryApi()
    const pullRequestsPromise = requestPullRequests(api)
    try {
      writeLocalIntegration(await api.getGitIntegration({ pullRequests: false }), root)
      writePullRequests(await pullRequestsPromise, root)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      if (run === integrationRunRef.current) setLoadingIntegration(false)
    }
  }, [branch, head, onError, root, writeLocalIntegration, writePullRequests])

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

  // Reopening lands on whichever tab was in use last time.
  const openPanel = useCallback(() => {
    setPanelOpen(true)
    void loadIntegration()
    void loadInbox()
  }, [loadIntegration, loadInbox])

  const openSourceControl = useCallback(() => {
    setPanelTab('changes')
    setPanelOpen(true)
    void loadIntegration()
    void loadInbox()
  }, [loadInbox, loadIntegration])

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

  // Stage, unstage, discard and commit all write the index, so they run one at
  // a time in the order they were asked for; a stage clicked mid-commit used to
  // run `git add` beside `git commit`. The panel shows each stage optimistically
  // and the returned snapshot confirms it. Stage, unstage and discard take no
  // `actionKey`, so a burst of clicks never greys out the rest of the panel —
  // which also leaves Switch, Pull and Checkout live while a `git add` runs.
  // Those rewrite HEAD and the index too, and main holds no lock of its own, so
  // they queue here as well instead of racing the stage into `index.lock`.
  const indexQueueRef = useRef<Promise<unknown> | null>(null)
  const enqueueIndexWrite = useCallback(<Value,>(write: () => Promise<Value>): Promise<Value> => {
    const next = (indexQueueRef.current ?? Promise.resolve()).then(write)
    // A failed write must not wedge the ones queued behind it.
    indexQueueRef.current = next.catch(() => {})
    return next
  }, [])

  const switchBranch = useCallback(async (name: string) => {
    // Taken before the confirmation, which a tab switch can outlast.
    const forRoot = root
    if (!(await confirmWorkingTreeChange('branch switch'))) return
    setActionKey(`branch:${name}`)
    onError(null)
    try {
      const target = requireOpenRoot(forRoot)
      const nextSnapshot = await enqueueIndexWrite(() => requireRepositoryApi().switchBranch(target, name))
      if (!adoptSnapshot(nextSnapshot)) return
      setSubmissionMessage(null)
      const nextView = automaticWorkspaceView(nextSnapshot, null)
      focusDesk(firstOpenPathForSnapshot(nextSnapshot), nextView)
      setPanelOpen(false)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [adoptSnapshot, confirmWorkingTreeChange, enqueueIndexWrite, focusDesk, onError, root])

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
    const completion = createStreamCompletion()
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
      if (progress.kind === 'done') completion.markDone()
      if (worldId == null) return
      if (progress.kind === 'done') {
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
      // A streamed reply carries no files, and it can overtake the metadata and
      // pages sent before it (see streamCompletion): opening it as it is showed
      // an empty review. A stripped reply still says how many files it stands for,
      // so a pull request that really has none is not held for the timeout.
      if (review.patch === '' && review.files.length === 0 && review.expectedFileCount > 0) {
        await completion.wait()
      }
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

  // ⌘1–⌘8 pick that tab, ⌘9 the last one, as in a browser.
  const focusWorldAt = useCallback((position: number): void => {
    const world = position >= 9 ? reviewWorldList.at(-1) : reviewWorldList[position - 1]
    if (world != null && world.worldId !== activeReviewWorld?.worldId) void focusWorld(world.worldId)
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
    const completion = createStreamCompletion()
    let worldId: string | null = null
    const stopListening = requireRepositoryApi().onLocalReviewProgress((progress: LocalReviewProgress) => {
      if (progress.requestId !== requestId) return
      if (progress.kind === 'done') completion.markDone()
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
      // A streamed reply carries no patch, and pages sent before it can still be
      // on their way (see streamCompletion). Stopping the listener here dropped
      // them: the review stopped at whatever had arrived. A review with no files
      // has nothing on its way.
      if (review.patch === '' && (review.files.length > 0 || review.expectedFileCount > 0)) {
        await completion.wait()
      }
      if (streamed && worldId != null) {
        setPatchExpectedFileCount(worldId, generation, review.expectedFileCount)
        setPatchLoadStatus(worldId, generation, 'ready')
        return
      }
      openPatchWorld(repositorySnapshot, review, generation, false, requestId, originWorldId)
      setSubmissionMessage(null)
      setPanelOpen(false)
    } catch (error) {
      if (isCommandAborted(error)) return
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
    const forRoot = root
    if (!(await confirmWorkingTreeChange('pull request checkout'))) return
    setActionKey(`checkout:${pullRequest.number}`)
    onError(null)
    try {
      const target = requireOpenRoot(forRoot)
      const nextSnapshot = await enqueueIndexWrite(() =>
        requireRepositoryApi().checkoutPullRequest(target, pullRequest.number))
      if (!adoptSnapshot(nextSnapshot)) return
      setSubmissionMessage(null)
      const nextView = automaticWorkspaceView(nextSnapshot, null)
      focusDesk(firstOpenPathForSnapshot(nextSnapshot), nextView)
      setPanelOpen(false)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [adoptSnapshot, confirmWorkingTreeChange, enqueueIndexWrite, focusDesk, onError, root])

  const fetchRemote = useCallback(async () => {
    setActionKey('sync:fetch')
    onError(null)
    try {
      const forRoot = requireOpenRoot(root)
      const api = requireRepositoryApi()
      writeLocalIntegration(await api.fetchRemote(forRoot), forRoot)
      // The fetch already answered with local git; only the GitHub half is
      // still worth asking for. A forced reload here ran `git log`, refs and
      // ahead/behind a second time for the same click.
      void requestPullRequests(api).then((pullRequests) => writePullRequests(pullRequests, forRoot))
      void loadInbox(true)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [loadInbox, onError, root, writeLocalIntegration, writePullRequests])

  const pullCurrentBranch = useCallback(async () => {
    const forRoot = root
    if (!(await confirmWorkingTreeChange('pull'))) return
    setActionKey('sync:pull')
    onError(null)
    try {
      const target = requireOpenRoot(forRoot)
      const nextSnapshot = await enqueueIndexWrite(() => requireRepositoryApi().pullCurrentBranch(target))
      if (!adoptSnapshot(nextSnapshot)) return
      const nextView = automaticWorkspaceView(nextSnapshot, null)
      focusDesk(firstOpenPathForSnapshot(nextSnapshot), nextView)
      await Promise.all([loadIntegration(true), loadInbox(true)])
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setActionKey(null)
    }
  }, [adoptSnapshot, confirmWorkingTreeChange, enqueueIndexWrite, focusDesk, loadInbox, loadIntegration, onError, root])

  const pushCurrentBranch = useCallback(async (): Promise<boolean> => {
    setActionKey('sync:push')
    onError(null)
    try {
      const forRoot = requireOpenRoot(root)
      writeLocalIntegration(await requireRepositoryApi().pushCurrentBranch(forRoot), forRoot)
      return true
    } catch (error) {
      onError(getErrorMessage(error))
      return false
    } finally {
      setActionKey(null)
    }
  }, [onError, root, writeLocalIntegration])

  const runIndexOperation = useCallback((
    forRoot: string | null,
    operation: (api: ReturnType<typeof requireRepositoryApi>, root: string) => Promise<RepositorySnapshot>
  ): Promise<boolean> => enqueueIndexWrite(async () => {
    try {
      adoptSnapshot(await operation(requireRepositoryApi(), requireOpenRoot(forRoot)))
      return true
    } catch (error) {
      onError(getErrorMessage(error))
      return false
    }
  }), [adoptSnapshot, enqueueIndexWrite, onError])

  /**
   * Resolves false when the reader backs out of adding a new file that looks
   * like it holds a secret. Asked before anything moves, so a cancelled stage
   * never flickers the rows.
   */
  const statuses = snapshot?.statuses
  const confirmSensitiveStage = useCallback(async (paths: readonly string[] | null): Promise<boolean> => {
    const flagged = sensitiveNewFiles(statuses ?? [], paths == null ? null : new Set(paths))
    if (flagged.length === 0) return true
    const names = flagged.slice(0, 3).map((path) => path.split('/').pop()).join(', ')
    const more = flagged.length > 3 ? ` and ${flagged.length - 3} more` : ''
    return confirm({
      title: flagged.length === 1 ? 'Stage a file that may hold secrets?' : `Stage ${flagged.length} files that may hold secrets?`,
      detail: `${names}${more} ${flagged.length === 1 ? 'is' : 'are'} new to Git and named like credentials. Once pushed, a secret stays in history even if the file is removed later.`,
      confirmLabel: 'Stage Anyway',
      tone: 'warning'
    })
  }, [confirm, statuses])

  const stagePaths = useCallback((paths: readonly string[]) =>
    runIndexOperation(root, (api, forRoot) => api.stagePaths(forRoot, paths)), [root, runIndexOperation])
  const unstagePaths = useCallback((paths: readonly string[]) =>
    runIndexOperation(root, (api, forRoot) => api.unstagePaths(forRoot, paths)), [root, runIndexOperation])
  const discardPaths = useCallback(async (paths: readonly string[], untrackedCount: number): Promise<boolean> => {
    // The paths belong to this repository. Taken before the confirmation: a tab
    // switched while it is up used to receive the discard instead.
    const forRoot = root
    const count = paths.length
    const subject = count === 1 ? `“${paths[0]!.split('/').pop()}”` : `${count} files`
    if (!(await confirm({
      title: `Discard changes to ${subject}?`,
      detail: untrackedCount > 0
        ? `${untrackedCount === count ? 'Untracked files are' : `${untrackedCount} untracked ${untrackedCount === 1 ? 'file is' : 'files are'}`} deleted. Unstaged edits are lost. This cannot be undone.`
        : 'Unstaged edits are lost. Staged changes stay. This cannot be undone.',
      confirmLabel: 'Discard',
      destructive: true
    }))) return false
    return runIndexOperation(forRoot, (api, target) => api.discardPaths(target, paths))
  }, [confirm, root, runIndexOperation])

  const commitChanges = useCallback(async ({ push = false, ...request }: CommitOptions): Promise<boolean> => {
    const forRoot = root
    if (request.all === true && !(await confirmSensitiveStage(null))) return false
    setActionKey('scm:commit')
    onError(null)
    try {
      const target = requireOpenRoot(forRoot)
      const nextSnapshot = await enqueueIndexWrite(() => requireRepositoryApi().commitChanges(target, request))
      adoptSnapshot(nextSnapshot)
      const subject = request.message.trim().split('\n')[0] ?? ''
      const shortHead = nextSnapshot.head?.slice(0, 7) ?? ''
      const summary = `${request.amend === true ? 'Amended' : 'Committed'} ${shortHead}${subject === '' ? '' : ` · ${subject}`}`
      if (push) {
        setActionKey('sync:push')
        writeLocalIntegration(await requireRepositoryApi().pushCurrentBranch(target), target)
        showToast(`${summary} — pushed`, undefined, { tone: 'success' })
      } else {
        showToast(summary, undefined, { tone: 'success' })
      }
      return true
    } catch (error) {
      onError(getErrorMessage(error))
      return false
    } finally {
      setActionKey(null)
    }
  }, [adoptSnapshot, confirmSensitiveStage, enqueueIndexWrite, onError, root, writeLocalIntegration])

  const openChangedFile = useCallback((path: string) => {
    focusDesk(path, 'multi')
    setPanelOpen(false)
  }, [focusDesk])

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
    setPanelTab,
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
    openSourceControl,
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
    stagePaths,
    confirmSensitiveStage,
    unstagePaths,
    discardPaths,
    commitChanges,
    openChangedFile,
    submitReview,
    closeReview,
    focusWorld,
    cycleWorld,
    focusWorldAt,
    rememberReviewScroll,
    mergePullRequest,
    markPullRequestReady
  }), [
    actionKey,
    activeReviewWorld,
    cycleWorld,
    focusWorldAt,
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
    openSourceControl,
    openBranches,
    openPullRequestReview,
    openPullRequestFromLocator,
    resyncDeskNavigation,
    panelOpen,
    panelTab,
    pullCurrentBranch,
    pushCurrentBranch,
    stagePaths,
    confirmSensitiveStage,
    unstagePaths,
    discardPaths,
    commitChanges,
    openChangedFile,
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
