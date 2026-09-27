import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type {
  PullRequestChecks,
  PullRequestReviewProgress,
  RepositoryReview,
  RepositorySnapshot,
  RepositoryStatusEntry
} from '../../../shared/contracts'
import { githubRepoSlugFromPullRequestUrl } from '../../../shared/pullRequestUrl'
import type { WorkspaceView } from '../app/AppView'
import { automaticWorkspaceView, firstOpenPathForSnapshot } from '../explorer/workspaceMode'
import { worldViewCache } from './worldViewCache'

export interface WorldNavigation {
  selectedPath: string | null
  workspaceView: WorkspaceView
  reviewScrollTop: number
}

export interface NewWorld {
  source: 'new'
  worldId: string
  label: string
  locator: string
  pending: boolean
  repositoryRoot: string | null
}

export interface DeskWorld {
  source: 'desk'
  worldId: string
  label: string
  root: string
  snapshot: RepositorySnapshot
  baselineOid: string | null
  workingRevision: number
}

export interface PatchWorld {
  source: 'patch'
  worldId: string
  label: string
  root: string
  snapshot: RepositorySnapshot
  baseOid: string
  headOid: string
  generation: number
  requestId: string | null
  loadStatus: 'loading' | 'ready' | 'stopped' | 'error' | 'released'
  errorMessage: string | null
  review: RepositoryReview
  patchPages: readonly string[]
  patchLength: number
}

export type ReviewWorld = NewWorld | DeskWorld | PatchWorld

export interface WorldRegistryState {
  worlds: ReviewWorld[]
  activeWorldId: string | null
}

export function worldHasActiveRepositorySession(
  world: ReviewWorld,
  state: WorldRegistryState
): boolean {
  if (world.source === 'new') return false
  const active = state.worlds.find((candidate) => candidate.worldId === state.activeWorldId)
  return active != null && active.source !== 'new' && active.root === world.root
}

type WorldRegistryAction =
  | { type: 'reset'; world: NewWorld }
  | { type: 'new-tab'; world: NewWorld }
  | { type: 'update-locator'; worldId: string; locator: string }
  | { type: 'update-repository-root'; worldId: string; root: string | null }
  | { type: 'set-new-pending'; worldId: string; pending: boolean; label: string }
  | { type: 'open-desk'; snapshot: RepositorySnapshot }
  | { type: 'sync-repository'; snapshot: RepositorySnapshot }
  | {
      type: 'open-patch'
      world: PatchWorld
      originWorldId: string | null
      supersedesWorldId?: string | null
    }
  | {
      type: 'append-patch-page'
      worldId: string
      generation: number
      progress: Extract<PullRequestReviewProgress, { kind: 'files' }>
    }
  | { type: 'replace-patch'; worldId: string; generation: number; review: RepositoryReview }
  | { type: 'replace-patch-head'; worldId: string; generation: number; review: RepositoryReview }
  | { type: 'set-patch-expected-file-count'; worldId: string; generation: number; fileCount: number }
  | {
      type: 'set-patch-checks'
      worldId: string
      generation: number
      checks: PullRequestChecks | null
      mergeable: string | null
    }
  | {
      type: 'set-patch-status'
      worldId: string
      generation: number
      loadStatus: PatchWorld['loadStatus']
      errorMessage?: string | null
    }
  | { type: 'hibernate' }
  | { type: 'focus'; worldId: string }
  | { type: 'close'; worldId: string; nextWorld: ReviewWorld }

let newWorldSequence = 0
// Four real 141–164-file PR tabs used 24.3 MB more working set than one active
// PR. Keep a 64 MB inactive-text ceiling so unusually large reviews cannot grow
// without bound while normal tabs stay hot.
export const MAX_INACTIVE_PATCH_BYTES = 64 * 1024 * 1024

export function createNewWorld(): NewWorld {
  newWorldSequence += 1
  return {
    source: 'new',
    worldId: `new:${newWorldSequence}`,
    label: 'New tab',
    locator: '',
    pending: false,
    repositoryRoot: null
  }
}

export function newWorldHoldsReview(world: ReviewWorld | null | undefined): boolean {
  return world?.source === 'new' && (world.pending || world.locator.trim() !== '')
}

export function initialWorldRegistry(snapshot: RepositorySnapshot | null): WorldRegistryState {
  if (snapshot != null) {
    return reduceWorldRegistry({ worlds: [], activeWorldId: null }, { type: 'open-desk', snapshot })
  }
  const world = createNewWorld()
  return { worlds: [world], activeWorldId: world.worldId }
}

function workingTreeWorld(snapshot: RepositorySnapshot, previous?: DeskWorld): DeskWorld {
  return {
    source: 'desk',
    worldId: `desk:${snapshot.root}`,
    label: snapshot.name,
    root: snapshot.root,
    snapshot,
    baselineOid: snapshot.head,
    workingRevision: previous == null ? 0 : previous.workingRevision + 1
  }
}

// A tab names the repository, not its owner: `owner/repo` pushed the part that
// tells two tabs apart — the number and the repo — behind the ellipsis. The
// owner is still in the tab's tooltip through the pull request URL and title.
function repositoryLabel(review: RepositoryReview, fallback: string): string {
  if (review.kind !== 'github') return fallback
  const match = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/\d+/i.exec(review.pullRequest.url)
  return match?.[1] ?? fallback
}

/** What a patch world is *of*, independent of the commits it was opened at. */
export function patchReviewIdentity(review: RepositoryReview): string {
  return review.kind === 'github' ? review.pullRequest.url : review.id
}

export function patchWorldId(review: RepositoryReview): string {
  return `patch:${patchReviewIdentity(review)}:${review.baseOid}:${review.headOid}`
}

function patchWorldLabel(snapshot: RepositorySnapshot, review: RepositoryReview): string {
  if (review.kind === 'github') {
    return `#${review.pullRequest.number} · ${repositoryLabel(review, snapshot.name)}`
  }
  return `${review.headRefName} · ${snapshot.name}`
}

export function createPatchWorld(
  snapshot: RepositorySnapshot,
  review: RepositoryReview,
  generation: number,
  loadStatus: PatchWorld['loadStatus'],
  requestId: string | null = null
): PatchWorld {
  const patchPages = review.patchPages ?? (review.patch === '' ? [] : [review.patch])
  return {
    source: 'patch',
    worldId: patchWorldId(review),
    label: patchWorldLabel(snapshot, review),
    root: snapshot.root,
    snapshot,
    baseOid: review.baseOid,
    headOid: review.headOid,
    generation,
    requestId,
    loadStatus,
    errorMessage: null,
    review,
    patchPages,
    patchLength: review.patch.length
  }
}

function insertContentWorld(
  state: WorldRegistryState,
  world: ReviewWorld,
  originWorldId = state.activeWorldId,
  supersedesWorldId: string | null = null
): WorldRegistryState {
  // A superseded tab that is in front stays in front: `activeWorldId` must never
  // be left pointing at the world this replaced.
  const focus = state.activeWorldId === originWorldId
    || (supersedesWorldId != null && state.activeWorldId === supersedesWorldId)
  const existingIndex = state.worlds.findIndex((candidate) => candidate.worldId === world.worldId
    || (supersedesWorldId != null && candidate.worldId === supersedesWorldId))
  if (existingIndex >= 0) {
    const worlds = [...state.worlds]
    worlds[existingIndex] = world
    return { worlds, activeWorldId: focus ? world.worldId : state.activeWorldId }
  }
  const originIndex = state.worlds.findIndex((candidate) => candidate.worldId === originWorldId)
  if (state.worlds[originIndex]?.source === 'new') {
    const worlds = [...state.worlds]
    worlds[originIndex] = world
    return { worlds, activeWorldId: focus ? world.worldId : state.activeWorldId }
  }
  return { worlds: [...state.worlds, world], activeWorldId: focus ? world.worldId : state.activeWorldId }
}

function updatePatchWorld(
  state: WorldRegistryState,
  worldId: string,
  generation: number,
  update: (world: PatchWorld) => PatchWorld
): WorldRegistryState {
  const index = state.worlds.findIndex((world) => world.worldId === worldId)
  const world = state.worlds[index]
  if (index < 0 || world?.source !== 'patch' || world.generation !== generation) return state
  const updatedWorld = update(world)
  if (updatedWorld === world) return state
  const worlds = [...state.worlds]
  worlds[index] = updatedWorld
  return { ...state, worlds }
}

export function reviewPayloadBytes(
  world: PatchWorld,
  cachedGraphBytes = 0
): number {
  // Git patches are overwhelmingly ASCII, which V8 stores as one-byte strings.
  // Kept-mounted tabs also retain the parsed CodeView item graph; charge that
  // separately so the 64 MB evictor matches what is actually in memory.
  return world.patchLength
    + world.review.files.reduce((bytes, file) => bytes + file.path.length * 2 + 64, 0)
    + world.review.omittedFiles.reduce((bytes, file) => bytes + file.path.length * 2 + 64, 0)
    + cachedGraphBytes
}

/**
 * The released form of a world: payload gone, identity and reload descriptor
 * kept. Both the byte evictor and hibernation produce exactly this, so a world
 * released either way restores through the same path.
 */
function releasedWorld(world: PatchWorld): PatchWorld {
  return {
    ...world,
    loadStatus: 'released',
    requestId: null,
    patchPages: [],
    patchLength: 0,
    review: { ...world.review, files: [], patch: '', omittedFiles: [] }
  }
}

/**
 * Deep hibernation: release every review payload the app is holding, the
 * focused one included, because a snoozed window is not showing any of them.
 * A world still streaming is left alone — it has no descriptor to restore from
 * mid-flight — and so is anything already released.
 *
 * Callers are responsible for the safety gate. This function knows nothing
 * about unsaved edits, terminal jobs or agent turns; it must not be reached
 * while any of them are live.
 */
export function hibernateWorldPayloads(state: WorldRegistryState): WorldRegistryState {
  let changed = false
  const worlds = state.worlds.map((world) => {
    if (world.source !== 'patch' || world.loadStatus !== 'ready') return world
    changed = true
    return releasedWorld(world)
  })
  return changed ? { ...state, worlds } : state
}

export function boundInactivePatchPayloads(
  state: WorldRegistryState,
  maxBytes = MAX_INACTIVE_PATCH_BYTES,
  cachedGraphBytes: (worldId: string) => number = () => 0
): WorldRegistryState {
  let retainedBytes = 0
  let changed = false
  const worlds = [...state.worlds]
  for (let index = worlds.length - 1; index >= 0; index -= 1) {
    const world = worlds[index]
    if (world == null || world.source !== 'patch'
      || world.worldId === state.activeWorldId
      // Loading worlds are skipped: they have no restore path yet, and
      // charging them would evict a stream that cannot be rebuilt mid-flight.
      // A skipped world is neither evicted nor added to retainedBytes.
      || world.loadStatus === 'loading'
      || world.loadStatus === 'released') continue
    const payloadBytes = reviewPayloadBytes(world, cachedGraphBytes(world.worldId))
    if (retainedBytes + payloadBytes <= maxBytes) {
      retainedBytes += payloadBytes
      continue
    }
    changed = true
    worlds[index] = releasedWorld(world)
  }
  return changed ? { ...state, worlds } : state
}

const PAYLOAD_AFFECTING_ACTIONS: ReadonlySet<WorldRegistryAction['type']> = new Set([
  'new-tab',
  'open-desk',
  'open-patch',
  'append-patch-page',
  'replace-patch',
  'replace-patch-head',
  'set-patch-status',
  'focus',
  'close'
])

export function actionMayChangeInactivePatchBudget(type: WorldRegistryAction['type']): boolean {
  return PAYLOAD_AFFECTING_ACTIONS.has(type)
}

export function reduceWorldRegistry(
  state: WorldRegistryState,
  action: WorldRegistryAction
): WorldRegistryState {
  if (action.type === 'reset') return { worlds: [action.world], activeWorldId: action.world.worldId }
  if (action.type === 'hibernate') return hibernateWorldPayloads(state)
  if (action.type === 'new-tab') {
    return { worlds: [...state.worlds, action.world], activeWorldId: action.world.worldId }
  }
  if (action.type === 'update-locator') {
    const worlds = state.worlds.map((world) => {
      if (world.worldId !== action.worldId || world.source !== 'new') return world
      const previousSlug = githubRepoSlugFromPullRequestUrl(world.locator)
      const nextSlug = githubRepoSlugFromPullRequestUrl(action.locator)
      const keepFolder = previousSlug == null || nextSlug == null || previousSlug === nextSlug
      return {
        ...world,
        locator: action.locator,
        repositoryRoot: keepFolder ? world.repositoryRoot : null
      }
    })
    return { ...state, worlds }
  }
  if (action.type === 'update-repository-root') {
    const worlds = state.worlds.map((world) => world.worldId === action.worldId && world.source === 'new'
      ? { ...world, repositoryRoot: action.root }
      : world)
    return { ...state, worlds }
  }
  if (action.type === 'set-new-pending') {
    const worlds = state.worlds.map((world) => world.worldId === action.worldId && world.source === 'new'
      ? { ...world, pending: action.pending, label: action.label }
      : world)
    return { ...state, worlds }
  }
  if (action.type === 'open-desk') {
    const worldId = `desk:${action.snapshot.root}`
    const existing = state.worlds.find((world): world is DeskWorld => world.worldId === worldId && world.source === 'desk')
    const desk = workingTreeWorld(action.snapshot, existing)
    const active = state.worlds.find((world) => world.worldId === state.activeWorldId)
    if (newWorldHoldsReview(active)) {
      if (existing != null) {
        const worlds = state.worlds.map((world) => world.worldId === worldId ? desk : world)
        return { worlds, activeWorldId: state.activeWorldId }
      }
      return { worlds: [desk, ...state.worlds], activeWorldId: state.activeWorldId }
    }
    return insertContentWorld(state, desk)
  }
  if (action.type === 'sync-repository') {
    let changed = false
    const worlds = state.worlds.map((world) => {
      if (world.source === 'new' || world.root !== action.snapshot.root) return world
      if (world.snapshot === action.snapshot) return world
      changed = true
      return world.source === 'desk'
        ? workingTreeWorld(action.snapshot, world)
        : { ...world, snapshot: action.snapshot }
    })
    return changed ? { ...state, worlds } : state
  }
  if (action.type === 'open-patch') {
    return insertContentWorld(state, action.world, action.originWorldId, action.supersedesWorldId ?? null)
  }
  if (action.type === 'append-patch-page') {
    return updatePatchWorld(state, action.worldId, action.generation, (world) => {
      const selector = world.review.kind === 'github' ? world.review.selector : world.review.id
      if (selector !== action.progress.selector) return world
      return {
        ...world,
        patchPages: [...world.patchPages, action.progress.patch],
        patchLength: world.patchLength + action.progress.patch.length,
        review: {
          ...world.review,
          files: [...world.review.files, ...action.progress.files],
          omittedFiles: [...world.review.omittedFiles, ...action.progress.omittedFiles]
        }
      }
    })
  }
  if (action.type === 'replace-patch') {
    return updatePatchWorld(state, action.worldId, action.generation, (world) =>
      patchWorldId(action.review) === world.worldId
        ? {
            ...world,
            review: action.review,
            patchPages: action.review.patch === '' ? [] : [action.review.patch],
            patchLength: action.review.patch.length
          }
        : world)
  }
  if (action.type === 'replace-patch-head') {
    // The pull request was force pushed while it was open. The tab keeps its id —
    // the loader that is still running holds it — but everything derived from the
    // commits it was opened at is replaced.
    return updatePatchWorld(state, action.worldId, action.generation, (world) =>
      patchReviewIdentity(action.review) === patchReviewIdentity(world.review)
        ? {
            ...world,
            baseOid: action.review.baseOid,
            headOid: action.review.headOid,
            review: action.review,
            patchPages: action.review.patch === '' ? [] : [action.review.patch],
            patchLength: action.review.patch.length
          }
        : world)
  }
  if (action.type === 'set-patch-expected-file-count') {
    return updatePatchWorld(state, action.worldId, action.generation, (world) =>
      ({ ...world, review: { ...world.review, expectedFileCount: action.fileCount } }))
  }
  if (action.type === 'set-patch-checks') {
    return updatePatchWorld(state, action.worldId, action.generation, (world) =>
      world.review.kind === 'github'
        ? {
            ...world,
            review: {
              ...world.review,
              pullRequest: {
                ...world.review.pullRequest,
                checks: action.checks,
                mergeable: action.mergeable
              }
            }
          }
        : world)
  }
  if (action.type === 'set-patch-status') {
    return updatePatchWorld(state, action.worldId, action.generation, (world) => {
      const review = action.loadStatus !== 'ready'
        ? { ...world.review, expectedFileCount: world.review.files.length }
        : world.review
      return {
        ...world,
        review,
        loadStatus: action.loadStatus,
        errorMessage: action.loadStatus === 'error'
          ? (action.errorMessage ?? world.errorMessage)
          : null
      }
    })
  }
  if (action.type === 'focus') {
    return state.worlds.some((world) => world.worldId === action.worldId)
      ? { ...state, activeWorldId: action.worldId }
      : state
  }
  if (action.type === 'close') {
    const worlds = state.worlds.filter((world) => world.worldId !== action.worldId)
    if (!worlds.some((world) => world.worldId === action.nextWorld.worldId)) worlds.push(action.nextWorld)
    return {
      worlds,
      activeWorldId: state.activeWorldId === action.worldId
        ? action.nextWorld.worldId
        : state.activeWorldId
    }
  }
  return state
}

export function findCollisionPaths(
  statuses: readonly RepositoryStatusEntry[],
  review: RepositoryReview | null
): ReadonlySet<string> {
  if (statuses.length === 0 || review == null || review.files.length === 0) return new Set()
  const dirtyPaths = new Set(statuses.map((status) => status.path))
  const collisions = new Set<string>()
  for (const file of review.files) if (dirtyPaths.has(file.path)) collisions.add(file.path)
  return collisions
}

interface UseReviewWorldsOptions {
  snapshot: RepositorySnapshot | null
  selectedPath: string | null
  workspaceView: WorkspaceView
  onActivateSnapshot(snapshot: RepositorySnapshot | null): void
  onActivateRepository(root: string): Promise<RepositorySnapshot>
  onReleaseRepository(root: string): Promise<void>
  onActivationError(error: unknown): void
  onSelectPath(path: string | null): void
  onWorkspaceViewChange(view: WorkspaceView): void
}

export function useReviewWorlds({
  snapshot,
  selectedPath,
  workspaceView,
  onActivateSnapshot,
  onActivateRepository,
  onReleaseRepository,
  onActivationError,
  onSelectPath,
  onWorkspaceViewChange
}: UseReviewWorldsOptions) {
  const [state, setState] = useState<WorldRegistryState>(() => initialWorldRegistry(snapshot))
  const stateRef = useRef(state)
  const navigationRef = useRef(new Map<string, WorldNavigation>())
  const selectedPathRef = useRef(selectedPath)
  const workspaceViewRef = useRef(workspaceView)
  const activationRef = useRef(0)

  useLayoutEffect(() => {
    stateRef.current = state
    selectedPathRef.current = selectedPath
    workspaceViewRef.current = workspaceView
  }, [selectedPath, state, workspaceView])

  const dispatch = useCallback((action: WorldRegistryAction) => {
    const next = reduceWorldRegistry(stateRef.current, action)
    worldViewCache.retainFrontViewer(next.activeWorldId)
    const bounded = actionMayChangeInactivePatchBudget(action.type)
      ? boundInactivePatchPayloads(next, MAX_INACTIVE_PATCH_BYTES, (worldId) =>
        worldViewCache.graphBytes(worldId))
      : next
    worldViewCache.sync(bounded)
    stateRef.current = bounded
    setState(bounded)
  }, [])

  useEffect(() => {
    if (snapshot == null) return
    const hasRepositoryWorld = stateRef.current.worlds.some((world) => world.source !== 'new')
    dispatch({ type: hasRepositoryWorld ? 'sync-repository' : 'open-desk', snapshot })
  }, [dispatch, snapshot])

  useEffect(() => {
    const activeWorldId = state.activeWorldId
    if (activeWorldId == null) return
    const previous = navigationRef.current.get(activeWorldId)
    navigationRef.current.set(activeWorldId, {
      selectedPath,
      workspaceView,
      reviewScrollTop: previous?.reviewScrollTop ?? 0
    })
  }, [selectedPath, state.activeWorldId, workspaceView])

  const saveActiveNavigation = useCallback(() => {
    const activeWorldId = stateRef.current.activeWorldId
    if (activeWorldId == null) return
    const previous = navigationRef.current.get(activeWorldId)
    navigationRef.current.set(activeWorldId, {
      selectedPath: selectedPathRef.current,
      workspaceView: workspaceViewRef.current,
      reviewScrollTop: previous?.reviewScrollTop ?? 0
    })
  }, [])

  const restoreNavigation = useCallback((worldId: string) => {
    const navigation = navigationRef.current.get(worldId)
    const nextPath = navigation?.selectedPath ?? null
    const nextView = navigation?.workspaceView ?? 'multi'
    if (selectedPathRef.current !== nextPath) onSelectPath(nextPath)
    if (workspaceViewRef.current !== nextView) onWorkspaceViewChange(nextView)
  }, [onSelectPath, onWorkspaceViewChange])

  const activateWorld = useCallback(async (world: ReviewWorld, activation: number): Promise<boolean> => {
    if (world.source === 'new') {
      if (activation !== activationRef.current) return false
      onActivateSnapshot(null)
      return true
    }
    if (worldHasActiveRepositorySession(world, stateRef.current)) return true
    try {
      const nextSnapshot = await onActivateRepository(world.root)
      if (activation !== activationRef.current) return false
      dispatch({ type: 'sync-repository', snapshot: nextSnapshot })
      onActivateSnapshot(nextSnapshot)
      return true
    } catch (error) {
      if (activation === activationRef.current) onActivationError(error)
      return false
    }
  }, [dispatch, onActivateRepository, onActivateSnapshot, onActivationError])

  const focusWorld = useCallback(async (worldId: string) => {
    if (stateRef.current.activeWorldId === worldId) return true
    const world = stateRef.current.worlds.find((candidate) => candidate.worldId === worldId)
    if (world == null) return false
    saveActiveNavigation()
    const activation = ++activationRef.current
    const sessionReady = worldHasActiveRepositorySession(world, stateRef.current)
      || world.source === 'new'
    if (sessionReady) {
      if (world.source === 'new') onActivateSnapshot(null)
      dispatch({ type: 'focus', worldId })
      restoreNavigation(worldId)
      return true
    }
    if (!(await activateWorld(world, activation))) return false
    dispatch({ type: 'focus', worldId })
    restoreNavigation(worldId)
    return true
  }, [activateWorld, dispatch, onActivateSnapshot, restoreNavigation, saveActiveNavigation])

  const openNewWorld = useCallback(() => {
    saveActiveNavigation()
    const world = createNewWorld()
    navigationRef.current.set(world.worldId, {
      selectedPath: null,
      workspaceView: 'multi',
      reviewScrollTop: 0
    })
    activationRef.current += 1
    dispatch({ type: 'new-tab', world })
    onActivateSnapshot(null)
    restoreNavigation(world.worldId)
    return world.worldId
  }, [dispatch, onActivateSnapshot, restoreNavigation, saveActiveNavigation])

  const updateNewWorldLocator = useCallback((locator: string, worldId?: string) => {
    const targetWorldId = worldId ?? stateRef.current.activeWorldId
    if (targetWorldId != null) dispatch({ type: 'update-locator', worldId: targetWorldId, locator })
  }, [dispatch])

  const updateNewWorldRepositoryRoot = useCallback((root: string | null, worldId?: string) => {
    const targetWorldId = worldId ?? stateRef.current.activeWorldId
    if (targetWorldId != null) dispatch({ type: 'update-repository-root', worldId: targetWorldId, root })
  }, [dispatch])

  const setNewWorldPending = useCallback((pending: boolean, pullRequestUrl = '', worldId?: string) => {
    const targetWorldId = worldId ?? stateRef.current.activeWorldId
    if (targetWorldId == null) return
    const match = /^https:\/\/github\.com\/[^/]+\/([^/]+)\/pull\/(\d+)/i.exec(pullRequestUrl.trim())
    const label = pending && match != null ? `#${match[2]} · ${match[1]}` : 'New tab'
    dispatch({ type: 'set-new-pending', worldId: targetWorldId, pending, label })
  }, [dispatch])

  const isWorldActive = useCallback((worldId: string | null | undefined) =>
    worldId != null && stateRef.current.activeWorldId === worldId, [])

  const hasWorld = useCallback((worldId: string | null | undefined) =>
    worldId != null && stateRef.current.worlds.some((world) => world.worldId === worldId), [])

  const hasRepositoryRoot = useCallback((root: string) =>
    stateRef.current.worlds.some((world) => world.source !== 'new' && world.root === root), [])

  const openDeskWorld = useCallback((nextSnapshot: RepositorySnapshot) => {
    saveActiveNavigation()
    const worldId = `desk:${nextSnapshot.root}`
    const existing = navigationRef.current.get(worldId)
    if (existing == null || existing.selectedPath == null) {
      navigationRef.current.set(worldId, {
        selectedPath: firstOpenPathForSnapshot(nextSnapshot),
        workspaceView: automaticWorkspaceView(nextSnapshot, null),
        reviewScrollTop: existing?.reviewScrollTop ?? 0
      })
    }
    dispatch({ type: 'open-desk', snapshot: nextSnapshot })
    if (stateRef.current.activeWorldId === worldId) {
      onActivateSnapshot(nextSnapshot)
      restoreNavigation(worldId)
    }
    return worldId
  }, [dispatch, onActivateSnapshot, restoreNavigation, saveActiveNavigation])

  // Deep hibernation is driven from main, which owns the snooze clock. The
  // caller must have checked that nothing unsaved or in flight would be lost;
  // this only reports whether there was anything left to release.
  const hibernateWorlds = useCallback((): boolean => {
    const releasable = stateRef.current.worlds.some((world) =>
      world.source === 'patch' && world.loadStatus === 'ready')
    if (!releasable) return false
    saveActiveNavigation()
    dispatch({ type: 'hibernate' })
    return true
  }, [dispatch, saveActiveNavigation])

  const focusDesk = useCallback((path: string | null, view: WorkspaceView) => {
    const root = snapshot?.root
    const desk = stateRef.current.worlds.find((world) => world.source === 'desk' && world.root === root)
    if (desk == null) return
    saveActiveNavigation()
    navigationRef.current.set(desk.worldId, { selectedPath: path, workspaceView: view, reviewScrollTop: 0 })
    dispatch({ type: 'focus', worldId: desk.worldId })
    restoreNavigation(desk.worldId)
  }, [dispatch, restoreNavigation, saveActiveNavigation, snapshot?.root])

  const openPatchWorld = useCallback((
    repositorySnapshot: RepositorySnapshot,
    review: RepositoryReview,
    generation: number,
    loading: boolean,
    requestId: string | null = null,
    originWorldId: string | null = stateRef.current.activeWorldId
  ) => {
    saveActiveNavigation()
    const world = createPatchWorld(
      repositorySnapshot,
      review,
      generation,
      loading ? 'loading' : 'ready',
      requestId
    )
    // A world id carries the commits the tab was opened at, and a force push
    // moves them under a tab that stays open. Identity — the pull request URL —
    // is what "already open" means, so reopening it takes over that tab instead
    // of stacking a second one beside it.
    const superseded = stateRef.current.worlds.find((candidate) => candidate.source === 'patch'
      && candidate.worldId !== world.worldId
      && patchReviewIdentity(candidate.review) === patchReviewIdentity(review))
    if (superseded != null) {
      const navigation = navigationRef.current.get(superseded.worldId)
      navigationRef.current.delete(superseded.worldId)
      if (navigation != null) navigationRef.current.set(world.worldId, navigation)
    }
    if (!navigationRef.current.has(world.worldId)) {
      navigationRef.current.set(world.worldId, {
        selectedPath: review.files[0]?.path ?? null,
        workspaceView: 'multi',
        reviewScrollTop: 0
      })
    }
    const focus = stateRef.current.activeWorldId === originWorldId
      || stateRef.current.activeWorldId === superseded?.worldId
    dispatch({ type: 'open-patch', world, originWorldId, supersedesWorldId: superseded?.worldId ?? null })
    if (focus) {
      onActivateSnapshot(repositorySnapshot)
      restoreNavigation(world.worldId)
    }
    return world.worldId
  }, [dispatch, onActivateSnapshot, restoreNavigation, saveActiveNavigation])

  const closeWorld = useCallback(async (worldId = stateRef.current.activeWorldId) => {
    if (worldId == null) return false
    const current = stateRef.current
    const index = current.worlds.findIndex((world) => world.worldId === worldId)
    if (index < 0) return false
    saveActiveNavigation()
    const closingActive = current.activeWorldId === worldId
    const remaining = current.worlds.filter((world) => world.worldId !== worldId)
    const nextWorld = closingActive
      ? remaining[index - 1] ?? remaining[index] ?? createNewWorld()
      : current.worlds.find((world) => world.worldId === current.activeWorldId) ?? createNewWorld()
    if (closingActive) {
      const activation = ++activationRef.current
      if (!(await activateWorld(nextWorld, activation))) return false
    }
    navigationRef.current.delete(worldId)
    dispatch({ type: 'close', worldId, nextWorld })
    if (closingActive) restoreNavigation(nextWorld.worldId)
    const closedWorld = current.worlds[index]
    const closingRoot = closedWorld?.source === 'new' ? null : closedWorld?.root ?? null
    if (closingRoot != null && !remaining.some((world) => world.source !== 'new' && world.root === closingRoot)) {
      try {
        await onReleaseRepository(closingRoot)
      } catch (error) {
        onActivationError(error)
      }
    }
    return true
  }, [activateWorld, dispatch, onActivationError, onReleaseRepository, restoreNavigation, saveActiveNavigation])

  const cycleWorld = useCallback((direction: -1 | 1) => {
    const current = stateRef.current
    if (current.worlds.length < 2 || current.activeWorldId == null) return
    const index = current.worlds.findIndex((world) => world.worldId === current.activeWorldId)
    const nextIndex = (index + direction + current.worlds.length) % current.worlds.length
    const nextWorld = current.worlds[nextIndex]
    if (nextWorld != null) void focusWorld(nextWorld.worldId)
  }, [focusWorld])

  const rememberReviewScroll = useCallback((scrollTop: number) => {
    const activeWorldId = stateRef.current.activeWorldId
    if (activeWorldId == null) return
    const previous = navigationRef.current.get(activeWorldId)
    if (previous == null) return
    navigationRef.current.set(activeWorldId, { ...previous, reviewScrollTop: scrollTop })
  }, [])

  const selectInitialPath = useCallback((worldId: string, path: string) => {
    const navigation = navigationRef.current.get(worldId)
    if (navigation == null || navigation.selectedPath != null) return
    navigationRef.current.set(worldId, { ...navigation, selectedPath: path })
    if (stateRef.current.activeWorldId === worldId) onSelectPath(path)
  }, [onSelectPath])

  const appendPatchPage = useCallback((
    worldId: string,
    generation: number,
    progress: Extract<PullRequestReviewProgress, { kind: 'files' }>
  ) => dispatch({ type: 'append-patch-page', worldId, generation, progress }), [dispatch])

  const replacePatchReview = useCallback((
    worldId: string,
    generation: number,
    review: RepositoryReview
  ) => dispatch({ type: 'replace-patch', worldId, generation, review }), [dispatch])

  const replacePatchHead = useCallback((
    worldId: string,
    generation: number,
    review: RepositoryReview
  ) => dispatch({ type: 'replace-patch-head', worldId, generation, review }), [dispatch])

  const setPatchLoadStatus = useCallback((
    worldId: string,
    generation: number,
    loadStatus: PatchWorld['loadStatus'],
    errorMessage: string | null = null
  ) => dispatch({ type: 'set-patch-status', worldId, generation, loadStatus, errorMessage }), [dispatch])

  const setPatchExpectedFileCount = useCallback((
    worldId: string,
    generation: number,
    fileCount: number
  ) => dispatch({ type: 'set-patch-expected-file-count', worldId, generation, fileCount }), [dispatch])

  const setPatchChecks = useCallback((
    worldId: string,
    generation: number,
    checks: PullRequestChecks | null,
    mergeable: string | null
  ) => dispatch({ type: 'set-patch-checks', worldId, generation, checks, mergeable }), [dispatch])

  const syncRepositorySnapshot = useCallback((nextSnapshot: RepositorySnapshot) => {
    dispatch({ type: 'sync-repository', snapshot: nextSnapshot })
  }, [dispatch])

  const reset = useCallback(() => {
    navigationRef.current.clear()
    const world = createNewWorld()
    dispatch({ type: 'reset', world })
    onActivateSnapshot(null)
  }, [dispatch, onActivateSnapshot])

  const activeWorld = state.worlds.find((world) => world.worldId === state.activeWorldId) ?? null
  // Keyed on what the review is built from, not on the world: a repository sync
  // or a status change replaces the world object, and a new review here
  // re-rendered the viewer and rebuilt its load state for nothing.
  const activePatchWorld = activeWorld?.source === 'patch' ? activeWorld : null
  const activePatchReview = activePatchWorld?.review ?? null
  const activePatchPages = activePatchWorld?.patchPages ?? null
  const activePatchLength = activePatchWorld?.patchLength ?? 0
  const activeReview = useMemo<RepositoryReview | null>(() => {
    if (activePatchReview == null || activePatchPages == null) return null
    return {
      ...activePatchReview,
      patchPages: activePatchPages,
      patchLength: activePatchLength
    }
  }, [activePatchLength, activePatchPages, activePatchReview])
  const activeNavigation = state.activeWorldId == null
    ? null
    : navigationRef.current.get(state.activeWorldId) ?? null

  return useMemo(() => ({
    worlds: state.worlds,
    activeWorld,
    activeReview,
    initialReviewScrollTop: activeNavigation?.reviewScrollTop ?? 0,
    focusWorld,
    focusDesk,
    hibernateWorlds,
    openNewWorld,
    updateNewWorldLocator,
    updateNewWorldRepositoryRoot,
    setNewWorldPending,
    isWorldActive,
    hasWorld,
    hasRepositoryRoot,
    openDeskWorld,
    openPatchWorld,
    appendPatchPage,
    replacePatchHead,
    replacePatchReview,
    setPatchChecks,
    setPatchExpectedFileCount,
    setPatchLoadStatus,
    closeWorld,
    cycleWorld,
    rememberReviewScroll,
    selectInitialPath,
    syncRepositorySnapshot,
    reset
  }), [activeNavigation?.reviewScrollTop, activeReview, activeWorld, appendPatchPage, closeWorld,
    cycleWorld, focusDesk, focusWorld, hibernateWorlds, openDeskWorld, openNewWorld, openPatchWorld,
    hasRepositoryRoot, hasWorld, isWorldActive, rememberReviewScroll, replacePatchHead,
    replacePatchReview, reset,
    selectInitialPath, setPatchChecks, setPatchExpectedFileCount, setPatchLoadStatus,
    setNewWorldPending, state.worlds, syncRepositorySnapshot, updateNewWorldLocator,
    updateNewWorldRepositoryRoot])
}
