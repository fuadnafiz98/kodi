import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { stat } from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, nativeTheme, screen, shell, type RenderProcessGoneDetails, type WebContents } from 'electron'

import {
  IPC_CHANNELS,
  type MainStartupMetrics,
  type PerformanceMetricsDetail,
  type LocalReviewProgress,
  type PullRequestFolderPreview,
  type RendererTermination,
  type RepositorySnapshot
} from '../shared/contracts.js'
import { displayUserPath, folderNameFromPath } from '../shared/folderPath.js'
import { findHorusReviewRequest, HORUS_PROTOCOL, parseHorusReviewUrl, type HorusReviewRequest } from '../shared/horusUrl.js'
import {
  extractGitHubPullRequestUrl,
  githubRepoSlugFromPullRequestUrl,
  normalizeGitHubPullRequestUrl
} from '../shared/pullRequestUrl.js'
import { AgentService, coalesceAgentTextEvents } from './agentService.js'
import { parseAgentAskRequest } from './agentRequest.js'
import { FolderIndex, resolveOpenableFolder } from './folderIndex.js'
import { loadMarkdownMedia } from './markdownMedia.js'
import { isPathWithinApprovedRoots, parseRemotes, pullRequestTargetsRemotes } from './repository.js'
import { PullRequestRootResolver } from './pullRequestRoots.js'
import { clipboardWarmupDecision, warmupCooledDown } from './pullRequestWarmup.js'
import { runCommand } from './gitCommands.js'
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
  workspaceCacheForRoot,
  type WorkspaceCache,
  type WorkspaceCacheStore,
  type WorkspaceUiState
} from '../shared/workspaceCache.js'
import {
  DEFAULT_SESSION_STATE,
  flushSessionState,
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
import { loadWindowState, saveWindowState } from './windowState.js'

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in main:', error)
})

const PRODUCT_NAME = 'Horus'
const startHidden = process.env.HORUS_BACKGROUND === '1'
const CLIPBOARD_WARMUP_MS = 2_000
const WARMUP_COOLDOWN_MS = 60_000
// How long the open request waits for the checkout before it goes without one.
const EXTERNAL_REVIEW_ROOT_DEADLINE_MS = 150
const remoteDebuggingPort = process.env.HORUS_REMOTE_DEBUGGING_PORT?.trim()
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
let persistWorkspaceTimer: ReturnType<typeof setTimeout> | null = null
const WORKSPACE_CACHE_SAVE_DEBOUNCE_MS = 1_000
let holdWindowHidden = startHidden
let pendingOpenPullRequestUrl: string | null = null
let pendingOpenPullRequestRoot: string | null = null
const queuedExternalReviews: HorusReviewRequest[] = []
const warmupFlights = new Map<string, Promise<void>>()
const recentlyWarmedAt = new Map<string, number>()

function enqueueExternalReview(request: HorusReviewRequest): void {
  queuedExternalReviews.push(request)
}

function revealMainWindow(): void {
  holdWindowHidden = false
  if (process.platform === 'darwin') app.dock?.show()
  const existing = BrowserWindow.getAllWindows()[0]
  const window = existing == null || existing.isDestroyed() ? createMainWindow() : existing
  revealExistingWindow(window)
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

async function applyExternalReview(request: HorusReviewRequest): Promise<void> {
  if (!shouldRevealForReview(request.intent)) {
    await warmupPullRequest(request.url)
    return
  }
  pendingOpenPullRequestUrl = request.url
  pendingOpenPullRequestRoot = null
  revealMainWindow()
  // The renderer has to resolve the checkout before it can ask for the review, so
  // the answer rides along with the open request. Bounded: a resolution that has
  // to walk the folder catalog must not hold the tab back.
  pendingOpenPullRequestRoot = await Promise.race([
    pullRequestRoots.resolve(request.url, 'quick').catch(() => null),
    delay(EXTERNAL_REVIEW_ROOT_DEADLINE_MS).then(() => null)
  ])
  publishPendingOpenPullRequest()
  void primePullRequest(request.url).catch((error: unknown) => {
    console.warn(`Could not prime pull request ${request.url}:`, error)
  })
}

function acceptExternalReview(value: string): void {
  const request = parseHorusReviewUrl(value)
  if (request == null) return
  if (app.isReady()) void applyExternalReview(request)
  else enqueueExternalReview(request)
}

function startClipboardWarmup(): void {
  let seen = clipboard.readText()
  // Nothing on screen means nobody is about to press Cmd+H, and a hidden Horus
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
  setInterval(pollClipboard, CLIPBOARD_WARMUP_MS)
  app.on('browser-window-focus', pollClipboard)
  app.on('activate', pollClipboard)
}

const launchRequest = findHorusReviewRequest(process.argv)
if (launchRequest != null) enqueueExternalReview(launchRequest)
app.on('open-url', (event, url) => {
  event.preventDefault()
  acceptExternalReview(url)
})
// Only the installed app owns horus://. A `bun run dev` registration would
// steal the scheme from ~/Applications/Horus.app and break Raycast.
if (app.isPackaged) app.setAsDefaultProtocolClient(HORUS_PROTOCOL)

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

// Nothing here touches the disk: the write is debounced so a burst of publishes
// costs one file, and it never runs on the tick that produced the snapshot.
function rememberWorkspaceCache(next: WorkspaceCache): void {
  workspaceCacheStore = rememberWorkspaceCacheEntry(workspaceCacheStore, next)
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

  const write = (): void => {
    if (window.isDestroyed()) return
    saveWindowState(userDataPath, { ...window.getNormalBounds(), maximized: window.isMaximized() })
  }

  const schedule = (): void => {
    if (timer != null) clearTimeout(timer)
    timer = setTimeout(write, GEOMETRY_SAVE_DEBOUNCE_MS)
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
    backgroundColor: WINDOW_BACKGROUND[sessionState.themeType],
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
  window.on('closed', clearRecoveryTimer)
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
): Promise<Pick<PerformanceMetricsDetail, 'mainStartup' | 'memoryByProcessType' | 'mainPrivateMegabytes'>> {
  const mainMemory = await process.getProcessMemoryInfo()
  const megabytesByType = new Map<string, number>()
  for (const metric of processMetrics) {
    megabytesByType.set(
      metric.type,
      (megabytesByType.get(metric.type) ?? 0) + metric.memory.workingSetSize / 1_024
    )
  }
  return {
    mainStartup: { ...mainStartupMetrics },
    memoryByProcessType: [...megabytesByType]
      .map(([type, megabytes]) => ({ type, megabytes }))
      .sort((left, right) => right.megabytes - left.megabytes),
    mainPrivateMegabytes: mainMemory.private / 1_024
  }
}

async function openRepository(folderPath: string, activate = true): Promise<RepositorySnapshot> {
  // The one `realpath` of the open path. `repositorySessions.open` is told the
  // path is already resolved so it does not repeat it, and the cache lookup and
  // the kind probe both work off this value.
  const resolved = resolveExistingRoot(folderPath)
  if (resolved == null) throw new Error('That folder is no longer on disk.')

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
    const live = repositorySessions.getActiveSnapshot()
    if (live != null) return live
    // Returning a cache JSON blob without hydrate made the renderer apply
    // Makefile and call get-comparison with no session — Welcome + that toast.
    const recovered = hydrateLastWorkspace()
    if (recovered != null) startLiveRefresh(recovered.root)
    return recovered
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
  ipcMain.handle(IPC_CHANNELS.activateRepository, (_event, root: unknown) =>
    repositorySessions.activate(requireRepositoryRoot(root)))
  ipcMain.handle(IPC_CHANNELS.releaseRepository, (_event, root: unknown) =>
    repositorySessions.release(requireRepositoryRoot(root)))
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
  ipcMain.handle(IPC_CHANNELS.refresh, () => repositorySessions.requireActive().refresh().then(trackSnapshot))
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
  ipcMain.handle(IPC_CHANNELS.saveWorkingFile, async (_event, request: unknown) => {
    const repository = repositorySessions.requireActive()
    const comparison = await repository.saveWorkingFile(request)
    const snapshot = repository.getSessionSnapshot()
    if (snapshot != null) trackSnapshot(snapshot)
    return comparison
  })
  ipcMain.handle(IPC_CHANNELS.getWorkingTreePatch, (event, paths: unknown, requestId: unknown) => {
    const send = localReviewProgressSender(event.sender, requestId)
    return repositorySessions.requireActive().getWorkingTreePatch(
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
  })
  ipcMain.handle(IPC_CHANNELS.searchContent, (_event, query: string, forOpenPath: unknown) =>
    repositorySessions.requireActive().searchContent(
      query,
      typeof forOpenPath === 'string' ? forOpenPath : null
    )
  )
  ipcMain.on(IPC_CHANNELS.cancelContentSearch, () => repositorySessions.cancelActiveContentSearch())
  ipcMain.handle(IPC_CHANNELS.getMarkdownMedia, (_event, url: unknown) => loadMarkdownMedia(url))
  ipcMain.handle(IPC_CHANNELS.getGitIntegration, () => repositorySessions.requireActive().getGitIntegration())
  ipcMain.handle(IPC_CHANNELS.getPullRequestInbox, () => repositorySessions.requireActive().getPullRequestInbox())
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
  ipcMain.handle(IPC_CHANNELS.getPullRequestConversation, (_event, root: unknown, selector: number | string) =>
    repositorySessions.require(requireRepositoryRoot(root)).getPullRequestConversation(selector))
  ipcMain.handle(IPC_CHANNELS.replyToPullRequestThread, (_event, root: unknown, threadId: unknown, body: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).replyToPullRequestThread(threadId, body))
  ipcMain.handle(IPC_CHANNELS.setPullRequestThreadResolved, (_event, root: unknown, threadId: unknown, resolved: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).setPullRequestThreadResolved(threadId, resolved))
  ipcMain.handle(IPC_CHANNELS.mergePullRequest, (_event, root: unknown, selector: number | string, strategy: unknown) =>
    repositorySessions.require(requireRepositoryRoot(root)).mergePullRequest(selector, strategy))
  ipcMain.handle(IPC_CHANNELS.markPullRequestReady, (_event, root: unknown, selector: number | string) =>
    repositorySessions.require(requireRepositoryRoot(root)).markPullRequestReady(selector))
  ipcMain.handle(IPC_CHANNELS.switchBranch, (_event, name: string) =>
    repositorySessions.requireActive().switchBranch(name).then(trackSnapshot)
  )
  ipcMain.handle(IPC_CHANNELS.getLocalBranchReview, (event, baseRef: string, headRef: string, requestId: unknown) =>
    repositorySessions.requireActive().getLocalBranchReview(
      baseRef,
      headRef,
      localReviewProgressSender(event.sender, requestId)
    )
  )
  ipcMain.handle(IPC_CHANNELS.getCommitReview, (event, oid: string, requestId: unknown) =>
    repositorySessions.requireActive().getCommitReview(
      oid,
      localReviewProgressSender(event.sender, requestId)
    )
  )
  ipcMain.handle(IPC_CHANNELS.fetchRemote, () => repositorySessions.requireActive().fetchRemote())
  ipcMain.handle(IPC_CHANNELS.pullCurrentBranch, () =>
    repositorySessions.requireActive().pullCurrentBranch().then(trackSnapshot)
  )
  ipcMain.handle(IPC_CHANNELS.pushCurrentBranch, () => repositorySessions.requireActive().pushCurrentBranch())
  ipcMain.handle(IPC_CHANNELS.getPullRequestReview, (event, root: unknown, selector: number | string, requestId: unknown) => {
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
    }, requestId)
  })
  ipcMain.handle(IPC_CHANNELS.checkoutPullRequest, (_event, number: number) =>
    repositorySessions.requireActive().checkoutPullRequest(number).then(trackSnapshot)
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
    const { themeType, restoreLastFolder } = preferences as Record<string, unknown>
    if (themeType !== 'dark' && themeType !== 'light') throw new Error('Theme type must be dark or light.')
    if (typeof restoreLastFolder !== 'boolean') throw new Error('restoreLastFolder must be a boolean.')
    if (sessionState.themeType === themeType && sessionState.restoreLastFolder === restoreLastFolder) return
    const repainting = sessionState.themeType !== themeType
    sessionState = { ...sessionState, themeType, restoreLastFolder }
    void saveSessionState(userDataPath, sessionState)
    // setBackgroundColor can flash on some macOS versions, so only on a real change.
    if (!repainting) return
    nativeTheme.themeSource = themeType
    BrowserWindow.fromWebContents(event.sender)?.setBackgroundColor(WINDOW_BACKGROUND[themeType])
  })
  ipcMain.handle(IPC_CHANNELS.setVisibility, (_event, visible: unknown) => {
    if (typeof visible !== 'boolean') throw new Error('Visibility must be a boolean.')
    repositorySessions.setSuspended(!visible)
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
  const snapshot = hydrateLastWorkspace()
  if (snapshot == null) {
    restoreLastSession = Promise.resolve(null)
    markMainStartup('restoreSettled')
    return
  }
  startLiveRefresh(snapshot.root)
}

app.whenReady().then(() => {
  markMainStartup('appReady')
  userDataPath = app.getPath('userData')
  repositorySessions.setPullRequestCacheDirectory(join(userDataPath, 'pr-cache'))
  sessionState = loadSessionState(userDataPath)
  workspaceCacheStore = loadWorkspaceCache(userDataPath)
  nativeTheme.themeSource = sessionState.themeType
  app.setAboutPanelOptions({ applicationName: PRODUCT_NAME })
  const initialReviews = queuedExternalReviews.splice(0)
  holdWindowHidden = shouldHoldWindowHidden(startHidden, initialReviews)
  if (startHidden || holdWindowHidden) app.dock?.hide()
  registerIpcHandlers()
  // Half-bounce first. Hydrating 20k cached paths must not delay window.show()
  // or the pending PR URL that Cmd+H / horus:// already queued.
  createMainWindow()
  for (const request of initialReviews) void applyExternalReview(request)
  // Hydrating the cached workspace — up to 25,000 paths — runs after the window
  // has been handed to the compositor, not in the same tick as its creation.
  setImmediate(beginSessionRestore)
  void loadLastRendererTermination()
  applyDevelopmentDockIcon()
  void folderIndex.list(sessionState.approvedRoots)
  if (!startHidden) startClipboardWarmup()
  app.on('second-instance', (_event, argv) => {
    const request = findHorusReviewRequest(argv)
    if (request != null) {
      applyExternalReview(request)
      return
    }
    revealMainWindow()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  repositorySessions.stopAll()
  terminalService.killAll()
  agentService.cancelAll()
  if (process.platform !== 'darwin') app.quit()
})

let sessionFlushedOnQuit = false
app.on('before-quit', (event) => {
  terminalService.killAll()
  // The Claude CLI and the codex app-server (with the user's MCP servers behind
  // it) are children of this process but are not killed with it.
  agentService.cancelAll()
  if (sessionFlushedOnQuit) return
  event.preventDefault()
  flushPendingWorkspaceCache()
  void Promise.all([flushSessionState(), flushWorkspaceCache()]).finally(() => {
    sessionFlushedOnQuit = true
    app.quit()
  })
})
