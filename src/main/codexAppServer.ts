import { spawn, type ChildProcess } from 'node:child_process'

import {
  CODEX_METHODS,
  interpretCodexNotification,
  readCodexRateLimit,
  type CodexRateLimit
} from './codexProtocol.js'
import type { AgentStreamChunk } from './agentRequest.js'
import type {
  AgentAccessMode,
  AgentApprovalDecision,
  AgentApprovalRequest,
  AgentModelOption
} from '../shared/contracts.js'

// `codex exec --json` never emits token deltas — an agent message arrives whole
// when the turn ends, which is why Codex looked broken and then slow. The
// app-server speaks JSON-RPC over stdio and pushes `item/agentMessage/delta`,
// so this is the only transport that can stream.
const CODEX_STARTUP_TIMEOUT_MS = 30_000
// Like the Claude path: a turn is ended by silence, not by length, with an
// absolute ceiling so a wedged child cannot hold the panel forever.
const CODEX_TURN_IDLE_TIMEOUT_MS = 120_000
const CODEX_TURN_TIMEOUT_MS = 1_800_000
const CODEX_STDERR_TAIL = 8_000

interface PendingRequest {
  resolve(result: Record<string, unknown>): void
  reject(error: Error): void
}

export interface CodexTurnHandlers {
  onChunk(chunk: AgentStreamChunk): void
  onRateLimit?(limit: CodexRateLimit): void
  onApproval?(approval: AgentApprovalRequest): Promise<AgentApprovalDecision>
  /** The turn object of turn/completed, which carries `status` and `error`. */
  onTurnCompleted?(turn: Record<string, unknown>): void
}

export function getCodexThreadAccess(accessMode: AgentAccessMode): {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'never' | 'on-request'
} {
  if (accessMode === 'review') return { sandbox: 'read-only', approvalPolicy: 'never' }
  if (accessMode === 'auto') return { sandbox: 'workspace-write', approvalPolicy: 'on-request' }
  return { sandbox: 'danger-full-access', approvalPolicy: 'never' }
}

export function getCodexTurnSandbox(accessMode: AgentAccessMode, cwd: string): Record<string, unknown> {
  if (accessMode === 'review') return { type: 'readOnly', networkAccess: false }
  if (accessMode === 'auto') {
    return {
      type: 'workspaceWrite',
      writableRoots: [cwd],
      networkAccess: true,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false
    }
  }
  return { type: 'dangerFullAccess' }
}

// Provider errors arrive as the HTTP body's JSON in a string; its inner message
// is the sentence worth showing.
export function readCodexErrorMessage(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  try {
    const parsed = JSON.parse(value) as { error?: { message?: unknown }; message?: unknown }
    const inner = parsed.error?.message ?? parsed.message
    if (typeof inner === 'string' && inner !== '') return inner
  } catch {
    // Plain text already.
  }
  return value
}

function modelParams(model: string, effort: string): Record<string, string> {
  return {
    ...(model === '' || model === 'default' ? {} : { model }),
    ...(effort === '' || effort === 'default' ? {} : { effort })
  }
}

/**
 * Config overrides for a server that only answers in text: no MCP servers, no
 * shell, no web, browser, apps, plugins or sub-agents. A structured run's
 * prompt carries diff text from other people's pull requests, and
 * `approvalPolicy: 'never'` would let an injected instruction run whatever
 * tool the user's config enables. Unknown keys are ignored by older CLIs.
 */
export const CODEX_TOOLLESS_CONFIG: readonly string[] = [
  'mcp_servers={}',
  'web_search="disabled"',
  ...[
    'shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'browser_use', 'browser_use_external',
    'in_app_browser', 'computer_use', 'image_generation', 'view_image', 'multi_agent', 'hooks', 'tool_suggest',
    'skill_search', 'skill_mcp_dependency_install', 'memories'
  ].map((feature) => `features.${feature}=false`)
]

export function codexServerArgs(configOverrides: readonly string[]): string[] {
  return ['app-server', ...configOverrides.flatMap((override) => ['-c', override])]
}

export class CodexAppServer {
  readonly #configOverrides: readonly string[]

  constructor(options: { configOverrides?: readonly string[] } = {}) {
    this.#configOverrides = options.configOverrides ?? []
  }

  #child: ChildProcess | null = null
  #pending = new Map<number, PendingRequest>()
  #handlers: CodexTurnHandlers | null = null
  #nextId = 0
  #buffer = ''
  #cwd: string | null = null
  #threadId: string | null = null
  #currentTurnId: string | null = null
  #agentMessagePhases = new Map<string, string>()
  // `turn/start` replies as soon as the turn is *created*, long before any text
  // arrives, so the turn is only finished when turn/completed or turn/failed lands.
  #turnCompletion: { resolve(): void; reject(error: Error): void } | null = null
  // Set while a turn runs: every notification re-arms its idle timer.
  #turnActivity: (() => void) | null = null
  // The child logs MCP startup and tracing here. Nothing read it before, so the
  // 64 KB pipe filled and the JSON-RPC stream stalled with the explanation stuck
  // inside it; a bounded tail is both the drain and the diagnostic.
  #stderrTail = ''

  // The server loads the user's MCP servers on start, which takes seconds, so one
  // process is reused for every turn in the same working directory.
  async #ensureStarted(cwd: string, executable: string): Promise<void> {
    if (this.#child != null && this.#cwd === cwd && this.#child.exitCode == null) return
    this.#killChild()
    this.#cwd = cwd

    this.#stderrTail = ''
    const child = spawn(executable, codexServerArgs(this.#configOverrides), { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    this.#child = child
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.#readStdout(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-CODEX_STDERR_TAIL)
    })
    // Without this listener a missing `codex` binary is an unhandled 'error'
    // event, which takes the whole main process down with it.
    child.once('error', (error: Error) => {
      // A replaced child can report its spawn error after the new child starts.
      // Do not reject requests owned by the replacement.
      if (this.#child !== child) return
      this.#child = null
      this.#cwd = null
      this.#threadId = null
      this.#abort(error)
    })
    child.on('exit', () => {
      // `exit` is async: a child killed by stop()/#ensureStarted can outlive its
      // own replacement, and aborting here would reject the new child's work.
      if (this.#child !== child) return
      this.#abort(new Error(this.#describeFailure('Codex stopped before answering.')))
      this.#child = null
      this.#threadId = null
    })

    await this.#request(CODEX_METHODS.initialize, {
      clientInfo: { name: 'kodi', title: 'Kodi', version: '0.1.0' }
    }, CODEX_STARTUP_TIMEOUT_MS)
  }

  #abort(error: Error): void {
    for (const request of this.#pending.values()) request.reject(error)
    this.#pending.clear()
    this.#finishTurn(error)
  }

  #describeFailure(message: string): string {
    const tail = this.#stderrTail.trim()
    return tail === '' ? message : `${message}\n${tail.slice(-2_000)}`
  }

  #readStdout(chunk: string): void {
    this.#buffer += chunk
    let newline = this.#buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      newline = this.#buffer.indexOf('\n')
      if (line.trim() === '') continue
      let message: Record<string, unknown>
      try {
        message = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      this.#dispatch(message)
    }
  }

  #dispatch(message: Record<string, unknown>): void {
    // Set KODI_CODEX_DEBUG=1 to trace the JSON-RPC traffic; the
    // protocol is experimental and its method names have moved before.
    if (process.env.KODI_CODEX_DEBUG === '1') {
      process.stderr.write(`codex ← ${JSON.stringify(message).slice(0, 300)}\n`)
    }
    if (typeof message.method === 'string') {
      if (message.id != null) {
        this.#handleServerRequest(message)
        return
      }
      this.#turnActivity?.()
      const notification = { method: message.method, params: message.params }
      const params = (typeof message.params === 'object' && message.params != null
        ? message.params
        : {}) as Record<string, unknown>
      const item = typeof params.item === 'object' && params.item != null
        ? params.item as Record<string, unknown>
        : null
      const itemId = typeof item?.id === 'string'
        ? item.id
        : typeof params.itemId === 'string' ? params.itemId : null
      if (message.method === 'item/started' && item?.type === 'agentMessage' &&
          itemId != null && typeof item.phase === 'string') {
        this.#agentMessagePhases.set(itemId, item.phase)
      }
      const agentMessagePhase = itemId == null ? undefined : this.#agentMessagePhases.get(itemId)
      // Remember the live turn so Stop can interrupt precisely this one.
      if (message.method === 'turn/started') {
        const turn = (message.params as { turn?: { id?: unknown } } | undefined)?.turn
        if (typeof turn?.id === 'string') this.#currentTurnId = turn.id
      }
      if (message.method === 'turn/completed') {
        const turn = params.turn
        if (typeof turn === 'object' && turn != null) this.#handlers?.onTurnCompleted?.(turn as Record<string, unknown>)
        this.#finishTurn(null)
      }
      if (message.method === 'turn/failed') this.#finishTurn(null)
      const limit = readCodexRateLimit(notification)
      if (limit != null) this.#handlers?.onRateLimit?.(limit)
      const chunk = interpretCodexNotification(notification, agentMessagePhase)
      if (chunk != null) this.#handlers?.onChunk(chunk)
      if (message.method === 'item/completed' && itemId != null) this.#agentMessagePhases.delete(itemId)
      return
    }
    if (typeof message.id !== 'number') return
    const request = this.#pending.get(message.id)
    if (request == null) return
    this.#pending.delete(message.id)
    if (message.error != null) {
      const error = message.error as { message?: unknown }
      request.reject(new Error(typeof error.message === 'string' ? error.message : 'Codex rejected the request.'))
      return
    }
    request.resolve((message.result ?? {}) as Record<string, unknown>)
  }

  #handleServerRequest(message: Record<string, unknown>): void {
    const method = message.method
    const requestId = message.id
    if (requestId == null || typeof method !== 'string') return
    if (method === 'item/tool/requestUserInput') {
      this.#replyToServer(requestId, { answers: {} })
      return
    }
    if (method === 'mcpServer/elicitation/request') {
      this.#replyToServer(requestId, { action: 'decline', content: null, _meta: null })
      return
    }
    if (method === 'currentTime/read') {
      this.#replyToServer(requestId, { currentTimeAt: Math.floor(Date.now() / 1_000) })
      return
    }
    if (method !== 'item/commandExecution/requestApproval' &&
        method !== 'item/fileChange/requestApproval' &&
        method !== 'item/permissions/requestApproval') {
      this.#replyToServer(requestId, null, {
        code: -32601,
        message: `Kodi does not implement ${method}.`
      })
      return
    }
    const params = (typeof message.params === 'object' && message.params != null
      ? message.params
      : {}) as Record<string, unknown>
    const itemId = typeof params.itemId === 'string' ? params.itemId : `codex-item-${String(requestId)}`
    const command = typeof params.command === 'string' ? params.command : ''
    const reason = typeof params.reason === 'string' ? params.reason : ''
    const permissions = typeof params.permissions === 'object' && params.permissions != null
      ? params.permissions as Record<string, unknown>
      : null
    const type = method === 'item/commandExecution/requestApproval'
      ? 'command'
      : method === 'item/fileChange/requestApproval' ? 'file-change' : 'permissions'
    const approval: AgentApprovalRequest = {
      requestId: `codex-${String(requestId)}`,
      itemId,
      type,
      title: type === 'command'
        ? 'Allow command?'
        : type === 'file-change' ? 'Allow file changes?' : 'Allow extra access?',
      detail: command || reason || (permissions == null
        ? 'The agent needs permission to continue.'
        : JSON.stringify(permissions))
    }
    const decide = this.#handlers?.onApproval?.(approval) ?? Promise.resolve('decline')
    void decide.then((decision) => {
      const result = type === 'permissions'
        ? {
            permissions: decision === 'decline' || permissions == null ? {} : permissions,
            scope: decision === 'acceptForSession' ? 'session' : 'turn'
          }
        : { decision }
      this.#replyToServer(requestId, result)
    }).catch(() => {
      this.#replyToServer(requestId, type === 'permissions'
        ? { permissions: {}, scope: 'turn' }
        : { decision: 'decline' })
    })
  }

  #replyToServer(
    id: unknown,
    result: Record<string, unknown> | null,
    error?: { code: number; message: string }
  ): void {
    const child = this.#child
    if (child == null || child.exitCode != null) return
    const response = error == null
      ? { jsonrpc: '2.0', id, result }
      : { jsonrpc: '2.0', id, error }
    child.stdin?.write(`${JSON.stringify(response)}\n`)
  }

  #finishTurn(error: Error | null): void {
    const completion = this.#turnCompletion
    if (completion == null) return
    this.#turnCompletion = null
    if (error == null) completion.resolve()
    else completion.reject(error)
  }

  #request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number
  ): Promise<Record<string, unknown>> {
    const child = this.#child
    if (child == null) return Promise.reject(new Error('Codex is not running.'))
    const id = ++this.#nextId
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Codex did not respond to ${method}.`))
      }, timeoutMs)
      this.#pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout)
          resolve(result)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        }
      })
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async ask(options: {
    executable: string
    cwd: string
    prompt: string
    model: string
    effort: string
    accessMode: AgentAccessMode
    resumeThreadId?: string
    handlers: CodexTurnHandlers
  }): Promise<void> {
    const { executable, cwd, prompt, model, effort, accessMode, resumeThreadId, handlers } = options
    // Registered after the server is up: starting it tears down any previous
    // child, and that teardown clears the handler slot.
    await this.#ensureStarted(cwd, executable)
    this.#handlers = handlers

    if (this.#threadId == null) {
      const access = getCodexThreadAccess(accessMode)
      const threadParams = {
        cwd,
        sandbox: access.sandbox,
        approvalPolicy: access.approvalPolicy,
        ...(model === '' || model === 'default' ? {} : { model })
      }
      const started = resumeThreadId == null
        ? await this.#request(CODEX_METHODS.threadStart, threadParams, CODEX_STARTUP_TIMEOUT_MS)
        : await this.#request(CODEX_METHODS.threadResume, {
            threadId: resumeThreadId,
            ...threadParams
          }, CODEX_STARTUP_TIMEOUT_MS)
      const thread = started.thread as { id?: unknown } | undefined
      // The id lives at result.thread.id, not result.threadId.
      const threadId = typeof thread?.id === 'string' ? thread.id : null
      if (threadId == null) throw new Error('Codex did not return a thread.')
      this.#threadId = threadId
      handlers.onChunk({ kind: 'session', sessionId: threadId })
    }

    await this.#runTurn({
      threadId: this.#threadId,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy: getCodexThreadAccess(accessMode).approvalPolicy,
      sandboxPolicy: getCodexTurnSandbox(accessMode, cwd),
      summary: 'detailed',
      ...modelParams(model, effort)
    }, CODEX_TURN_TIMEOUT_MS)
  }

  // Starts a turn and waits for turn/completed or turn/failed: `turn/start`
  // replies as soon as the turn exists. Silence ends it, and so does the cap.
  async #runTurn(params: Record<string, unknown>, limitMs: number): Promise<void> {
    const completed = new Promise<void>((resolve, reject) => {
      this.#turnCompletion = { resolve, reject }
    })
    const deadline = Date.now() + limitMs
    let timeout: ReturnType<typeof setTimeout> | null = null
    const armTimeout = (): void => {
      if (timeout != null) clearTimeout(timeout)
      const remaining = deadline - Date.now()
      const reachedLimit = remaining <= CODEX_TURN_IDLE_TIMEOUT_MS
      timeout = setTimeout(() => this.#finishTurn(new Error(this.#describeFailure(reachedLimit
        ? 'Codex reached the maximum turn length.'
        : 'Codex stopped responding.'))), Math.max(0, reachedLimit ? remaining : CODEX_TURN_IDLE_TIMEOUT_MS))
    }
    armTimeout()
    this.#turnActivity = armTimeout
    try {
      await this.#request(CODEX_METHODS.turnStart, params, CODEX_STARTUP_TIMEOUT_MS)
      await completed
    } finally {
      if (timeout != null) clearTimeout(timeout)
      this.#turnActivity = null
      this.#turnCompletion = null
    }
  }

  /**
   * One schema-constrained answer on an ephemeral, read-only thread. Returns the
   * final agent message's text; the caller parses it. Any approval request is
   * declined, since nothing here may touch the machine.
   */
  async runStructured(options: {
    executable: string
    cwd: string
    prompt: string
    model: string
    effort: string
    schema: Record<string, unknown>
    timeoutMs: number
    onPhase?(phase: 'thinking' | 'writing'): void
  }): Promise<string> {
    const { executable, cwd, prompt, model, effort, schema, timeoutMs, onPhase } = options
    await this.#ensureStarted(cwd, executable)
    let message: string | null = null
    let streamed = ''
    let failure: string | null = null
    this.#handlers = {
      onChunk: (chunk) => {
        if (chunk.kind === 'activity' && (chunk.activity?.kind === 'reasoning' ||
            chunk.activities?.some((activity) => activity.kind === 'reasoning') === true)) {
          onPhase?.('thinking')
        } else if (chunk.kind === 'text' && chunk.text != null) {
          if (chunk.source === 'message') message = chunk.text
          else {
            streamed += chunk.text
            onPhase?.('writing')
          }
        } else if (chunk.kind === 'result' && chunk.failed === true) {
          failure = chunk.text == null || chunk.text === '' ? 'Codex could not finish the turn.' : chunk.text
        }
      },
      onApproval: () => Promise.resolve('decline'),
      // A refused model or a provider error ends the turn as `failed`, with no
      // turn/failed notification and no message.
      onTurnCompleted: (turn) => {
        if (turn.status !== 'failed') return
        const error = turn.error as { message?: unknown } | null | undefined
        failure = readCodexErrorMessage(error?.message) ?? 'Codex could not finish the turn.'
      }
    }
    const started = await this.#request(CODEX_METHODS.threadStart, {
      cwd,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ephemeral: true,
      ...modelParams(model, '')
    }, CODEX_STARTUP_TIMEOUT_MS)
    const thread = started.thread as { id?: unknown } | undefined
    const threadId = typeof thread?.id === 'string' ? thread.id : null
    if (threadId == null) throw new Error('Codex did not return a thread.')
    this.#threadId = threadId
    await this.#runTurn({
      threadId,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      outputSchema: schema,
      ...modelParams(model, effort)
    }, timeoutMs)
    if (failure != null) throw new Error(failure)
    const text = message ?? streamed
    if (text.trim() === '') throw new Error('The model did not return JSON.')
    return text
  }

  async listModels(executable: string, cwd: string): Promise<AgentModelOption[]> {
    await this.#ensureStarted(cwd, executable)
    const models: AgentModelOption[] = []
    let cursor: string | null = null
    do {
      const result = await this.#request(CODEX_METHODS.modelList, {
        limit: 100,
        ...(cursor == null ? {} : { cursor })
      }, CODEX_STARTUP_TIMEOUT_MS)
      const data = Array.isArray(result.data) ? result.data : []
      for (const candidate of data) {
        if (typeof candidate !== 'object' || candidate == null) continue
        const model = candidate as Record<string, unknown>
        const modelSlug = typeof model.model === 'string' ? model.model : model.id
        if (model.hidden === true || typeof modelSlug !== 'string') continue
        const efforts = Array.isArray(model.supportedReasoningEfforts)
          ? model.supportedReasoningEfforts.flatMap((option) => {
              if (typeof option !== 'object' || option == null) return []
              const value = (option as Record<string, unknown>).reasoningEffort
              return typeof value === 'string' ? [value] : []
            })
          : []
        models.push({
          id: modelSlug,
          label: typeof model.displayName === 'string' ? model.displayName : modelSlug,
          description: typeof model.description === 'string' ? model.description : '',
          efforts,
          defaultEffort: typeof model.defaultReasoningEffort === 'string'
            ? model.defaultReasoningEffort
            : efforts[0] ?? 'medium',
          ...(model.isDefault === true ? { default: true } : {})
        })
      }
      cursor = typeof result.nextCursor === 'string' ? result.nextCursor : null
    } while (cursor != null)
    return models
  }

  interrupt(): void {
    // Resolving rather than rejecting: a user-requested stop is not a failure.
    this.#finishTurn(null)
    if (this.#child == null || this.#threadId == null) return
    const params: Record<string, unknown> = { threadId: this.#threadId }
    if (this.#currentTurnId != null) params.turnId = this.#currentTurnId
    void this.#request(CODEX_METHODS.turnInterrupt, params, 5_000).catch(() => {})
  }

  #killChild(): void {
    this.#turnActivity = null
    // Startup and model-list requests live in #pending, not #turnCompletion.
    // Reject both classes before replacing the child so neither waits for its
    // timeout and the old child's late events cannot affect the replacement.
    this.#abort(new Error('Codex was stopped.'))
    this.#threadId = null
    this.#currentTurnId = null
    this.#agentMessagePhases.clear()
    this.#buffer = ''
    const child = this.#child
    this.#child = null
    child?.kill()
  }

  stop(): void {
    this.#killChild()
    this.#handlers = null
  }
}
