import { contextBridge, ipcRenderer } from 'electron'

import type {
  AgentStreamEvent,
  FindInPageResult,
  PerformanceMetrics,
  PerformanceMetricsDetail,
  LocalReviewProgress,
  PullRequestReviewProgress,
  RepositoryApi,
  RepositoryChangeEvent,
  RepositorySnapshot,
  TerminalDataEvent,
  TerminalExitEvent
} from '../shared/contracts.js'
import { IPC_CHANNELS } from '../shared/contracts.js'
import { HeldPathCache, heldPathList } from '../shared/heldPaths.js'
import { applyRestoreHintToDocument, parseRestoreHint, restoreHintFromArgv } from '../shared/sessionRestore.js'
import { parseWorkspaceCache } from '../shared/workspaceCache.js'

// The detail main can supply; the renderer-local half is measured here.
type MainPerformanceDetail = Pick<
  PerformanceMetricsDetail,
  'mainStartup' | 'memoryByProcessType' | 'mainPrivateMegabytes'
>

const MAX_COUNTED_RENDERER_DOM_NODES = 500_000

interface RendererElement {
  shadowRoot?: RendererQueryRoot | null
}

interface RendererQueryRoot {
  querySelectorAll(selector: string): ArrayLike<RendererElement>
}

function countRendererDomNodes(root: RendererQueryRoot | undefined): number {
  if (root == null) return 0
  const roots: RendererQueryRoot[] = [root]
  let count = 0

  while (roots.length > 0 && count < MAX_COUNTED_RENDERER_DOM_NODES) {
    const current = roots.pop()
    if (current == null) continue
    const elements = current.querySelectorAll('*')
    count = Math.min(MAX_COUNTED_RENDERER_DOM_NODES, count + elements.length)
    for (let index = 0; index < elements.length && count < MAX_COUNTED_RENDERER_DOM_NODES; index += 1) {
      const shadowRoot = elements[index]?.shadowRoot
      if (shadowRoot != null) roots.push(shadowRoot)
    }
  }

  return count
}

const restoreHint = restoreHintFromArgv(process.argv)
  ?? parseRestoreHint(ipcRenderer.sendSync(IPC_CHANNELS.getRestoreHint))
const cachedWorkspace = parseWorkspaceCache(ipcRenderer.sendSync(IPC_CHANNELS.getWorkspaceCache))
const bootDocument = (globalThis as { document?: { documentElement?: { dataset: Record<string, string | undefined> } } }).document
applyRestoreHintToDocument(bootDocument?.documentElement, restoreHint)

// Every snapshot main sends passes through here first, so the path list the
// renderer was last given is known without asking it. A mutation names that
// list in its request and main leaves it out of the reply.
const heldPaths = new HeldPathCache()

function rememberSnapshot<Value>(reply: Promise<Value>): Promise<Value> {
  return reply.then((value) => {
    heldPaths.remember(value)
    return value
  })
}

function invokeSnapshotMutation(channel: string, ...args: unknown[]): Promise<RepositorySnapshot> {
  const claim = heldPaths.claim()
  return ipcRenderer.invoke(channel, ...args, heldPathList(claim))
    .then((reply: unknown) => heldPaths.complete(reply, claim))
}

const repositoryApi: RepositoryApi = {
  restoreHint,
  cachedWorkspace,
  persistWorkspaceUi: (ui) => ipcRenderer.invoke(IPC_CHANNELS.persistWorkspaceUi, ui),
  persistFileText: (fileText) => ipcRenderer.invoke(IPC_CHANNELS.persistFileText, fileText),
  getSessionSnapshot: () => rememberSnapshot(ipcRenderer.invoke(IPC_CHANNELS.getSessionSnapshot)),
  openFolder: () => rememberSnapshot(ipcRenderer.invoke(IPC_CHANNELS.openFolder)),
  chooseFolder: () => ipcRenderer.invoke(IPC_CHANNELS.chooseFolder),
  listFolderCandidates: () => ipcRenderer.invoke(IPC_CHANNELS.listFolderCandidates),
  openPickedFolder: (path) => rememberSnapshot(ipcRenderer.invoke(IPC_CHANNELS.openPickedFolder, path)),
  openPath: (path) => rememberSnapshot(ipcRenderer.invoke(IPC_CHANNELS.openPath, path)),
  activateRepository: (root) => rememberSnapshot(ipcRenderer.invoke(IPC_CHANNELS.activateRepository, root)),
  releaseRepository: (root) => ipcRenderer.invoke(IPC_CHANNELS.releaseRepository, root),
  previewPullRequestFolder: (pullRequestUrl) =>
    ipcRenderer.invoke(IPC_CHANNELS.previewPullRequestFolder, pullRequestUrl),
  resolvePullRequestRepository: (pullRequestUrl, preferredRoot) =>
    ipcRenderer.invoke(IPC_CHANNELS.resolvePullRequestRepository, pullRequestUrl, preferredRoot),
  getPendingExternalPullRequest: () => ipcRenderer.invoke(IPC_CHANNELS.getPendingExternalPullRequest),
  onOpenExternalPullRequest: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      url: string,
      root: string | null
    ): void => listener(url, root ?? null)
    ipcRenderer.on(IPC_CHANNELS.openExternalPullRequest, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.openExternalPullRequest, handler)
  },
  onOpenExternalFolder: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(IPC_CHANNELS.openExternalFolder, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.openExternalFolder, handler)
  },
  takeExternalFolder: () => rememberSnapshot(ipcRenderer.invoke(IPC_CHANNELS.takeExternalFolder)),
  onHibernateRequest: (listener) => {
    const handler = (): void => {
      // The answer rides straight back on its own channel: main has no reply
      // path for a pushed event, and it needs the refusal reason, not just the
      // fact of one.
      let blockedBy: string | null = 'the window did not answer'
      try {
        blockedBy = listener()
      } catch (error) {
        blockedBy = error instanceof Error ? error.message : 'the window failed to hibernate'
      }
      ipcRenderer.send(IPC_CHANNELS.hibernationState, blockedBy)
    }
    ipcRenderer.on(IPC_CHANNELS.hibernateRequest, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.hibernateRequest, handler)
  },
  readClipboardText: (type) => ipcRenderer.invoke(IPC_CHANNELS.readClipboardText, type),
  revealPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.revealPath, path),
  refresh: () => invokeSnapshotMutation(IPC_CHANNELS.refresh),
  getComparison: (path) => ipcRenderer.invoke(IPC_CHANNELS.getComparison, path),
  getRevisionFile: (revision, path) => ipcRenderer.invoke(IPC_CHANNELS.getRevisionFile, revision, path),
  ensurePullRequestRevisions: (pullRequestUrl, baseOid, headOid) =>
    ipcRenderer.invoke(IPC_CHANNELS.ensurePullRequestRevisions, pullRequestUrl, baseOid, headOid),
  saveWorkingFile: (request) => ipcRenderer.invoke(IPC_CHANNELS.saveWorkingFile, request),
  getWorkingTreePatch: (paths, requestId, root) =>
    ipcRenderer.invoke(IPC_CHANNELS.getWorkingTreePatch, paths, requestId ?? null, root ?? null),
  searchContent: (query, forOpenPath) => ipcRenderer.invoke(IPC_CHANNELS.searchContent, query, forOpenPath ?? null),
  cancelContentSearch: () => ipcRenderer.send(IPC_CHANNELS.cancelContentSearch),
  getMarkdownMedia: (url) => ipcRenderer.invoke(IPC_CHANNELS.getMarkdownMedia, url),
  getAvatar: (url) => ipcRenderer.invoke(IPC_CHANNELS.getAvatar, url),
  getGitIntegration: (options) => ipcRenderer.invoke(IPC_CHANNELS.getGitIntegration, options),
  getRepositoryPullRequests: () => ipcRenderer.invoke(IPC_CHANNELS.getRepositoryPullRequests),
  getPullRequestInbox: () => ipcRenderer.invoke(IPC_CHANNELS.getPullRequestInbox),
  getGlobalPullRequestInbox: (repos) => ipcRenderer.invoke(IPC_CHANNELS.getGlobalPullRequestInbox, repos),
  getClosedPullRequests: () => ipcRenderer.invoke(IPC_CHANNELS.getClosedPullRequests),
  getPullRequestConversation: (root: string, selector: number | string, force?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.getPullRequestConversation, root, selector, force === true),
  replyToPullRequestThread: (root: string, threadId: string, body: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.replyToPullRequestThread, root, threadId, body),
  setPullRequestThreadResolved: (root: string, threadId: string, resolved: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setPullRequestThreadResolved, root, threadId, resolved),
  mergePullRequest: (root, selector, strategy) => ipcRenderer.invoke(IPC_CHANNELS.mergePullRequest, root, selector, strategy),
  markPullRequestReady: (root, selector) => ipcRenderer.invoke(IPC_CHANNELS.markPullRequestReady, root, selector),
  switchBranch: (root, name) => invokeSnapshotMutation(IPC_CHANNELS.switchBranch, root, name),
  getLocalBranchReview: (baseRef, headRef, requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getLocalBranchReview, baseRef, headRef, requestId ?? null),
  getLocalSnapshotReview: (baseOid, headOid, baseRefName, headRefName) =>
    ipcRenderer.invoke(IPC_CHANNELS.getLocalSnapshotReview, baseOid, headOid, baseRefName, headRefName),
  getCommitReview: (oid, requestId) =>
    ipcRenderer.invoke(IPC_CHANNELS.getCommitReview, oid, requestId ?? null),
  fetchRemote: (root) => ipcRenderer.invoke(IPC_CHANNELS.fetchRemote, root),
  pullCurrentBranch: (root) => invokeSnapshotMutation(IPC_CHANNELS.pullCurrentBranch, root),
  pushCurrentBranch: (root) => ipcRenderer.invoke(IPC_CHANNELS.pushCurrentBranch, root),
  stagePaths: (root, paths) => invokeSnapshotMutation(IPC_CHANNELS.stagePaths, root, paths),
  unstagePaths: (root, paths) => invokeSnapshotMutation(IPC_CHANNELS.unstagePaths, root, paths),
  discardPaths: (root, paths) => invokeSnapshotMutation(IPC_CHANNELS.discardPaths, root, paths),
  commitChanges: (root, request) => invokeSnapshotMutation(IPC_CHANNELS.commitChanges, root, request),
  getPullRequestReview: (root, selector, requestId, refresh) =>
    ipcRenderer.invoke(IPC_CHANNELS.getPullRequestReview, root, selector, requestId, refresh === true),
  cancelPullRequestReview: (root, requestId) =>
    ipcRenderer.send(IPC_CHANNELS.cancelPullRequestReview, root, requestId),
  checkoutPullRequest: (root, number) => invokeSnapshotMutation(IPC_CHANNELS.checkoutPullRequest, root, number),
  submitPullRequestReview: (root, selector, commitId, event, body, comments) => ipcRenderer.invoke(IPC_CHANNELS.submitPullRequestReview, root, selector, commitId, event, body, comments),
  getAgentModels: () => ipcRenderer.invoke(IPC_CHANNELS.getAgentModels),
  getAgentStatuses: (provider) => ipcRenderer.invoke(IPC_CHANNELS.getAgentStatuses, provider),
  loginAgent: (provider) => ipcRenderer.invoke(IPC_CHANNELS.loginAgent, provider),
  askAgent: (request) => ipcRenderer.invoke(IPC_CHANNELS.askAgent, request),
  cancelAgent: (id) => ipcRenderer.invoke(IPC_CHANNELS.cancelAgent, id),
  respondAgentApproval: (requestId, decision) =>
    ipcRenderer.invoke(IPC_CHANNELS.respondAgentApproval, requestId, decision),
  onAgentEvent: (listener) => {
    const handler = (_event: unknown, agentEvent: AgentStreamEvent): void => listener(agentEvent)
    ipcRenderer.on(IPC_CHANNELS.agentEvent, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.agentEvent, handler)
    }
  },
  createTerminal: (columns, rows) => ipcRenderer.invoke(IPC_CHANNELS.createTerminal, columns, rows),
  readyTerminal: (sessionId) => ipcRenderer.send(IPC_CHANNELS.readyTerminal, sessionId),
  writeTerminal: (sessionId, data) => {
    const chunkSize = 64 * 1_024
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      ipcRenderer.send(IPC_CHANNELS.writeTerminal, sessionId, data.slice(offset, offset + chunkSize))
    }
  },
  resizeTerminal: (sessionId, columns, rows) =>
    ipcRenderer.send(IPC_CHANNELS.resizeTerminal, sessionId, columns, rows),
  clearTerminal: (sessionId) => ipcRenderer.send(IPC_CHANNELS.clearTerminal, sessionId),
  setTerminalVisibility: (sessionId, visible) =>
    ipcRenderer.send(IPC_CHANNELS.setTerminalVisibility, sessionId, visible),
  killTerminal: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.killTerminal, sessionId),
  onTerminalData: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, terminalEvent: TerminalDataEvent): void => {
      listener(terminalEvent)
    }
    ipcRenderer.on(IPC_CHANNELS.terminalData, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.terminalData, handler)
  },
  onTerminalExit: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, terminalEvent: TerminalExitEvent): void => {
      listener(terminalEvent)
    }
    ipcRenderer.on(IPC_CHANNELS.terminalExit, handler)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.terminalExit, handler)
  },
  getPerformanceMetrics: async (detailed) => {
    const [mainMetrics, rendererMemory] = await Promise.all([
      ipcRenderer.invoke(IPC_CHANNELS.getPerformanceMetrics, detailed) as Promise<
        Omit<PerformanceMetrics, 'rendererPrivateMegabytes' | 'detail'> & { detail: MainPerformanceDetail | null }>,
      process.getProcessMemoryInfo()
    ])
    const metrics: PerformanceMetrics = {
      ...mainMetrics,
      rendererPrivateMegabytes: rendererMemory.private / 1_024,
      detail: null
    }
    if (!detailed || mainMetrics.detail == null) return metrics
    const heap = process.getHeapStatistics()
    const rendererDocument = (globalThis as unknown as { document?: RendererQueryRoot }).document
    metrics.detail = {
      ...mainMetrics.detail,
      rendererHeapUsedMegabytes: heap.usedHeapSize / 1_024,
      rendererHeapTotalMegabytes: heap.totalHeapSize / 1_024,
      rendererDomNodes: countRendererDomNodes(rendererDocument)
    }
    return metrics
  },
  setVisibility: (visible) => ipcRenderer.invoke(IPC_CHANNELS.setVisibility, visible),
  setStartupPreferences: (preferences) => ipcRenderer.invoke(IPC_CHANNELS.setStartupPreferences, preferences),
  findInPage: (query, forward, findNext) => ipcRenderer.invoke(IPC_CHANNELS.findInPage, query, forward, findNext),
  stopFindInPage: () => ipcRenderer.invoke(IPC_CHANNELS.stopFindInPage),
  onFoundInPage: (listener) => {
    const handleResult = (_event: Electron.IpcRendererEvent, result: FindInPageResult): void => listener(result)
    ipcRenderer.on(IPC_CHANNELS.foundInPage, handleResult)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.foundInPage, handleResult)
  },
  onFullscreenChange: (listener) => {
    const handleChange = (_event: Electron.IpcRendererEvent, fullscreen: boolean): void => listener(fullscreen)
    ipcRenderer.on(IPC_CHANNELS.fullscreenChange, handleChange)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.fullscreenChange, handleChange)
  },
  onDidChange: (listener) => {
    const handleChange = (_event: Electron.IpcRendererEvent, change: RepositoryChangeEvent): void => {
      heldPaths.rememberBroadcast(change.snapshot)
      listener(change)
    }
    ipcRenderer.on(IPC_CHANNELS.didChange, handleChange)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.didChange, handleChange)
  },
  onPullRequestReviewProgress: (listener) => {
    const handleProgress = (_event: Electron.IpcRendererEvent, progress: PullRequestReviewProgress): void => {
      listener(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.pullRequestReviewProgress, handleProgress)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.pullRequestReviewProgress, handleProgress)
  },
  onLocalReviewProgress: (listener) => {
    const handleProgress = (_event: Electron.IpcRendererEvent, progress: LocalReviewProgress): void => {
      listener(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.localReviewProgress, handleProgress)
    return () => ipcRenderer.removeListener(IPC_CHANNELS.localReviewProgress, handleProgress)
  }
}

contextBridge.exposeInMainWorld('repository', repositoryApi)
