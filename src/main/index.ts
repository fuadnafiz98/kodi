import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, renameSync, rmSync } from 'node:fs'

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, powerMonitor, screen, session, shell, type RenderProcessGoneDetails, type WebContents } from 'electron'

import {
  IPC_CHANNELS,
  type MainStartupMetrics,
  type PerformanceMetricsDetail,
  type LocalReviewProgress,
  type PullRequestFolderPreview,
  type RendererTermination,
  type RepositorySnapshot,
  type RepositorySnapshotWithoutPaths
} from '../shared/contracts.js'
import { displayUserPath, folderNameFromPath } from '../shared/folderPath.js'
import { omitHeldPaths } from '../shared/heldPaths.js'
import {
  findKodiFolderRequest,
  findKodiReviewRequest,
  KODI_PROTOCOL,
  LEGACY_KODI_PROTOCOL,
  parseKodiReviewUrl,
  type KodiReviewRequest
} from '../shared/kodiUrl.js'
import {
  extractGitHubPullRequestUrl,
  githubRepoSlugFromPullRequestUrl,
  normalizeGitHubPullRequestUrl
} from '../shared/pullRequestUrl.js'
import { AgentService, coalesceAgentTextEvents } from './agentService.js'
import { BUILD_TIME, formatBuildTime } from './buildInfo.js'
import { migrateLegacyReviewDirectory } from './agentReviewBundle.js'
import { parseAgentAskRequest } from './agentRequest.js'
import { FolderIndex, resolveOpenableFolder } from './folderIndex.js'
import { getAvatarDataUrl } from './avatars.js'
import { loadMarkdownMedia } from './markdownMedia.js'
import { conversationCacheEntryCount, isPathWithinApprovedRoots, loadGlobalPullRequestInbox, parseRemotes, pullRequestTargetsRemotes } from './repository.js'
import { normalizeInboxRepos } from '../shared/inboxRepos.js'
import { PullRequestRootResolver } from './pullRequestRoots.js'
import { clipboardWarmupDecision, warmupCooledDown } from './pullRequestWarmup.js'
import { commandSemaphore, runCommand } from './gitCommands.js'
import { RepositorySessionRegistry } from './repositorySessions.js'
import {
  effectiveLastRoot,
  encodeRestoreHintArgument,
  parseRestoreHint,
  shouldRestoreLastFolder,
  type SessionRestoreHint
} from '../shared/sessionRestore.js'
import {
  comparisonWithoutOpenSession,
  EMPTY_WORKSPACE_CACHE_STORE,
  lastWorkspaceCache,
  mergeWorkspaceCache,
  parseCachedFileText,
  parseWorkspaceUi,
  rememberWorkspaceCacheEntry,
  withLastWorkspaceRoot,
  workspaceCacheForRoot,
  type WorkspaceCache,
  type WorkspaceCacheStore,
  type WorkspaceUiState
} from '../shared/workspaceCache.js'
import {
  DEFAULT_SESSION_STATE,
  flushSessionState,
  isWindowBackgroundHex,
  loadSessionState,
  rememberPullRequestFolder,
  rememberedPullRequestFolder,
  saveSessionState,
  type SessionState
} from './sessionStore.js'
import { flushWorkspaceCache, loadWorkspaceCache, saveWorkspaceCache } from './workspaceCacheStore.js'
import { detectRepositoryKind, listRootSnapshot, resolveExistingRoot, rootsMatch } from './workspaceListing.js'
import { TerminalService } from './terminalService.js'
import {
  revealCreatedWindow,
  revealExistingWindow,
  shouldHoldWindowHidden,
  shouldRevealForReview
} from './windowReveal.js'
import { loadWindowState, saveWindowState, saveWindowStateAsync, type WindowState } from './windowState.js'

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in main:', error)
})

const PRODUCT_NAME = 'Kodi'
const buildStamp = formatBuildTime(BUILD_TIME)
// Pre-rename env names keep working for anything still setting them.
const startHidden = (process.env.KODI_BACKGROUND ?? process.env.HORUS_BACKGROUND) === '1'
// KODI_PROBE: the perf harness runs the app with its window never shown.
// Unlike KODI_BACKGROUND the session still restores — restore is half of
// what the probes measure — and the instance lock is kept, so a human opening
// Kodi mid-probe still reveals the window through second-instance.
const probeHidden = (process.env.KODI_PROBE ?? process.env.HORUS_PROBE) === '1'
const lifecycleProbe = process.env.KODI_LIFECYCLE_PROBE === '1'
const CLIPBOARD_WARMUP_MS = 2_000
const WARMUP_COOLDOWN_MS = 60_000
const HIDDEN_GRACE_MS = 30_000
// How long the open request waits for the checkout before it goes without one.
const EXTERNAL_REVIEW_ROOT_DEADLINE_MS = 150
const remoteDebuggingPort = (process.env.KODI_REMOTE_DEBUGGING_PORT ?? process.env.HORUS_REMOTE_DEBUGGING_PORT)?.trim()
if (remoteDebuggingPort != null && remoteDebuggingPort !== '') {
  app.commandLine.appendSwitch('remote-debugging-port', remoteDebuggingPort)
}
const DEFAULT_WINDOW_WIDTH = 1_440
const DEFAULT_WINDOW_HEIGHT = 920
const GEOMETRY_SAVE_DEBOUNCE_MS = 500
// What Electron paints before first paint, during a resize and behind
// overscroll. A dark value under a light theme flashes on every drag.
const WINDOW_BACKGROUND = { dark: '#0c0d0f', light: '#f7f8fa' } as const
const mainStartupOrigin = performance.now()
const mainStartupMetrics: MainStartupMetrics = {
  appReady: null,
  windowCreated: null,
  windowShown: null,
  restoreSettled: null
}

function markMainStartup(milestone: keyof MainStartupMetrics): void {
  if (mainStartupMetrics[milestone] == null) {
    mainStartupMetrics[milestone] = performance.now() - mainStartupOrigin
  }
}

// Ahead of the service construction below: a second launch hands its arguments
// to the running instance and must not start a watcher on its way out. A
// background launch is a deliberate extra process, so it never takes the lock.
if (!startHidden && !app.requestSingleInstanceLock()) app.exit(0)

app.setName(PRODUCT_NAME)
process.title = PRODUCT_NAME

const agentService = new AgentService()
const terminalService = new TerminalService()
const folderIndex = new FolderIndex(homedir())
const repositorySessions = new RepositorySessionRegistry(
  (change) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.didChange, change)
    }
  },
  (error) => console.error('Repository watcher failed:', error)
)

const MAX_AUTOMATIC_RECOVERIES = 3
const RECOVERY_WINDOW_MS = 60_000
const UNRESPONSIVE_RECOVERY_DELAY_MS = 8_000
const MAX_RENDERER_TERMINATION_RECORDS = 20
let lastRendererTermination: RendererTermination | null = null
let userDataPath = ''
let sessionState: SessionState = DEFAULT_SESSION_STATE
// Held so the getSessionSnapshot handler can wait for it: the restore runs
// alongside the renderer boot, and without the wait the renderer asks before
// the first git call lands and falls back to the Welcome screen.
let restoreLastSession: Promise<unknown> = Promise.resolve(null)
let sessionRestoreStarted = false
let workspaceCacheStore: WorkspaceCacheStore = EMPTY_WORKSPACE_CACHE_STORE
let workspaceCacheLoaded = false
let persistWorkspaceTimer: ReturnType<typeof setTimeout> | null = null
const WORKSPACE_CACHE_SAVE_DEBOUNCE_MS = 1_000
let holdWindowHidden = startHidden
let pendingOpenPullRequestUrl: string | null = null
let pendingOpenPullRequestRoot: string | null = null
let externalReviewGeneration = 0
// A `kodi .` open in flight: the snapshot handler waits on it so a boot-time
// CLI open can never lose to the Welcome screen.
let pendingFolderOpen: Promise<unknown> = Promise.resolve(null)
const queuedExternalReviews: KodiReviewRequest[] = []
const queuedFolderOpens: string[] = []
// The folder a `kodi <folder>` opened while the app was up, until the window
// takes it.
let pendingExternalFolderRoot: string | null = null
const warmupFlights = new Map<string, Promise<void>>()
const recentlyWarmedAt = new Map<string, number>()
let clipboardWarmupTimer: ReturnType<typeof setInterval> | null = null
let hiddenGraceTimer: ReturnType<typeof setTimeout> | null = null
let lifecycleState: 'visible' | 'hidden-grace' | 'snoozed' | 'restoring' = 'visible'
let hibernated: boolean | null = null
let hibernationBlockedBy: string | null = null
const LIFECYCLE_TRANSITION_HISTORY = 16
const lifecycleTransitions: Array<{ state: string; reason: string; atMs: number }> = []

function enqueueExternalReview(request: KodiReviewRequest): void {
  queuedExternalReviews.push(request)
}

function revealMainWindow(): void {
  holdWindowHidden = false
  if (process.platform === 'darwin') app.dock?.show()
  const existing = BrowserWindow.getAllWindows()[0]
  const window = existing == null || existing.isDestroyed() ? createMainWindow() : existing
  revealExistingWindow(window)
  // An already-visible window emits no `show`, and a reveal is the one caller
  // that is allowed to end a snooze before the OS reports the window visible.
  setAppVisible(true, 'reveal')
}

function publishPendingOpenPullRequest(): void {
  const url = pendingOpenPullRequestUrl
  if (url == null) return
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isLoadingMainFrame()) continue
    window.webContents.send(IPC_CHANNELS.openExternalPullRequest, url, pendingOpenPullRequestRoot)
  }
}

/**
 * Resolves the checkout and starts the review fetch without opening a repository
 * or refreshing one. A warmup used to open the repository it had just found,
 * which put a full refresh — and, on a big tree, an ignored-file walk — behind
 * every pull request URL that touched the clipboard.
 */
async function primePullRequest(url: string): Promise<void> {
  const root = await pullRequestRoots.resolve(url, 'quick')
  if (root == null) return
  // No session means no service to hold the flight, and opening one here is the
  // storm this path exists to avoid. The renderer opens it a moment later and
  // starts the same fetch itself.
  const repository = repositorySessions.tryGet(root)
  if (repository == null) return
  // Warmup intent: the flight is started but not claimed, so the reader who joins it
  // a moment later can still cancel it by closing the tab.
  await repository.getPullRequestReview(url, undefined, `warmup:${url}`, 'warmup')
}

async function warmupPullRequest(url: string): Promise<void> {
  const inFlight = warmupFlights.get(url)
  if (inFlight != null) return inFlight
  const now = Date.now()
  for (const [candidate, warmedAt] of recentlyWarmedAt) {
    if (now - warmedAt > WARMUP_COOLDOWN_MS) recentlyWarmedAt.delete(candidate)
  }
  if (!warmupCooledDown({ lastWarmedAt: recentlyWarmedAt.get(url), now, cooldownMs: WARMUP_COOLDOWN_MS })) return
  // Cooled down before the work, not after it: a URL with no local checkout used
  // to re-probe every folder on the machine on every clipboard change.
  recentlyWarmedAt.set(url, now)

  const work = primePullRequest(url)
    .catch((error: unknown) => {
      console.warn(`Could not warm pull request ${url}:`, error)
    })
    .finally(() => {
      if (warmupFlights.get(url) === work) warmupFlights.delete(url)
    })
  warmupFlights.set(url, work)
  return work
}

async function applyExternalReview(request: KodiReviewRequest): Promise<void> {
  if (!shouldRevealForReview(request.intent)) {
    await warmupPullRequest(request.url)
    return
  }
  const generation = ++externalReviewGeneration
  // Probe runs measure the review in a hidden window; revealing would flash it.
  if (!probeHidden) revealMainWindow()
  // The renderer has to resolve the checkout before it can ask for the review, so
  // the answer rides along with the open request. Bounded: a resolution that has
  // to walk the folder catalog must not hold the tab back.
  const root = await Promise.race([
    pullRequestRoots.resolve(request.url, 'quick').catch(() => null),
    delay(EXTERNAL_REVIEW_ROOT_DEADLINE_MS).then(() => null)
  ])
  if (generation !== externalReviewGeneration) return
  pendingOpenPullRequestUrl = request.url
  pendingOpenPullRequestRoot = root
  publishPendingOpenPullRequest()
  void primePullRequest(request.url).catch((error: unknown) => {
    console.warn(`Could not prime pull request ${request.url}:`, error)
  })
}

function acceptExternalReview(value: string): void {
  const request = parseKodiReviewUrl(value)
  if (request == null) return
  if (app.isReady()) void applyExternalReview(request)
  else enqueueExternalReview(request)
}

/**
 * `kodi .` — a folder handed to the process instead of a picker. It uses the
 * Open Folder dialog's semantics: anything the user names explicitly is fair,
 * wherever it lives (the picker's scan-root constraint is picker guidance, not
 * a gate). The open lands through openRepository so the renderer learns about
 * it through the usual snapshot publish.
 */
async function applyExternalFolder(folderPath: string, announce = true): Promise<void> {
  const resolved = resolveExistingRoot(resolve(folderPath))
  if (resolved == null) throw new Error('That folder is no longer on disk.')
  if (!(await stat(resolved)).isDirectory()) throw new Error('Choose a folder, not a file.')
  const snapshot = await openRepository(resolved)
  // A window drops change events for every root but its own, so it has to be
  // told. It takes the folder rather than being sent it: one still booting has
  // already asked for its startup snapshot and may not be listening yet, so it
  // takes the folder once that snapshot has settled. A launch's own folder
  // (`announce` false) is the startup snapshot.
  if (announce) {
    pendingExternalFolderRoot = snapshot.root
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(IPC_CHANNELS.openExternalFolder)
    }
  }
  if (!probeHidden && !startHidden) revealMainWindow()
}

function acceptExternalFolder(folderPath: string): void {
  if (app.isReady()) {
    pendingFolderOpen = applyExternalFolder(folderPath).catch((error: unknown) => {
      console.warn(`Could not open folder ${folderPath}:`, error)
    })
  } else {
    queuedFolderOpens.push(folderPath)
  }
}

function startClipboardWarmup(): void {
  if (clipboardWarmupTimer != null) return
  let seen = clipboard.readText()
  // Nothing on screen means nobody is about to press Cmd+H, and a hidden Kodi
  // that scans on every copied URL is a background process burning a core.
  const pollClipboard = (): void => {
    const decision = clipboardWarmupDecision({
      text: clipboard.readText(),
      seen,
      windowVisible: BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible())
    })
    seen = decision.seen
    if (decision.url != null) void warmupPullRequest(decision.url)
  }
  pollClipboard()
  clipboardWarmupTimer = setInterval(pollClipboard, CLIPBOARD_WARMUP_MS)
  clipboardWarmupTimer.unref?.()
}

function stopClipboardWarmup(): void {
  if (clipboardWarmupTimer == null) return
  clearInterval(clipboardWarmupTimer)
  clipboardWarmupTimer = null
}

/**
 * Deep hibernation drops the renderer's review payloads while the app is
 * snoozed. Work that cannot be rebuilt from a descriptor blocks it: a live
 * shell, an agent turn or approval, or a command still holding a lane. Unsaved
 * editor state is the renderer's own veto and comes back on the reply channel.
 */
function hibernationBlocker(): string | null {
  if (terminalService.sessionCount > 0) return 'a terminal session is running'
  if (agentService.busyCount > 0) return 'an agent turn is in flight'
  if (commandSemaphore.running > 0 || commandSemaphore.waiting > 0) return 'a git command is in flight'
  return null
}

/**
 * Deep hibernation is off by default, and measurement is why.
 *
 * Releasing the focused review while snoozed saves 5.4-7.6% of renderer private
 * memory, against 5.8% for simply being hidden — the 20-26% working-set drop
 * that looks like a win happens with or without it, because Chromium trims a
 * hidden window on its own. It also does not come back: in every sample that
 * hibernated, the released focused world never rehydrated on wake (DOM stayed
 * at 407 nodes and the code view did not return within 30 s).
 *
 * So the release path stays, tested and behind this flag, and the shipped app
 * does not carry a restore that does not restore. Re-enable with
 * KODI_DEEP_HIBERNATION=1 to work on it.
 */
const deepHibernationEnabled = process.env.KODI_DEEP_HIBERNATION === '1'

function requestHibernation(): void {
  if (!deepHibernationEnabled) {
    hibernated = false
    hibernationBlockedBy = 'deep hibernation is disabled'
    return
  }
  const blocker = hibernationBlocker()
  if (blocker != null) {
    hibernated = false
    hibernationBlockedBy = blocker
    return
  }
  const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed())
  if (windows.length === 0) return
  hibernated = false
  hibernationBlockedBy = 'the window has not answered yet'
  for (const window of windows) window.webContents.send(IPC_CHANNELS.hibernateRequest)
}

function anyWindowVisible(): boolean {
  return BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isVisible())
}

function recordLifecycle(state: typeof lifecycleState, reason: string): void {
  lifecycleState = state
  lifecycleTransitions.push({ state, reason, atMs: Date.now() })
  if (lifecycleTransitions.length > LIFECYCLE_TRANSITION_HISTORY) lifecycleTransitions.shift()
}

function setAppVisible(visible: boolean, reason: string): void {
  if (visible) {
    // A window hidden at the OS level is not made visible by a claim from its
    // own renderer: Chromium reports `document.visibilityState` as visible for
    // a window that was created but never shown, so without this check the
    // renderer's mount-time sync cancels the snooze it just asked for.
    if (!anyWindowVisible() && reason !== 'reveal') return
    if (lifecycleState === 'visible') return
    if (hiddenGraceTimer != null) clearTimeout(hiddenGraceTimer)
    hiddenGraceTimer = null
    if (lifecycleState === 'snoozed') {
      recordLifecycle('restoring', reason)
      repositorySessions.setSuspended(false)
    }
    hibernated = null
    hibernationBlockedBy = null
    recordLifecycle('visible', reason)
    if (!startHidden && !probeHidden) startClipboardWarmup()
    return
  }
  if (lifecycleState !== 'visible') return
  recordLifecycle('hidden-grace', reason)
  stopClipboardWarmup()
  hiddenGraceTimer = setTimeout(() => {
    hiddenGraceTimer = null
    if (anyWindowVisible()) {
      recordLifecycle('visible', 'grace-window-still-visible')
      return
    }
    recordLifecycle('snoozed', 'grace-elapsed')
    repositorySessions.setSuspended(true)
    requestHibernation()
  }, HIDDEN_GRACE_MS)
  hiddenGraceTimer.unref?.()
}

const launchRequest = findKodiReviewRequest(process.argv)
if (launchRequest != null) enqueueExternalReview(launchRequest)
const launchFolder = findKodiFolderRequest(process.argv, app.isPackaged)
if (launchFolder != null) queuedFolderOpens.push(launchFolder)
app.on('open-url', (event, url) => {
  event.preventDefault()
  acceptExternalReview(url)
})
// `open -a Kodi <path>` and Finder's Open With arrive here rather than on argv.
app.on('open-file', (event, path) => {
  event.preventDefault()
  acceptExternalFolder(path)
})
// Only the installed app owns kodi://. A `bun run dev` registration would
// steal the scheme from ~/Applications/Kodi.app and break Raycast.
if (app.isPackaged) {
  app.setAsDefaultProtocolClient(KODI_PROTOCOL)
  // horus:// links in the wild still reach the renamed app.
  app.setAsDefaultProtocolClient(LEGACY_KODI_PROTOCOL)
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds)
  })
}

function rendererDiagnosticsPath(): string {
  return join(app.getPath('userData'), 'renderer-terminations.json')
}

async function loadLastRendererTermination(): Promise<void> {
  try {
    const records = JSON.parse(await readFile(rendererDiagnosticsPath(), 'utf8')) as RendererTermination[]
    lastRendererTermination = records.at(-1) ?? null
  } catch {
    lastRendererTermination = null
  }
}

async function recordRendererTermination(details: RenderProcessGoneDetails): Promise<void> {
  const record: RendererTermination = {
    reason: details.reason,
    exitCode: details.exitCode,
    occurredAt: Date.now()
  }
  lastRendererTermination = record
  let records: RendererTermination[] = []
  try {
    records = JSON.parse(await readFile(rendererDiagnosticsPath(), 'utf8')) as RendererTermination[]
  } catch {
    // The diagnostic file is optional and can be created on first failure.
  }
  records.push(record)
  await writeFile(
    rendererDiagnosticsPath(),
    JSON.stringify(records.slice(-MAX_RENDERER_TERMINATION_RECORDS), null, 2),
    'utf8'
  ).catch((error) => console.error('Could not persist renderer termination diagnostics:', error))
}

// `rootsMatch` resolves symlinks, so a cache written under one spelling of a
// path is still found when the folder is reopened under another.
function cachedWorkspaceForRoot(root: string): WorkspaceCache | null {
  return workspaceCacheStore.entries.find((entry) => rootsMatch(entry.lastRoot, root)) ?? null
}

function trackSnapshot(snapshot: RepositorySnapshot): RepositorySnapshot {
  repositorySessions.sync(snapshot)
  persistWorkspaceFromSnapshot(snapshot)
  return snapshot
}

// A stage, a commit or a branch switch answers with the whole snapshot, and
// the path list is nearly all of it: ~6.9 MB to serialize and clone at 100k
// paths for a click that changed a status. The preload names the list it holds
// (`held`) and puts it back into a reply that left it out.
function replyWithSnapshot(
  snapshot: RepositorySnapshot,
  held: unknown
): RepositorySnapshot | RepositorySnapshotWithoutPaths {
  return omitHeldPaths(trackSnapshot(snapshot), held)
}

// Nothing here touches the disk: the write is debounced so a burst of publishes
// costs one file, and it never runs on the tick that produced the snapshot.
function rememberWorkspaceCache(next: WorkspaceCache): void {
  saveWorkspaceCacheStore(rememberWorkspaceCacheEntry(workspaceCacheStore, next))
}

function saveWorkspaceCacheStore(next: WorkspaceCacheStore): void {
  if (next === workspaceCacheStore) return
  workspaceCacheStore = next
  if (userDataPath === '') return
  if (persistWorkspaceTimer != null) clearTimeout(persistWorkspaceTimer)
  persistWorkspaceTimer = setTimeout(() => {
    persistWorkspaceTimer = null
    void saveWorkspaceCache(userDataPath, workspaceCacheStore)
  }, WORKSPACE_CACHE_SAVE_DEBOUNCE_MS)
}

function persistWorkspaceFromSnapshot(
  snapshot: RepositorySnapshot,
  ui: WorkspaceUiState | null = null
): void {
  const previous = workspaceCacheForRoot(workspaceCacheStore, snapshot.root)
  rememberWorkspaceCache(mergeWorkspaceCache(snapshot, ui, previous))
}

function flushPendingWorkspaceCache(): void {
  if (persistWorkspaceTimer == null) return
  clearTimeout(persistWorkspaceTimer)
  persistWorkspaceTimer = null
  if (userDataPath !== '') void saveWorkspaceCache(userDataPath, workspaceCacheStore)
}

function persistWindowGeometry(window: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null

  const bounds = (): WindowState => ({ ...window.getNormalBounds(), maximized: window.isMaximized() })

  const write = (): void => {
    if (window.isDestroyed()) return
    saveWindowState(userDataPath, bounds())
  }

  const schedule = (): void => {
    if (timer != null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (!window.isDestroyed()) void saveWindowStateAsync(userDataPath, bounds())
    }, GEOMETRY_SAVE_DEBOUNCE_MS)
  }

  window.on('resize', schedule)
  window.on('move', schedule)
  window.on('maximize', schedule)
  window.on('unmaximize', schedule)
  // A debounced write loses the last drag when the app quits, and by 'closed'
  // the bounds are already gone, so this one goes straight to disk.
  window.on('close', () => {
    if (timer != null) clearTimeout(timer)
    timer = null
    write()
  })
}

function createMainWindow(): BrowserWindow {
  const savedGeometry = startHidden
    ? null
    : loadWindowState(userDataPath, screen.getAllDisplays().map((display) => display.workArea))
  const window = new BrowserWindow({
    x: savedGeometry?.x,
    y: savedGeometry?.y,
    width: savedGeometry?.width ?? DEFAULT_WINDOW_WIDTH,
    height: savedGeometry?.height ?? DEFAULT_WINDOW_HEIGHT,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: PRODUCT_NAME,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: sessionState.windowBackground ?? WINDOW_BACKGROUND[sessionState.themeType],
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A window that never shows is occluded from Chromium's point of view;
      // probe measurements would stall on suspended rAF and throttled timers.
      backgroundThrottling: !probeHidden || lifecycleProbe,
      additionalArguments: [encodeRestoreHintArgument(currentRestoreHint())]
    }
  })
  markMainStartup('windowCreated')

  let recoveryTimer: ReturnType<typeof setTimeout> | null = null
  const recoveryTimes: number[] = []

  const clearRecoveryTimer = (): void => {
    if (recoveryTimer == null) return
    clearTimeout(recoveryTimer)
    recoveryTimer = null
  }

  const loadRenderer = (): void => {
    if (process.env.ELECTRON_RENDERER_URL != null) {
      void window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void window.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  const scheduleRecovery = (reason: string, delay = 400): void => {
    if (window.isDestroyed()) return
    const now = Date.now()
    while (recoveryTimes[0] != null && now - recoveryTimes[0] > RECOVERY_WINDOW_MS) {
      recoveryTimes.shift()
    }
    if (recoveryTimes.length >= MAX_AUTOMATIC_RECOVERIES) {
      console.error(`Renderer recovery stopped after repeated failures: ${reason}`)
      window.show()
      return
    }
    clearRecoveryTimer()
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null
      recoveryTimes.push(Date.now())
      console.warn(`Reloading renderer after ${reason}.`)
      loadRenderer()
    }, delay)
  }

  const tryReveal = (): void => {
    if (revealCreatedWindow(window, {
      holdHidden: holdWindowHidden,
      maximize: savedGeometry?.maximized === true
    })) {
      markMainStartup('windowShown')
    }
  }
  // Fallback if the immediate reveal below was skipped (background hold).
  // Do not wait for this on a normal launch: it fires after the renderer
  // bundle paints, which is later than a half dock-bounce.
  window.once('ready-to-show', tryReveal)
  // Fires only when the renderer's beforeunload handler objected, which it does
  // while a draft is unsaved. preventDefault here means "ignore the objection
  // and close", so it is the discard branch.
  window.webContents.on('will-prevent-unload', (event) => {
    // Nobody is there to answer a quit by signal, and a synchronous dialog
    // would hold it forever. Drafts are in storage, flushed on the way out,
    // and offered back on the next launch.
    if (quitOnSignal) {
      event.preventDefault()
      return
    }
    const choice = dialog.showMessageBoxSync(window, {
      type: 'warning',
      buttons: ['Discard changes', 'Keep editing'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'Close without saving?',
      detail: 'Edits that have not been saved will be lost.'
    })
    if (choice === 0) event.preventDefault()
  })
  if (!startHidden) persistWindowGeometry(window)
  window.on('responsive', clearRecoveryTimer)
  window.on('unresponsive', () => scheduleRecovery('the window stopped responding', UNRESPONSIVE_RECOVERY_DELAY_MS))
  window.on('show', () => setAppVisible(true, 'window-show'))
  window.on('focus', () => setAppVisible(true, 'window-focus'))
  window.on('hide', () => setAppVisible(false, 'window-hide'))
  window.on('minimize', () => setAppVisible(false, 'window-minimize'))
  window.on('restore', () => setAppVisible(true, 'window-restore'))
  window.on('closed', () => {
    clearRecoveryTimer()
    setAppVisible(false, 'window-closed')
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // A dropped link or a stray anchor must never replace the app with a web page:
  // the renderer has preload privileges and there is no way back from a navigation.
  window.webContents.on('will-navigate', (event, url) => {
    // A reload — the error boundary's only way out — is a renderer-initiated
    // navigation to the page already loaded, so it must be let through.
    if (url === window.webContents.getURL()) return
    const devServerUrl = process.env.ELECTRON_RENDERER_URL
    if (devServerUrl != null && url.startsWith(devServerUrl)) return
    event.preventDefault()
    if (url.startsWith('https://')) void shell.openExternal(url)
  })
  // The 92px traffic-light reserve in the titlebar collapses in fullscreen.
  const publishFullscreen = (fullscreen: boolean) => (): void => {
    if (window.isDestroyed()) return
    window.webContents.send(IPC_CHANNELS.fullscreenChange, fullscreen)
  }
  window.on('enter-full-screen', publishFullscreen(true))
  window.on('leave-full-screen', publishFullscreen(false))
  window.webContents.on('did-finish-load', () => {
    if (!window.isDestroyed() && window.isFullScreen()) publishFullscreen(true)()
    publishPendingOpenPullRequest()
  })
  window.webContents.on('found-in-page', (_event, result) => {
    window.webContents.send(IPC_CHANNELS.foundInPage, {
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
      finalUpdate: result.finalUpdate
    })
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    void recordRendererTermination(details)
    // Nothing is left to receive the answer, and the CLI would keep spending
    // plan tokens on it until its own timeout.
    agentService.cancelAll()
    scheduleRecovery(`renderer process exit (${details.reason})`)
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (isMainFrame && errorCode !== -3) {
      scheduleRecovery(`main document load failure (${errorCode}: ${errorDescription})`)
    }
  })

  loadRenderer()
  tryReveal()

  return window
}

async function collectPerformanceDetail(
  processMetrics: Electron.ProcessMetric[]
): Promise<Pick<PerformanceMetricsDetail,
  'mainStartup' | 'memoryByProcessType' | 'mainPrivateMegabytes' | 'commandRunning'
  | 'commandWaiting' | 'watcherCount' | 'pendingWatcherPaths' | 'lifecycleState'
  | 'lifecycleTransitions' | 'hibernated' | 'hibernationBlockedBy'
  | 'conversationCacheEntries'>> {
  const mainMemory = await process.getProcessMemoryInfo()
  const megabytesByType = new Map<string, number>()
  for (const metric of processMetrics) {
    megabytesByType.set(
      metric.type,
      (megabytesByType.get(metric.type) ?? 0) + metric.memory.workingSetSize / 1_024
    )
  }
  const resources = repositorySessions.resourceStats()
  return {
    mainStartup: { ...mainStartupMetrics },
    memoryByProcessType: [...megabytesByType]
      .map(([type, megabytes]) => ({ type, megabytes }))
      .sort((left, right) => right.megabytes - left.megabytes),
    mainPrivateMegabytes: mainMemory.private / 1_024,
    commandRunning: commandSemaphore.running,
    commandWaiting: commandSemaphore.waiting,
    watcherCount: resources.watcherCount,
    pendingWatcherPaths: resources.pendingWatcherPaths,
    lifecycleState,
    lifecycleTransitions: [...lifecycleTransitions],
    hibernated,
    hibernationBlockedBy,
    conversationCacheEntries: conversationCacheEntryCount()
  }
}

async function openRepository(folderPath: string, activate = true): Promise<RepositorySnapshot> {
  // The one `realpath` of the open path. `repositorySessions.open` is told the
  // path is already resolved so it does not repeat it, and the cache lookup and
  // the kind probe both work off this value.
  const resolved = resolveExistingRoot(folderPath)
  if (resolved == null) throw new Error('That folder is no longer on disk.')
  void migrateLegacyReviewDirectory(resolved)

  const cached = cachedWorkspaceForRoot(resolved)
  const snapshot = cached != null
    ? repositorySessions.hydrate({
      ...cached.snapshot,
      root: resolved,
      kind: detectRepositoryKind(resolved)
    }, activate)
    : await repositorySessions.open(resolved, activate, true)
  rememberOpenedRoot(snapshot.root, activate)
  if (cached != null) {
    void repositorySessions.refresh(snapshot.root).then((live) => {
      if (live != null && live.root === repositorySessions.activeRoot) persistWorkspaceFromSnapshot(live)
    })
  }
  return snapshot
}

function requireRepositoryRoot(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error('Repository root must be an absolute path.')
  }
  return value
}

async function remotesForRoot(root: string): Promise<ReturnType<typeof parseRemotes>> {
  if (await stat(root).catch(() => null) == null) return []
  const openRepository = repositorySessions.tryGet(root)
  if (openRepository != null) return openRepository.getRemotes()
  // Probing folders for a pull request's checkout is speculative work: it must
  // never take a spawn slot from the repository the user is looking at.
  const remotes = await runCommand(
    'git',
    ['-C', root, 'remote', '-v'],
    undefined,
    [],
    undefined,
    undefined,
    'background'
  )
  return parseRemotes(remotes)
}

const pullRequestRoots = new PullRequestRootResolver({
  rememberedRoot: (slug) => rememberedPullRequestFolder(sessionState, slug),
  openRoots: () => repositorySessions.roots,
  approvedRoots: () => sessionState.approvedRoots,
  catalogRoots: async () => (await folderIndex.list(sessionState.approvedRoots)).folders
    .map((folder) => folder.path),
  remotesFor: remotesForRoot
})

function rememberPullRequestCheckout(pullRequestUrl: string, root: string): void {
  const slug = githubRepoSlugFromPullRequestUrl(pullRequestUrl)
  if (slug == null) return
  const next = rememberPullRequestFolder(sessionState, slug, root)
  if (next === sessionState) return
  sessionState = next
  if (userDataPath !== '') void saveSessionState(userDataPath, sessionState)
}

async function openChosenPullRequestFolder(
  pullRequestUrl: string,
  folderPath: string
): Promise<RepositorySnapshot> {
  if (resolveExistingRoot(folderPath) == null) {
    throw new Error('That folder is no longer on disk.')
  }
  const remotes = await remotesForRoot(folderPath)
  const repositorySlug = githubRepoSlugFromPullRequestUrl(pullRequestUrl)
    ?? new URL(pullRequestUrl).pathname.split('/').slice(1, 3).join('/')
  if (!pullRequestTargetsRemotes(remotes, pullRequestUrl)) {
    throw new Error(`The selected folder is not a checkout of ${repositorySlug}.`)
  }
  rememberPullRequestCheckout(pullRequestUrl, folderPath)
  return openRepository(folderPath, false)
}

// A chip under the URL field. It reports what is already known and starts
// nothing: probing every folder on the machine to label a suggestion was a third
// of the git spawns behind Cmd+H.
async function previewPullRequestFolder(value: unknown): Promise<PullRequestFolderPreview | null> {
  if (typeof value !== 'string') throw new Error('Pull request URL must be text.')
  const pullRequestUrl = normalizeGitHubPullRequestUrl(value) ?? extractGitHubPullRequestUrl(value)
  if (pullRequestUrl == null) return null
  const slug = githubRepoSlugFromPullRequestUrl(pullRequestUrl)
  const remembered = slug == null ? null : rememberedPullRequestFolder(sessionState, slug)
  if (remembered != null && await stat(remembered).catch(() => null) != null) {
    return pullRequestFolderPreview(remembered, 'remembered')
  }
  const resolution = pullRequestRoots.pending(pullRequestUrl)
  const root = resolution == null ? null : await resolution
  return root == null ? null : pullRequestFolderPreview(root, 'matched')
}

function pullRequestFolderPreview(
  root: string,
  source: PullRequestFolderPreview['source']
): PullRequestFolderPreview {
  return {
    root,
    name: folderNameFromPath(root),
    displayPath: displayUserPath(root, folderIndex.home),
    source
  }
}

async function resolvePullRequestRepository(
  value: unknown,
  preferredRoot?: unknown
): Promise<RepositorySnapshot | null> {
  if (typeof value !== 'string') throw new Error('Pull request URL must be text.')
  const pullRequestUrl = normalizeGitHubPullRequestUrl(value)
  if (pullRequestUrl == null) throw new Error('Enter a full GitHub pull request URL.')
  if (typeof preferredRoot === 'string' && preferredRoot !== '') {
    if (!isAbsolute(preferredRoot)) throw new Error('Project folder must be an absolute path.')
    return openChosenPullRequestFolder(pullRequestUrl, preferredRoot)
  }
  const matchingRoot = await pullRequestRoots.resolve(pullRequestUrl)
  if (matchingRoot != null) {
    rememberPullRequestCheckout(pullRequestUrl, matchingRoot)
    return openRepository(matchingRoot, false)
  }

  const repositorySlug = githubRepoSlugFromPullRequestUrl(pullRequestUrl)
    ?? new URL(pullRequestUrl).pathname.split('/').slice(1, 3).join('/')
  const result = await dialog.showOpenDialog({
    title: `Select the local checkout for ${repositorySlug}`,
    message: `Select the local checkout for ${repositorySlug}.`,
    properties: ['openDirectory']
  })
  const folderPath = result.filePaths[0]
  if (result.canceled || folderPath == null) return null
  return openChosenPullRequestFolder(pullRequestUrl, folderPath)
}

async function chooseFolder(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    title: 'Choose project folder',
    properties: ['openDirectory']
  })
  const folderPath = result.filePaths[0]
  if (result.canceled || folderPath == null) return null
  return folderPath
}

// The hint is asked for on the window's `additionalArguments`, on the sync
// get-restore-hint channel and again on get-workspace-cache; each miss costs an
// `existsSync` + `realpathSync` on the last root. Nothing but these four inputs
// can change the answer, so identity on them is enough to reuse it.
let restoreHintCache: {
  sessionState: SessionState
  store: WorkspaceCacheStore
  pendingUrl: string | null
  hint: SessionRestoreHint
} | null = null

function currentRestoreHint(): SessionRestoreHint {
  const cached = restoreHintCache
  if (cached != null
    && cached.sessionState === sessionState
    && cached.store === workspaceCacheStore
    && cached.pendingUrl === pendingOpenPullRequestUrl) {
    return cached.hint
  }
  const hint = computeRestoreHint()
  restoreHintCache = {
    sessionState,
    store: workspaceCacheStore,
    pendingUrl: pendingOpenPullRequestUrl,
    hint
  }
  return hint
}

function computeRestoreHint(): SessionRestoreHint {
  const lastRoot = effectiveLastRoot(sessionState.lastRoot, workspaceCacheStore.lastRoot)
  const folderPresent = lastRoot != null && resolveExistingRoot(lastRoot) != null
  return parseRestoreHint({
    lastRoot,
    restoreLastFolder: sessionState.restoreLastFolder,
    themeType: sessionState.themeType,
    canvasColor: sessionState.windowBackground ?? WINDOW_BACKGROUND[sessionState.themeType],
    folderPresent,
    restoring: shouldRestoreLastFolder({
      startHidden,
      restoreLastFolder: sessionState.restoreLastFolder,
      lastRoot,
      folderPresent
    }),
    // A launch that is itself a Cmd+H tells the renderer to preload the review
    // viewer rather than whichever chunk the cached desk last used.
    pendingPullRequestUrl: pendingOpenPullRequestUrl
  })
}

function localReviewProgressSender(
  sender: WebContents,
  requestId: unknown
): ((progress: LocalReviewProgress) => void) | undefined {
  if (typeof requestId !== 'string' || requestId === '' || requestId.length > 200) return undefined
  return (progress) => {
    if (!sender.isDestroyed()) {
      sender.send(IPC_CHANNELS.localReviewProgress, { ...progress, requestId })
    }
  }
}

function registerIpcHandlers(): void {
  ipcMain.on(IPC_CHANNELS.getRestoreHint, (event) => {
    event.returnValue = currentRestoreHint()
  })
  ipcMain.on(IPC_CHANNELS.getWorkspaceCache, (event) => {
    event.returnValue = currentRestoreHint().restoring
      ? lastWorkspaceCache(workspaceCacheStore)
      : null
  })
  ipcMain.handle(IPC_CHANNELS.persistWorkspaceUi, (_event, raw: unknown) => {
    const snapshot = repositorySessions.getActiveSnapshot()
    const ui = parseWorkspaceUi(raw)
    if (snapshot == null || ui == null) return
    persistWorkspaceFromSnapshot(snapshot, ui)
  })
  ipcMain.handle(IPC_CHANNELS.persistFileText, (_event, raw: unknown) => {
    const snapshot = repositorySessions.getActiveSnapshot()
    if (snapshot == null) return
    persistWorkspaceFromSnapshot(snapshot, { fileText: parseCachedFileText(raw) })
  })
  ipcMain.handle(IPC_CHANNELS.getSessionSnapshot, async () => {
    const current = repositorySessions.getActiveSnapshot()
    if (current != null) return current
    // The restore runs on the tick after the window is shown; a renderer that
    // gets its question in first starts it instead of racing it.
    beginSessionRestore()
    await restoreLastSession
    await pendingFolderOpen
    const live = repositorySessions.getActiveSnapshot()
    if (live != null) return live
    // Returning a cache JSON blob without hydrate made the renderer apply
    // Makefile and call get-comparison with no session — Welcome + that toast.
    const recovered = hydrateLastWorkspace()
    if (recovered != null) startLiveRefresh(recovered.root)
    return recovered
  })
  ipcMain.handle(IPC_CHANNELS.takeExternalFolder, () => {
    const root = pendingExternalFolderRoot
    pendingExternalFolderRoot = null
    return root == null ? null : repositorySessions.tryGet(root)?.getSessionSnapshot() ?? null
  })
  ipcMain.handle(IPC_CHANNELS.openFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open folder',
      properties: ['openDirectory']
    })
    const folderPath = result.filePaths[0]
    if (result.canceled || folderPath == null) return null
    return openRepository(folderPath)
  })
  ipcMain.handle(IPC_CHANNELS.chooseFolder, () => chooseFolder())
  ipcMain.handle(IPC_CHANNELS.listFolderCandidates, () => folderIndex.list(sessionState.approvedRoots))
  ipcMain.handle(IPC_CHANNELS.openPickedFolder, async (_event, folderPath: unknown) => {
    const resolved = await resolveOpenableFolder(folderPath, {
      home: folderIndex.home,
      approvedRoots: sessionState.approvedRoots
    })
    return openRepository(resolved)
  })
  ipcMain.handle(IPC_CHANNELS.openPath, async (_event, folderPath: unknown) => {
    if (typeof folderPath !== 'string' || !isAbsolute(folderPath)) {
      throw new Error('Recent folder path must be absolute.')
    }
    if (!isPathWithinApprovedRoots(sessionState.approvedRoots, folderPath)) {
      throw new Error('Select this folder with Open Folder before reopening it from history.')
    }
    return openRepository(folderPath)
  })
  ipcMain.handle(IPC_CHANNELS.activateRepository, async (_event, root: unknown) => {
    const snapshot = await repositorySessions.activate(requireRepositoryRoot(root))
    rememberActiveRoot(snapshot.root)
    return snapshot
  })
  ipcMain.handle(IPC_CHANNELS.releaseRepository, (_event, root: unknown) => {
    const released = requireRepositoryRoot(root)
    repositorySessions.release(released)
    forgetClosedRoot(released)
  })
  ipcMain.handle(IPC_CHANNELS.previewPullRequestFolder, (_event, pullRequestUrl: unknown) =>
    previewPullRequestFolder(pullRequestUrl))
  ipcMain.handle(IPC_CHANNELS.resolvePullRequestRepository, (_event, pullRequestUrl: unknown, preferredRoot: unknown) =>
    resolvePullRequestRepository(pullRequestUrl, preferredRoot))
  // Handed over once. Left in place it reopened the pull request on every
  // renderer reload, including the ones an automatic recovery triggers.
  ipcMain.handle(IPC_CHANNELS.getPendingExternalPullRequest, () => {
    const url = pendingOpenPullRequestUrl
    pendingOpenPullRequestUrl = null
    pendingOpenPullRequestRoot = null
    return url
  })
  ipcMain.handle(IPC_CHANNELS.readClipboardText, (_event, type: unknown) => {
    if (type == null) return clipboard.readText()
    if (typeof type !== 'string' || type === '' || type.length > 200) {
      throw new Error('Clipboard format must be a short non-empty string.')
    }
    // @pierre/diffs uses a custom MIME format to preserve one value per caret.
    // Electron's readText argument selects a clipboard buffer, not a MIME type.
    return type === 'selection' || type === 'clipboard'
      ? clipboard.readText(type)
      : clipboard.read(type)
  })
  ipcMain.handle(IPC_CHANNELS.revealPath, (_event, relativePath: unknown) => {
    const snapshot = repositorySessions.getActiveSnapshot()
    if (snapshot == null) throw new Error('Open a repository before revealing a file.')
    if (typeof relativePath !== 'string' || relativePath === '' || isAbsolute(relativePath)) {
      throw new Error('Reveal path must be a relative repository path.')
    }
    const candidate = join(snapshot.root, relativePath)
    if (!isPathWithinApprovedRoots([snapshot.root], candidate)) {
      throw new Error('Reveal path must stay inside the open repository.')
    }
    shell.showItemInFolder(candidate)
  })
  ipcMain.handle(IPC_CHANNELS.refresh, (_event, held: unknown) =>
    repositorySessions.requireActive().refresh().then((snapshot) => replyWithSnapshot(snapshot, held)))
  ipcMain.handle(IPC_CHANNELS.getComparison, (_event, path: string) => {
    const repository = repositorySessions.tryGetActive()
    if (repository == null) {
      const requested = typeof path === 'string' ? path : ''
      return comparisonWithoutOpenSession(
        requested,
        lastWorkspaceCache(workspaceCacheStore)?.fileText ?? null
      )
    }
    return repository.getComparison(path)
  })
  ipcMain.handle(IPC_CHANNELS.getRevisionFile, (_event, revision: unknown, path: unknown) =>
    repositorySessions.requireActive().getRevisionFile(revision, path))
  ipcMain.handle(IPC_CHANNELS.ensurePullRequestRevisions,
    (_event, pullRequestUrl: unknown, baseOid: unknown, headOid: unknown) =>
      repositorySessions.tryGetActive()?.ensurePullRequestRevisions(pullRequestUrl, baseOid, headOid) ?? false)
  ipcMain.handle(IPC_CHANNELS.saveWorkingFile, async (_event, request: unknown) => {
    const repository = repositorySessions.requireActive()
    const comparison = await repository.saveWorkingFile(request)
    const snapshot = repository.getSessionSnapshot()
    if (snapshot != null) trackSnapshot(snapshot)
    return comparison
  })
  ipcMain.handle(IPC_CHANNELS.getWorkingTreePatch, async (
    event,
    paths: unknown,
    requestId: unknown,
    root: unknown
  ) => {
    const send = localReviewProgressSender(event.sender, requestId)
    // A caller that names its root gets that repository's patch even when the
    // active tab moved while the request was in flight.
    const repository = root == null
      ? repositorySessions.requireActive()
      : repositorySessions.require(requireRepositoryRoot(root))
    const reply = await repository.getWorkingTreePatch(
      paths,
      send == null
        ? undefined
        : (page) => {
          send({
            kind: 'files',
            selector: 'working-tree',
            patch: page.patch,
            files: [],
            omittedFiles: page.omittedFiles
          })
        }
    )
    // A streamed caller's reply carries no patch, and it can reach the renderer
    // before the pages sent ahead of it. `done` travels on the pages' channel, so
    // it lands after every one of them.
    send?.({ kind: 'done', selector: 'working-tree', fileCount: 0 })
    return reply
  })
  ipcMain.handle(IPC_CHANNELS.searchContent, (_event, query: string, forOpenPath: unknown) =>
    repositorySessions.requireActive().searchContent(
      query,
      typeof forOpenPath === 'string' ? forOpenPath : null
    )
  )
  ipcMain.on(IPC_CHANNELS.cancelContentSearch, () => repositorySessions.cancelActiveContentSearch())
  ipcMain.handle(IPC_CHANNELS.getMarkdownMedia, (_event, url: unknown) => loadMarkdownMedia(url))
  ipcMain.handle(IPC_CHANNELS.getAvatar, (_event, url: unknown) => getAvatarDataUrl(url))
  ipcMain.handle(IPC_CHANNELS.getGitIntegration, (_event, options: unknown) =>
    repositorySessions.requireActive().getGitIntegration({
      pullRequests: (options as { pullRequests?: unknown } | null)?.pullRequests !== false
    }))
  ipcMain.handle(IPC_CHANNELS.getRepositoryPullRequests, () =>
    repositorySessions.requireActive().getRepositoryPullRequests())
  ipcMain.handle(IPC_CHANNELS.getPullRequestInbox, () => repositorySessions.requireActive().getPullRequestInbox())
  ipcMain.handle(IPC_CHANNELS.getGlobalPullRequestInbox, (_event, repos: unknown) => loadGlobalPullRequestInbox(normalizeInboxRepos(repos)))
  ipcMain.handle(IPC_CHANNELS.getClosedPullRequests, () => repositorySessions.requireActive().getClosedPullRequests())
  ipcMain.on(IPC_CHANNELS.cancelPullRequestReview, (_event, root: unknown, requestId: unknown) => {
    if (typeof root !== 'string' || typeof requestId !== 'string' || requestId === '') return
    repositorySessions.tryGet(root)?.cancelPullRequestReview(requestId)
  })
  ipcMain.handle(IPC_CHANNELS.getAgentModels, async () => {
    const snapshot = repositorySessions.getActiveSnapshot()
    if (snapshot == null) throw new Error('Open a repository before loading agent models.')
    return agentService.getModels(snapshot.root)
  })
  ipcMain.handle(IPC_CHANNELS.getAgentStatuses, (_event, provider: unknown) =>
    agentService.getStatuses(provider))
  ipcMain.handle(IPC_CHANNELS.loginAgent, (_event, provider: unknown) =>
    agentService.login(provider))
  ipcMain.handle(IPC_CHANNELS.askAgent, async (event, request: unknown) => {
    const parsedRequest = await parseAgentAskRequest(request)
    const repository = repositorySessions.require(parsedRequest.subject.repositoryRoot)
    const snapshot = repository.getSessionSnapshot()
    if (snapshot == null) throw new Error('The repository tab is not ready for the agent.')
    const sender = event.sender
    const stream = coalesceAgentTextEvents((agentEvent) => {
      if (!sender.isDestroyed()) sender.send(IPC_CHANNELS.agentEvent, agentEvent)
    })
    try {
      const reviewContext = await repository.prepareAgentReview(parsedRequest.subject)
      const context = reviewContext === ''
        ? parsedRequest.context
        : parsedRequest.context === ''
          ? reviewContext
          : `${parsedRequest.context}\n\n${reviewContext}`
      await agentService.ask({ ...parsedRequest, context }, snapshot.root, stream.emit)
    } finally {
      stream.flush()
    }
  })
  ipcMain.handle(IPC_CHANNELS.cancelAgent, (_event, id: unknown) => agentService.cancel(id))
  ipcMain.handle(IPC_CHANNELS.respondAgentApproval, (_event, requestId: unknown, decision: unknown) =>
    agentService.respondApproval(requestId, decision))
  ipcMain.handle(IPC_CHANNELS.createTerminal, (event, columns: unknown, rows: unknown) => {
    const snapshot = repositorySessions.getActiveSnapshot()
    if (snapshot == null) throw new Error('Open a project before starting a terminal.')
    return terminalService.create(event.sender, snapshot.root, columns, rows, app.getVersion())
  })
  ipcMain.on(IPC_CHANNELS.readyTerminal, (event, sessionId: unknown) => {
    terminalService.ready(event.sender.id, sessionId)
  })
  ipcMain.on(IPC_CHANNELS.writeTerminal, (event, sessionId: unknown, data: unknown) => {
    try {
      terminalService.write(event.sender.id, sessionId, data)
    } catch (error) {
      console.error('Rejected terminal input:', error)
    }
  })
  ipcMain.on(IPC_CHANNELS.resizeTerminal, (event, sessionId: unknown, columns: unknown, rows: unknown) => {
    try {
      terminalService.resize(event.sender.id, sessionId, columns, rows)
    } catch (error) {
      console.error('Rejected terminal resize:', error)
    }
  })
  ipcMain.on(IPC_CHANNELS.clearTerminal, (event, sessionId: unknown) => {
    terminalService.clear(event.sender.id, sessionId)
  })
  ipcMain.on(IPC_CHANNELS.setTerminalVisibility, (event, sessionId: unknown, visible: unknown) => {
    terminalService.setVisible(event.sender.id, sessionId, visible)
  })
  ipcMain.handle(IPC_CHANNELS.killTerminal, (event, sessionId: unknown) => {
    terminalService.kill(event.sender.id, sessionId)
  })
  ipcMain.handle(IPC_CHANNELS.getPullRequestConversation,
    (_event, root: unknown, selector: number | string, force: unknown) =>
      repositorySessions.require(requireRepositoryRoot(root))
        .getPullRequestConversation(selector, { force: force === true }))
  ipcMain.handle(IPC_CHANNELS.replyToPullRequestThread, (_event, root: unknown, threadId: unknown, body: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).replyToPullRequestThread(threadId, body))
  ipcMain.handle(IPC_CHANNELS.setPullRequestThreadResolved, (_event, root: unknown, threadId: unknown, resolved: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).setPullRequestThreadResolved(threadId, resolved))
  ipcMain.handle(IPC_CHANNELS.mergePullRequest, (_event, root: unknown, selector: number | string, strategy: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).mergePullRequest(selector, strategy))
  ipcMain.handle(IPC_CHANNELS.markPullRequestReady, (_event, root: unknown, selector: number | string) =>
    repositorySessions.require(requireRepositoryRoot(root)).markPullRequestReady(selector))
  // Source Control writes name their repository rather than trusting the active
  // one: each can wait on a confirmation, and a tab switched in the meantime
  // used to receive the discard, commit or branch switch meant for another.
  ipcMain.handle(IPC_CHANNELS.switchBranch, (_event, root: unknown, name: string, held: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).switchBranch(name)
      .then((snapshot) => replyWithSnapshot(snapshot, held))
  )
  ipcMain.handle(IPC_CHANNELS.getLocalBranchReview, (event, baseRef: string, headRef: string, requestId: unknown) =>
    repositorySessions.requireActive().getLocalBranchReview(
      baseRef,
      headRef,
      localReviewProgressSender(event.sender, requestId)
    )
  )
  ipcMain.handle(IPC_CHANNELS.getLocalSnapshotReview, (
    _event,
    baseOid: string,
    headOid: string,
    baseRefName: string,
    headRefName: string
  ) => repositorySessions.requireActive().getLocalSnapshotReview(baseOid, headOid, baseRefName, headRefName))
  ipcMain.handle(IPC_CHANNELS.getCommitReview, (event, oid: string, requestId: unknown) =>
    repositorySessions.requireActive().getCommitReview(
      oid,
      localReviewProgressSender(event.sender, requestId)
    )
  )
  ipcMain.handle(IPC_CHANNELS.fetchRemote, (_event, root: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).fetchRemote())
  ipcMain.handle(IPC_CHANNELS.pullCurrentBranch, (_event, root: unknown, held: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).pullCurrentBranch()
      .then((snapshot) => replyWithSnapshot(snapshot, held))
  )
  ipcMain.handle(IPC_CHANNELS.pushCurrentBranch, (_event, root: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).pushCurrentBranch())
  ipcMain.handle(IPC_CHANNELS.stagePaths, (_event, root: unknown, paths: unknown, held: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).stagePaths(paths)
      .then((snapshot) => replyWithSnapshot(snapshot, held)))
  ipcMain.handle(IPC_CHANNELS.unstagePaths, (_event, root: unknown, paths: unknown, held: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).unstagePaths(paths)
      .then((snapshot) => replyWithSnapshot(snapshot, held)))
  ipcMain.handle(IPC_CHANNELS.discardPaths, (_event, root: unknown, paths: unknown, held: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).discardPaths(paths)
      .then((snapshot) => replyWithSnapshot(snapshot, held)))
  ipcMain.handle(IPC_CHANNELS.commitChanges, (_event, root: unknown, request: unknown, held: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).commitChanges(request)
      .then((snapshot) => replyWithSnapshot(snapshot, held)))
  ipcMain.handle(IPC_CHANNELS.getPullRequestReview, (
    event,
    root: unknown,
    selector: number | string,
    requestId: unknown,
    refresh: unknown
  ) => {
    const repositoryRoot = requireRepositoryRoot(root)
    if (typeof requestId !== 'string' || requestId === '' || requestId.length > 200) {
      throw new Error('Pull request load ID must be short non-empty text.')
    }
    // Streamed back page by page: a review of a few thousand files takes long
    // enough to fetch that waiting for all of it reads as a hang.
    return repositorySessions.require(repositoryRoot).getPullRequestReview(selector, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC_CHANNELS.pullRequestReviewProgress, {
          ...progress,
          root: repositoryRoot,
          requestId
        })
      }
    }, requestId, 'foreground', refresh === true)
  })
  ipcMain.handle(IPC_CHANNELS.checkoutPullRequest, (_event, root: unknown, number: number, held: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).checkoutPullRequest(number)
      .then((snapshot) => replyWithSnapshot(snapshot, held))
  )
  ipcMain.handle(IPC_CHANNELS.submitPullRequestReview, (_event, root: unknown, selector: number | string, commitId: unknown, reviewEvent: string, body: string, comments: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).submitPullRequestReview(selector, commitId, reviewEvent, body, comments)
  )
  ipcMain.handle(IPC_CHANNELS.getPerformanceMetrics, async (_event, detailed: unknown) => {
    const processMetrics = app.getAppMetrics()
    let cpuPercent = 0
    let gpuProcessCpuPercent: number | null = null
    let memoryKilobytes = 0

    for (const metric of processMetrics) {
      cpuPercent += metric.cpu.percentCPUUsage
      memoryKilobytes += metric.memory.workingSetSize
      if (metric.type === 'GPU') {
        gpuProcessCpuPercent = (gpuProcessCpuPercent ?? 0) + metric.cpu.percentCPUUsage
      }
    }

    return {
      cpuPercent,
      gpuProcessCpuPercent,
      workingSetMegabytes: memoryKilobytes / 1_024,
      lastRendererTermination,
      processCount: processMetrics.length,
      production: app.isPackaged,
      sampledAt: Date.now(),
      detail: detailed === true ? await collectPerformanceDetail(processMetrics) : null
    }
  })
  ipcMain.handle(IPC_CHANNELS.setStartupPreferences, (event, preferences: unknown) => {
    if (typeof preferences !== 'object' || preferences == null) {
      throw new Error('Startup preferences must be an object.')
    }
    const { themeType, restoreLastFolder, windowBackground } = preferences as Record<string, unknown>
    if (themeType !== 'dark' && themeType !== 'light') throw new Error('Theme type must be dark or light.')
    if (typeof restoreLastFolder !== 'boolean') throw new Error('restoreLastFolder must be a boolean.')
    const canvas = isWindowBackgroundHex(windowBackground) ? windowBackground : WINDOW_BACKGROUND[themeType]
    if (sessionState.themeType === themeType && sessionState.restoreLastFolder === restoreLastFolder
      && sessionState.windowBackground === canvas) return
    const typeChanged = sessionState.themeType !== themeType
    const repainting = typeChanged || sessionState.windowBackground !== canvas
    sessionState = { ...sessionState, themeType, restoreLastFolder, windowBackground: canvas }
    void saveSessionState(userDataPath, sessionState)
    // setBackgroundColor can flash on some macOS versions, so only on a real change.
    if (!repainting) return
    if (typeChanged) nativeTheme.themeSource = themeType
    BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(canvas)
  })
  ipcMain.on(IPC_CHANNELS.hibernationState, (_event, blockedBy: unknown) => {
    // Only the snooze that asked may record an answer: a reply that arrives
    // after the user came back would otherwise mark a visible app hibernated.
    if (lifecycleState !== 'snoozed') return
    hibernated = blockedBy == null
    hibernationBlockedBy = typeof blockedBy === 'string' ? blockedBy : null
  })
  ipcMain.handle(IPC_CHANNELS.setVisibility, (_event, visible: unknown) => {
    if (typeof visible !== 'boolean') throw new Error('Visibility must be a boolean.')
    setAppVisible(visible, 'renderer-visibility')
  })
  ipcMain.handle(IPC_CHANNELS.findInPage, (event, query: unknown, forward: unknown, findNext: unknown) => {
    if (typeof query !== 'string' || typeof forward !== 'boolean' || typeof findNext !== 'boolean') {
      throw new Error('Invalid find request.')
    }
    if (query === '') return -1
    return event.sender.findInPage(query, { forward, findNext })
  })
  ipcMain.handle(IPC_CHANNELS.stopFindInPage, (event) => {
    event.sender.stopFindInPage('clearSelection')
  })
}

// An unpackaged run has no bundle icon, so macOS falls back to Electron's default.
// Pointing the dock at the same source image electron-builder packages makes a dev
// run look like the installed app.
function applyDevelopmentDockIcon(): void {
  if (app.isPackaged || process.platform !== 'darwin') return
  const icon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

// What the next launch restores follows the tab in front. Only an open used to
// move it, so switching tabs restored the wrong folder, and closing the last
// one restored the folder that had just been closed.
function rememberActiveRoot(root: string | null): void {
  if (sessionState.lastRoot !== root && !(root != null && sessionState.lastRoot != null && rootsMatch(sessionState.lastRoot, root))) {
    sessionState = { ...sessionState, lastRoot: root }
    if (userDataPath !== '') void saveSessionState(userDataPath, sessionState)
  }
  const cachedRoot = root == null ? null : cachedWorkspaceForRoot(root)?.lastRoot ?? null
  saveWorkspaceCacheStore(withLastWorkspaceRoot(workspaceCacheStore, cachedRoot))
}

// Closing the folder the next launch would restore hands that to whatever is in
// front now, or to nothing — the dashboard — when no folder is left. The tab
// that takes focus can be a new-tab page, which activates nothing, so "in
// front" falls back to the open folder that was in front most recently.
function forgetClosedRoot(root: string): void {
  const restoredRoot = effectiveLastRoot(sessionState.lastRoot, workspaceCacheStore.lastRoot)
  if (restoredRoot == null || !rootsMatch(restoredRoot, root)) return
  rememberActiveRoot(repositorySessions.lastActiveRoot())
}

function rememberOpenedRoot(root: string, active = true): void {
  // A foreground open replaces the restore. A background PR resolution only
  // authorizes its checkout; it must not replace the folder restored next time.
  if (active) restoreLastSession = Promise.resolve(null)
  const approvedRoots = sessionState.approvedRoots.includes(root)
    ? sessionState.approvedRoots
    : [...sessionState.approvedRoots, root]
  const lastRoot = active ? root : sessionState.lastRoot
  if (sessionState.lastRoot === lastRoot && approvedRoots === sessionState.approvedRoots) return
  sessionState = { ...sessionState, lastRoot, approvedRoots }
  void saveSessionState(userDataPath, sessionState)
}

function hydrateLastWorkspace(): RepositorySnapshot | null {
  if (startHidden || !sessionState.restoreLastFolder) return null
  const root = effectiveLastRoot(sessionState.lastRoot, workspaceCacheStore.lastRoot)
  if (root == null) return null
  const resolved = resolveExistingRoot(root)
  if (resolved == null) return null
  const current = repositorySessions.getActiveSnapshot()
  if (current != null && rootsMatch(current.root, resolved)) return current

  const diskCache = cachedWorkspaceForRoot(resolved)
  const snapshot = {
    ...(diskCache?.snapshot ?? listRootSnapshot(resolved)),
    root: resolved,
    kind: detectRepositoryKind(resolved)
  }
  repositorySessions.hydrate(snapshot)
  persistWorkspaceFromSnapshot(snapshot, diskCache == null
    ? null
    : {
      selectedPath: diskCache.selectedPath,
      workspaceView: diskCache.workspaceView,
      fileText: diskCache.fileText
    })
  if (sessionState.lastRoot == null || !rootsMatch(sessionState.lastRoot, resolved)) {
    const approvedRoots = sessionState.approvedRoots.includes(resolved)
      ? sessionState.approvedRoots
      : [...sessionState.approvedRoots, resolved]
    sessionState = { ...sessionState, lastRoot: resolved, approvedRoots }
    if (userDataPath !== '') void saveSessionState(userDataPath, sessionState)
  }
  return snapshot
}

function startLiveRefresh(root: string): void {
  restoreLastSession = repositorySessions
    .refreshActive()
    .then((live) => {
      if (live != null && live.root === repositorySessions.activeRoot) persistWorkspaceFromSnapshot(live)
      return live
    })
    .catch((error) => {
      console.warn(`Could not reopen ${root}:`, error)
      return repositorySessions.getActiveSnapshot()
    })
    .finally(() => markMainStartup('restoreSettled'))
}

function beginSessionRestore(): void {
  if (sessionRestoreStarted) return
  sessionRestoreStarted = true
  if (!workspaceCacheLoaded) {
    workspaceCacheStore = loadWorkspaceCache(userDataPath)
    workspaceCacheLoaded = true
  }
  const snapshot = hydrateLastWorkspace()
  if (snapshot == null) {
    restoreLastSession = Promise.resolve(null)
    markMainStartup('restoreSettled')
    return
  }
  startLiveRefresh(snapshot.root)
}

function scheduleSessionRestore(): void {
  let releaseGate: () => void = () => {}
  const gate = new Promise<void>((resolveGate) => {
    releaseGate = resolveGate
  })
  restoreLastSession = gate
  setImmediate(() => {
    beginSessionRestore()
    const work = restoreLastSession
    void work.finally(releaseGate)
  })
}

/**
 * Rename-era migration: the Horus profile becomes the Kodi one on first launch
 * so the session, caches, and window state carry over. It must run at module
 * level and still loses to Chromium, which creates a bare userData skeleton
 * while booting — so "already exists" is not the test. A directory without
 * last-session.json holds only throwaway Chromium runtime state and can be
 * replaced wholesale; one with it is a real profile and the legacy dir stays
 * as a manual fallback.
 */
function migrateLegacyUserData(): void {
  try {
    const current = app.getPath('userData')
    const legacy = join(app.getPath('appData'), 'Horus')
    if (!existsSync(legacy)) return
    if (existsSync(join(current, 'last-session.json'))) return
    rmSync(current, { recursive: true, force: true })
    renameSync(legacy, current)
  } catch {
    // A profile that cannot move is a fresh start, not a boot failure.
  }
}

migrateLegacyUserData()

app.whenReady().then(() => {
  markMainStartup('appReady')
  userDataPath = app.getPath('userData')
  repositorySessions.setPullRequestCacheDirectory(join(userDataPath, 'pr-cache'))
  sessionState = loadSessionState(userDataPath)
  nativeTheme.themeSource = sessionState.themeType
  app.setAboutPanelOptions({
    applicationName: PRODUCT_NAME,
    applicationVersion: app.getVersion(),
    // macOS prints this in parentheses after the version, which is where a
    // build stamp belongs. An unbundled run has no stamp, and the panel then
    // shows the version alone rather than an invented date.
    ...(buildStamp == null ? {} : { version: buildStamp })
  })
  const initialReviews = queuedExternalReviews.splice(0)
  holdWindowHidden = probeHidden || shouldHoldWindowHidden(startHidden, initialReviews)
  if (startHidden || holdWindowHidden) app.dock?.hide()
  registerIpcHandlers()
  // Half-bounce first. Hydrating 20k cached paths must not delay window.show()
  // or the pending PR URL that Cmd+H / kodi:// already queued.
  createMainWindow()
  // An unbundled run (`electron .`, the e2e harness) is Electron's own app
  // bundle, so its dock tile and About panel showed Electron's atom under
  // Kodi's name. The About panel draws the application icon, which this sets.
  if (!app.isPackaged) setImmediate(() => app.dock?.setIcon(join(app.getAppPath(), 'build', 'icon.png')))
  for (const request of initialReviews) void applyExternalReview(request)
  const initialFolder = queuedFolderOpens.splice(0).at(-1) ?? null
  if (initialFolder != null) {
    // `kodi <folder>` names the session; the old last-folder restore must not
    // hydrate over it. A failed open falls back to the usual restore inside the
    // snapshot handler.
    sessionRestoreStarted = true
    pendingFolderOpen = new Promise<void>((resolveOpen) => {
      setImmediate(() => {
        workspaceCacheStore = loadWorkspaceCache(userDataPath)
        workspaceCacheLoaded = true
        void applyExternalFolder(initialFolder, false)
          .catch((error: unknown) => {
            console.warn(`Could not open folder ${initialFolder}:`, error)
          })
          .finally(resolveOpen)
      })
    })
  } else {
    // Hydrating the cached workspace — up to 25,000 paths — runs after the window
    // has been handed to the compositor, not in the same tick as its creation.
    scheduleSessionRestore()
  }
  void loadLastRendererTermination()
  applyDevelopmentDockIcon()
  if (!startHidden && !probeHidden) startClipboardWarmup()
  powerMonitor.on('suspend', () => {
    if (hiddenGraceTimer != null) clearTimeout(hiddenGraceTimer)
    hiddenGraceTimer = null
    recordLifecycle('snoozed', 'power-suspend')
    stopClipboardWarmup()
    repositorySessions.setSuspended(true)
  })
  powerMonitor.on('lock-screen', () => setAppVisible(false, 'lock-screen'))
  powerMonitor.on('resume', () => setAppVisible(true, 'power-resume'))
  powerMonitor.on('unlock-screen', () => setAppVisible(true, 'unlock-screen'))
  // Electron replaces Node's SIGTERM handler with its own while it starts (a
  // plain quit, prompt and all, no failsafe), so a listener added as this module
  // loaded never ran. Node installs its handler with the first listener, and
  // the first one is added here, after Electron's.
  process.on('SIGTERM', quitOnTerminationSignal)
  app.on('second-instance', (_event, argv) => {
    const request = findKodiReviewRequest(argv)
    if (request != null) {
      applyExternalReview(request)
      return
    }
    const folder = findKodiFolderRequest(argv, true)
    if (folder != null) {
      pendingFolderOpen = applyExternalFolder(folder).catch((error: unknown) => {
        console.warn(`Could not open folder ${folder}:`, error)
      })
      return
    }
    revealMainWindow()
  })
  app.on('activate', () => {
    // Clicking the dock icon is a resume: a window that is only hidden has to
    // come back, not just be counted. Without this an app that snoozed behind
    // `window.hide()` stays snoozed with its window off screen.
    if (BrowserWindow.getAllWindows().length === 0 || !anyWindowVisible()) revealMainWindow()
  })
})

app.on('window-all-closed', () => {
  repositorySessions.stopAll()
  terminalService.killAll()
  agentService.cancelAll()
  if (process.platform !== 'darwin') app.quit()
})

// An install (`pkill Kodi`) or a test harness ends the app with SIGTERM. It is
// a quit like any other, flushing the session and localStorage, but with nobody
// there to answer an unsaved-draft prompt; one that hangs, or a second signal,
// still exits.
const QUIT_ON_SIGNAL_TIMEOUT_MS = 3_000
let quitOnSignal = false
function quitOnTerminationSignal(): void {
  if (quitOnSignal) app.exit(0)
  quitOnSignal = true
  setTimeout(() => app.exit(0), QUIT_ON_SIGNAL_TIMEOUT_MS).unref()
  app.quit()
}

let sessionFlushedOnQuit = false
app.on('before-quit', (event) => {
  terminalService.killAll()
  // The Claude CLI and the codex app-server (with the user's MCP servers behind
  // it) are children of this process but are not killed with it.
  agentService.cancelAll()
  if (sessionFlushedOnQuit) return
  event.preventDefault()
  // Chromium commits localStorage (drafts, viewed files, agent chats) up to a
  // few seconds after a write; a quit inside that window — an install, a
  // SIGTERM — dropped it.
  session.defaultSession.flushStorageData()
  flushPendingWorkspaceCache()
  void Promise.all([flushSessionState(), flushWorkspaceCache()]).finally(() => {
    sessionFlushedOnQuit = true
    // Never from this handler's own microtasks: with nothing left to write they
    // run before the quit that emitted before-quit has returned, and that quit
    // then marks itself cancelled once the inner one has closed the windows.
    // The app stayed up with no window, holding the single-instance lock, so
    // every later launch and `kodi .` went to a process that showed nothing.
    setImmediate(() => app.quit())
  })
})
