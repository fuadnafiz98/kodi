import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { constants as fileConstants } from 'node:fs'
import { spawn } from 'node:child_process'
import type {
  CanUseTool,
  Options as ClaudeOptions,
  PermissionMode
} from '@anthropic-ai/claude-agent-sdk'

import type {
  AgentActivityUpdate,
  AgentApprovalDecision,
  AgentModelCatalog,
  AgentProvider,
  AgentProviderStatus,
  AgentProviderStatuses,
  AgentStreamEvent,
  AgentUsageUpdate
} from '../shared/contracts.js'

import { CODEX_TOOLLESS_CONFIG, CodexAppServer } from './codexAppServer.js'
import {
  AGENT_READ_ONLY_TOOLS,
  AGENT_REVIEW_TOOLS,
  createAgentTextReader,
  interpretAgentEnvelope,
  parseAgentAskRequest,
  type AgentAskRequest
} from './agentRequest.js'

const CLAUDE_CANDIDATES = [
  `${process.env.HOME ?? ''}/.local/bin/claude`,
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude'
] as const
const CODEX_CANDIDATES = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'] as const
// An agentic turn that reads files and runs tests routinely passes five minutes
// of wall clock while streaming the whole way, so what is capped is silence.
const AGENT_IDLE_TIMEOUT_MS = 120_000
const MAX_AGENT_RUNTIME_MS = 1_800_000
const AGENT_STATUS_TIMEOUT_MS = 10_000
// Probing a provider costs a `--version` plus an auth spawn (measured 0.44 s for
// claude); the panel opens often enough that repeating that per open is the
// latency users read as "the agent is slow to start".
const AGENT_STATUS_TTL_MS = 30_000
const AGENT_MODELS_TTL_MS = 600_000

type ClaudeSdk = typeof import('@anthropic-ai/claude-agent-sdk')

// The SDK is 1.4 MB of JavaScript: importing it statically costs ~79 ms and
// ~16 MB of heap in every cold start, before the window exists, even for the
// runs where the agent is never opened.
let claudeSdkPromise: Promise<ClaudeSdk> | null = null

function loadClaudeSdk(): Promise<ClaudeSdk> {
  claudeSdkPromise ??= import('@anthropic-ai/claude-agent-sdk')
  return claudeSdkPromise
}

export type AgentEvent = AgentStreamEvent

const CLAUDE_MODELS: AgentModelCatalog['claude'] = [
  {
    id: 'default',
    label: 'Claude default',
    description: 'Uses the model selected by your Claude Code configuration.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    default: true
  },
  {
    id: 'sonnet',
    label: 'Claude Sonnet 5',
    description: 'Balanced speed and capability for everyday engineering.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high'
  },
  {
    id: 'opus',
    label: 'Claude Opus 5',
    description: 'Strong capability for complex agentic coding and enterprise work.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high'
  },
  {
    id: 'fable',
    label: 'Claude Fable 5',
    description: 'Highest capability for difficult, long-running agent tasks.',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high'
  },
  {
    id: 'haiku',
    label: 'Claude Haiku 4.5',
    description: 'Fastest option for simple questions and code lookup.',
    efforts: [],
    defaultEffort: ''
  }
]

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The agent request timed out.')), timeoutMs)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) }
    )
  })
}

async function* idleClaudeInput(): AsyncGenerator<never, void, unknown> {
  yield await new Promise<never>(() => {})
}

async function listClaudeModels(executable: string, cwd: string): Promise<AgentModelCatalog['claude']> {
  const { query: queryClaude } = await loadClaudeSdk()
  const runtime = queryClaude({
    prompt: idleClaudeInput(),
    options: {
      cwd,
      pathToClaudeCodeExecutable: executable,
      settingSources: [],
      tools: []
    }
  })
  try {
    const discovered = await withTimeout(runtime.supportedModels(), AGENT_STATUS_TIMEOUT_MS)
    return discovered.map((model, index) => ({
      id: model.value,
      label: model.displayName,
      description: model.description,
      efforts: model.supportedEffortLevels ?? [],
      defaultEffort: model.supportedEffortLevels?.includes('high') === true ? 'high' : '',
      ...(model.value === 'default' || index === 0 ? { default: true } : {})
    }))
  } finally {
    runtime.close()
  }
}

async function resolveExecutable(candidates: readonly string[], fallback: string): Promise<string> {
  for (const candidate of candidates) {
    if (candidate === '') continue
    try {
      await access(candidate, fileConstants.X_OK)
      return candidate
    } catch {
      // Try the next known install location.
    }
  }
  return fallback
}

export function getClaudeAccessConfig(accessMode: AgentAskRequest['accessMode'], cwd = process.cwd()): {
  permissionMode: PermissionMode
  tools: ClaudeOptions['tools']
  allowedTools?: string[]
  allowDangerouslySkipPermissions?: boolean
  sandbox?: ClaudeOptions['sandbox']
} {
  if (accessMode === 'review') {
    return {
      permissionMode: 'dontAsk',
      tools: [...AGENT_READ_ONLY_TOOLS, 'Bash'],
      allowedTools: [...AGENT_READ_ONLY_TOOLS, 'Bash'],
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyWrite: [cwd] }
      }
    }
  }
  if (accessMode === 'auto') {
    return {
      permissionMode: 'auto',
      tools: { type: 'preset', preset: 'claude_code' },
      sandbox: {
        enabled: true,
        failIfUnavailable: false,
        autoAllowBashIfSandboxed: true
      }
    }
  }
  return {
    permissionMode: 'bypassPermissions',
    tools: { type: 'preset', preset: 'claude_code' },
    allowDangerouslySkipPermissions: true
  }
}

interface ProcessResult {
  stdout: string
  stderr: string
  code: number | null
}

function runProcess(executable: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString('utf8')}`.slice(-64_000)
    child.stdout?.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    child.once('error', reject)
    const timeout = setTimeout(() => child.kill(), AGENT_STATUS_TIMEOUT_MS)
    child.once('close', (code) => {
      clearTimeout(timeout)
      resolve({ stdout, stderr, code })
    })
  })
}

async function executableVersion(executable: string): Promise<string | undefined> {
  try {
    const result = await runProcess(executable, ['--version'])
    const version = result.stdout.trim() || result.stderr.trim()
    return version === '' ? undefined : version.split('\n')[0]
  } catch {
    return undefined
  }
}

type AccountDetails = NonNullable<AgentProviderStatus['account']>

function accountDetails(email: unknown, plan: unknown, organization: unknown): AccountDetails | null {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 200) : undefined
  const details: AccountDetails = {}
  const address = text(email)
  const tier = text(plan)
  const org = text(organization)
  if (address != null) details.email = address
  if (tier != null) details.plan = tier
  if (org != null) details.organization = org
  return Object.keys(details).length === 0 ? null : details
}

/**
 * The ChatGPT account Codex is signed in with, from the claims of its local
 * id token (`$CODEX_HOME/auth.json`). Only the email and plan are read; the
 * tokens never leave this function.
 */
async function codexAccount(): Promise<AccountDetails | null> {
  try {
    const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
    const auth = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')) as { tokens?: { id_token?: unknown } }
    const token = auth.tokens?.id_token
    if (typeof token !== 'string') return null
    const payload = token.split('.')[1]
    if (payload == null) return null
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
    const openai = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined
    return accountDetails(claims.email, openai?.chatgpt_plan_type, undefined)
  } catch {
    return null
  }
}

async function getProviderStatus(provider: AgentProvider): Promise<AgentProviderStatus> {
  const candidates = provider === 'claude' ? CLAUDE_CANDIDATES : CODEX_CANDIDATES
  const fallback = provider === 'claude' ? 'claude' : 'codex'
  const executable = await resolveExecutable(candidates, fallback)
  // The version probe and the auth probe are independent spawns; running them
  // together halves the wall time the panel waits on.
  const [version, result] = await Promise.all([
    executableVersion(executable),
    runProcess(executable, provider === 'claude' ? ['auth', 'status'] : ['login', 'status'])
      .catch((error: unknown) => error instanceof Error ? error : new Error(`Could not check ${provider}.`))
  ])
  try {
    if (result instanceof Error) throw result
    if (provider === 'claude') {
      const parsed = JSON.parse(result.stdout) as Record<string, unknown>
      const authenticated = parsed.loggedIn === true
      const account = typeof parsed.email === 'string'
        ? parsed.email
        : typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : null
      const details = accountDetails(parsed.email, parsed.subscriptionType, parsed.orgName)
      return {
        provider,
        installed: true,
        authenticated,
        label: authenticated ? 'Connected' : 'Sign-in required',
        detail: authenticated
          ? account ?? 'Claude Code is ready.'
          : 'The Claude OAuth session is missing or expired.',
        ...(version == null ? {} : { version }),
        ...(authenticated && details != null ? { account: details } : {})
      }
    }
    const authenticated = result.code === 0 && /logged in/i.test(`${result.stdout}\n${result.stderr}`)
    const details = authenticated ? await codexAccount() : null
    return {
      provider,
      installed: true,
      authenticated,
      label: authenticated ? 'Connected' : 'Sign-in required',
      detail: authenticated ? result.stdout.trim() || 'Codex is ready.' : 'Sign in with ChatGPT to use Codex.',
      ...(version == null ? {} : { version }),
      ...(details == null ? {} : { account: details })
    }
  } catch (error) {
    return {
      provider,
      installed: version != null,
      authenticated: false,
      label: version == null ? 'Not installed' : 'Status unavailable',
      detail: error instanceof Error ? error.message : `Could not check ${provider}.`,
      ...(version == null ? {} : { version })
    }
  }
}

const AGENT_STREAM_COALESCE_MS = 16

type StreamedActivityField = 'detail' | 'output'

// A pure delta only extends one field of an activity and restates its identity.
// Anything more (timestamps, a replaced field) would need merge rules of its
// own, so only these are merged; everything else is sent as it arrives.
function readActivityDelta(event: AgentEvent): {
  activity: AgentActivityUpdate
  field: StreamedActivityField
} | null {
  const activity = event.activity
  if (event.kind !== 'activity' || activity?.append == null) return null
  const field = activity.append
  if (typeof activity[field] !== 'string') return null
  for (const key of Object.keys(activity)) {
    if (key !== 'id' && key !== 'kind' && key !== 'title' && key !== 'status' &&
        key !== 'append' && key !== field) return null
  }
  return { activity, field }
}

// One IPC message per token delta is 30-80 sends, setStates and full-transcript
// renders a second, and reasoning, plan and command-output deltas stream just as
// fast as text. Text and pure activity deltas are therefore batched to about a
// frame; every other event is sent immediately, after everything batched before
// it, so nothing is reordered around an approval, a lifecycle change or the end.
//
// The renderer folds text into the answer and activity into the activity list,
// and neither touches the other, so text keeps one batch while activity batches
// come and go. Activity deltas only merge into the most recent activity batch:
// the list is ordered by first appearance and capped, so letting a delta jump
// ahead of a different item could fold to a different list.
export function coalesceAgentTextEvents(send: (event: AgentEvent) => void): {
  emit(event: AgentEvent): void
  flush(): void
} {
  let pending: AgentEvent[] = []
  let pendingRequestId: string | null = null
  let textBatch: { id: string; kind: 'text'; text: string } | null = null
  let activityBatch: { activity: AgentActivityUpdate; field: StreamedActivityField } | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (timer != null) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.length === 0) return
    const batches = pending
    pending = []
    pendingRequestId = null
    textBatch = null
    activityBatch = null
    for (const batch of batches) send(batch)
  }

  const enqueue = (event: AgentEvent): void => {
    pending.push(event)
    pendingRequestId = event.id
    timer ??= setTimeout(flush, AGENT_STREAM_COALESCE_MS)
  }

  const appendText = (id: string, text: string): void => {
    if (textBatch == null) {
      textBatch = { id, kind: 'text', text }
      enqueue(textBatch)
    } else {
      textBatch.text += text
    }
  }

  const appendActivity = (
    event: AgentEvent,
    { activity, field }: { activity: AgentActivityUpdate; field: StreamedActivityField }
  ): void => {
    const last = activityBatch?.field === field ? activityBatch.activity : null
    if (last != null && last.id === activity.id && last.kind === activity.kind &&
        last.title === activity.title && last.status === activity.status) {
      last[field] = `${last[field] ?? ''}${activity[field] ?? ''}`
      return
    }
    // Copied so the concatenation above never writes into the caller's event.
    const batched = { ...activity }
    activityBatch = { activity: batched, field }
    enqueue({ ...event, activity: batched })
  }

  return {
    emit(event) {
      const text = event.kind === 'text' ? event.text : undefined
      const delta = text == null ? readActivityDelta(event) : null
      if (text == null && delta == null) {
        flush()
        send(event)
        return
      }
      // A batch never spans requests, so a new request drains the previous one.
      if (pendingRequestId != null && pendingRequestId !== event.id) flush()
      if (text != null) appendText(event.id, text)
      else if (delta != null) appendActivity(event, delta)
    },
    flush
  }
}

export interface StructuredRunRequest {
  /** Chosen by the caller, so `cancel(id)` can stop the run. */
  id: string
  provider: AgentProvider
  /** '' or 'default' means the provider's default model. */
  model: string
  effort: string
  prompt: string
  /** A JSON Schema with an object at its root. */
  schema: Record<string, unknown>
  /** The repository root. The model gets no tools, so it cannot read it. */
  cwd: string
  /** Absolute cap; silence is capped separately. */
  timeoutMs: number
  onPhase?(phase: 'thinking' | 'writing'): void
}

export interface StructuredRunResult {
  /** Parsed, but not validated against the schema: the caller normalises it. */
  json: unknown
  /** The model that answered, after any fallback to the provider default. */
  model: string
  usage: AgentUsageUpdate | null
}

const MAX_STRUCTURED_PROMPT_CHARS = 400_000
// Matched against a failed run's text; only these say "this model, not this request".
const MODEL_UNAVAILABLE = /model[_ ]not[_ ]found|unknown model|invalid model|not available|not supported|does not have access|do not have access|don't have access|\b403\b|\b404\b/i

export class StructuredRunCancelled extends Error {
  constructor() {
    super('The agent run was cancelled.')
    this.name = 'StructuredRunCancelled'
  }
}

/**
 * The answer of a structured Claude run: the SDK's `structured_output` when the
 * schema tool ran, otherwise the result text parsed as JSON.
 */
export function extractStructuredJson(result: Record<string, unknown>): unknown {
  const errorText = (): string => {
    const errors = Array.isArray(result.errors)
      ? result.errors.filter((value): value is string => typeof value === 'string')
      : []
    const text = typeof result.result === 'string' ? result.result : ''
    return [text, ...errors].filter((value) => value !== '').join('\n') || 'Claude could not finish the turn.'
  }
  if (result.is_error === true || (typeof result.subtype === 'string' && result.subtype.startsWith('error_'))) {
    throw new Error(errorText())
  }
  if (result.structured_output !== undefined && result.structured_output !== null) return result.structured_output
  const text = typeof result.result === 'string' ? result.result : ''
  const parsed = parseJsonLoose(text)
  if (parsed === undefined) throw new Error('The model did not return JSON.')
  return parsed
}

/**
 * JSON text as models return it: bare, or inside a ```json fence, or after a
 * sentence of preamble. Takes the first balanced object; undefined when none parses.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    // Fall through to the fenced and embedded forms.
  }
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/.exec(trimmed)?.[1]
  if (fenced != null) {
    try {
      return JSON.parse(fenced)
    } catch {
      // Try the balanced scan below.
    }
  }
  const start = trimmed.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, index + 1))
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

function readClaudeUsage(result: Record<string, unknown>, model: string): AgentUsageUpdate | null {
  const usage = typeof result.usage === 'object' && result.usage != null
    ? result.usage as Record<string, unknown>
    : null
  if (usage == null) return null
  const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
  const inputTokens = number(usage.input_tokens)
  const outputTokens = number(usage.output_tokens)
  const cachedInputTokens = number(usage.cache_read_input_tokens)
  const cacheWriteInputTokens = number(usage.cache_creation_input_tokens)
  return {
    model,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    totalTokens: inputTokens + outputTokens + cachedInputTokens + cacheWriteInputTokens
  }
}

type ClaudeQuery = ClaudeSdk['query']

interface StructuredCodexServer {
  runStructured: CodexAppServer['runStructured']
  interrupt(): void
  stop(): void
}

export interface AgentServiceDependencies {
  loadClaudeQuery?: () => Promise<ClaudeQuery>
  createCodexServer?: () => StructuredCodexServer
  providerStatus?: (provider: AgentProvider) => Promise<AgentProviderStatus>
  resolveExecutable?: (provider: AgentProvider) => Promise<string>
}

export class AgentService {
  #active = new Map<string, { close(): void }>()
  // Reused across turns: starting the app-server also starts the user's MCP
  // servers, which costs seconds.
  #codex = new CodexAppServer()
  #codexRequests = new Set<string>()
  #pendingApprovals = new Map<string, {
    agentRequestId: string
    resolve(decision: AgentApprovalDecision): void
  }>()
  // Model discovery starts a codex app-server and a Claude runtime; the panel is
  // toggled far more often than the installed models change.
  #models = new Map<string, { catalog: AgentModelCatalog; expires: number }>()
  #statuses = new Map<AgentProvider, { value: AgentProviderStatus; expires: number }>()
  // Structured runs answer one prompt and keep nothing; each has its own close.
  #structured = new Map<string, { close(): void }>()
  #deps: AgentServiceDependencies

  constructor(deps: AgentServiceDependencies = {}) {
    this.#deps = deps
  }

  async #providerStatus(provider: AgentProvider, force = false): Promise<AgentProviderStatus> {
    const cached = this.#statuses.get(provider)
    if (!force && cached != null && cached.expires > Date.now()) return cached.value
    const value = await (this.#deps.providerStatus ?? getProviderStatus)(provider)
    this.#statuses.set(provider, { value, expires: Date.now() + AGENT_STATUS_TTL_MS })
    return value
  }

  async getModels(cwd: string): Promise<AgentModelCatalog> {
    const cached = this.#models.get(cwd)
    if (cached != null && cached.expires > Date.now()) return cached.catalog
    const [claudeExecutable, codexExecutable] = await Promise.all([
      resolveExecutable(CLAUDE_CANDIDATES, 'claude'),
      resolveExecutable(CODEX_CANDIDATES, 'codex')
    ])
    const fallbackCodex: AgentModelCatalog['codex'] = [{
      id: 'default',
      label: 'Codex default',
      description: 'Uses the default model in your Codex configuration.',
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'high',
      default: true
    }]
    // Both providers are asked at once: they are separate processes, and running
    // them in sequence made panel-open wait for the slower one twice over.
    const [codex, claude] = await Promise.all([
      this.#codex.listModels(codexExecutable, cwd)
        .then((discovered) => discovered.length > 0 ? discovered : fallbackCodex)
        .catch(() => fallbackCodex),
      listClaudeModels(claudeExecutable, cwd)
        .then((discovered) => discovered.length > 0 ? discovered : CLAUDE_MODELS)
        .catch(() => CLAUDE_MODELS)
    ])
    const catalog: AgentModelCatalog = { claude, codex }
    this.#models.set(cwd, { catalog, expires: Date.now() + AGENT_MODELS_TTL_MS })
    return catalog
  }

  async getStatuses(providerValue?: unknown): Promise<AgentProviderStatuses> {
    // A sign-in poll names the provider it is waiting for; the other one keeps
    // its cached answer instead of spawning two more probes per tick.
    const refreshed = providerValue === 'claude' || providerValue === 'codex' ? providerValue : null
    const [claude, codex] = await Promise.all([
      this.#providerStatus('claude', refreshed === 'claude'),
      this.#providerStatus('codex', refreshed === 'codex')
    ])
    return { claude, codex }
  }

  async login(providerValue: unknown): Promise<void> {
    if (providerValue !== 'claude' && providerValue !== 'codex') {
      throw new Error('The agent provider is not valid.')
    }
    const provider: AgentProvider = providerValue
    this.#statuses.delete(provider)
    this.#models.clear()
    const executable = await resolveExecutable(
      provider === 'claude' ? CLAUDE_CANDIDATES : CODEX_CANDIDATES,
      provider
    )
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, provider === 'claude' ? ['auth', 'login'] : ['login'], {
        detached: true,
        stdio: 'ignore'
      })
      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })
  }

  respondApproval(requestId: unknown, decision: unknown): void {
    if (typeof requestId !== 'string' ||
        (decision !== 'accept' && decision !== 'acceptForSession' && decision !== 'decline')) return
    const pending = this.#pendingApprovals.get(requestId)
    if (pending == null) return
    this.#pendingApprovals.delete(requestId)
    pending.resolve(decision)
  }

  cancel(id: unknown): void {
    if (typeof id !== 'string') return
    if (this.#codexRequests.delete(id)) {
      for (const [requestId, pending] of this.#pendingApprovals) {
        if (pending.agentRequestId !== id) continue
        this.#pendingApprovals.delete(requestId)
        pending.resolve('decline')
      }
      this.#codex.interrupt()
      return
    }
    const structured = this.#structured.get(id)
    if (structured != null) {
      this.#structured.delete(id)
      structured.close()
      return
    }
    const child = this.#active.get(id)
    if (child == null) return
    this.#active.delete(id)
    child.close()
  }

  /** Turns and approvals still in flight; hibernation waits for all of them. */
  get busyCount(): number {
    return this.#active.size + this.#codexRequests.size + this.#pendingApprovals.size + this.#structured.size
  }

  cancelAll(): void {
    for (const id of this.#structured.keys()) this.cancel(id)
    for (const id of this.#active.keys()) this.cancel(id)
    this.#codexRequests.clear()
    for (const pending of this.#pendingApprovals.values()) pending.resolve('decline')
    this.#pendingApprovals.clear()
    this.#codex.stop()
  }

  // Codex streams only through the app-server's JSON-RPC notifications; its
  // `exec --json` transport has no token deltas at all.
  async #askCodex(
    request: AgentAskRequest,
    executable: string,
    cwd: string,
    emit: (event: AgentEvent) => void
  ): Promise<void> {
    this.#codexRequests.add(request.id)
    const readText = createAgentTextReader()
    const prompt = request.context === ''
      ? composeAgentPrompt(request.prompt)
      : composeAgentPrompt(request.prompt, request.context)
    let failure: string | null = null
    let emittedSessionId: string | null = null
    try {
      await this.#codex.ask({
        executable,
        cwd,
        prompt,
        model: request.model,
        effort: request.effort,
        accessMode: request.accessMode,
        ...(request.resumeSessionId == null ? {} : { resumeThreadId: request.resumeSessionId }),
        handlers: {
          onChunk: (chunk) => {
            if (!this.#codexRequests.has(request.id)) return
            for (const activity of chunk.activities ?? (chunk.activity == null ? [] : [chunk.activity])) {
              emit({ id: request.id, kind: 'activity', activity })
            }
            if (chunk.usage != null) {
              emit({
                id: request.id,
                kind: 'usage',
                usage: { model: request.model, ...chunk.usage }
              })
            }
            if (chunk.kind === 'session' && chunk.sessionId != null) {
              if (chunk.sessionId !== emittedSessionId) {
                emittedSessionId = chunk.sessionId
                emit({ id: request.id, kind: 'session', sessionId: chunk.sessionId })
              }
              return
            }
            if (chunk.kind === 'activity') {
              return
            }
            if (chunk.kind === 'result' && chunk.failed === true) {
              failure = chunk.text == null || chunk.text === '' ? 'Codex could not finish the turn.' : chunk.text
              return
            }
            const text = readText(chunk)
            if (text != null) emit({ id: request.id, kind: 'text', text })
          },
          onRateLimit: (limit) => {
            const duration = limit.windowDurationMinutes
            const label = duration == null
              ? 'Plan'
              : duration >= 10_080 ? '7-day' : duration >= 300 ? '5-hour' : 'Plan'
            emit({
              id: request.id,
              kind: 'usage',
              usage: {
                rateLimits: [{
                  label,
                  usedPercent: limit.usedPercent,
                  resetsAt: limit.resetsAtSeconds
                }]
              }
            })
            // Worth saying out loud: a nearly spent window is the usual reason a
            // turn crawls or refuses.
            if (limit.usedPercent >= 90) {
              emit({
                id: request.id,
                kind: 'activity',
                activity: {
                  id: 'codex-rate-limit',
                  kind: 'status',
                  title: `Plan usage is ${Math.round(limit.usedPercent)}%`,
                  status: 'completed'
                }
              })
            }
          },
          onApproval: (approval) => new Promise((resolve) => {
            this.#pendingApprovals.set(approval.requestId, {
              agentRequestId: request.id,
              resolve
            })
            emit({ id: request.id, kind: 'approval', approval })
            emit({
              id: request.id,
              kind: 'activity',
              activity: {
                id: approval.itemId,
                kind: approval.type === 'command'
                  ? 'command'
                  : approval.type === 'file-change' ? 'file' : 'status',
                title: approval.title,
                detail: approval.detail,
                status: 'waiting'
              }
            })
          })
        }
      })
    } finally {
      this.#codexRequests.delete(request.id)
      for (const [approvalId, pending] of this.#pendingApprovals) {
        if (pending.agentRequestId !== request.id) continue
        this.#pendingApprovals.delete(approvalId)
        pending.resolve('decline')
      }
    }
    if (failure != null) {
      emit({ id: request.id, kind: 'error', text: failure })
      return
    }
    emit({ id: request.id, kind: 'done' })
  }

  async #askClaude(
    request: AgentAskRequest,
    executable: string,
    cwd: string,
    emit: (event: AgentEvent) => void
  ): Promise<void> {
    const access = getClaudeAccessConfig(request.accessMode, cwd)
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      if (request.accessMode === 'full-access') return { behavior: 'allow', updatedInput: input }
      if (request.accessMode === 'review') {
        return (AGENT_REVIEW_TOOLS as readonly string[]).includes(toolName)
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Review mode is read-only.' }
      }

      const requestId = `claude-${options.requestId}`
      const itemId = options.toolUseID
      const type = toolName === 'Bash'
        ? 'command'
        : toolName === 'Edit' || toolName === 'Write' || toolName === 'NotebookEdit'
          ? 'file-change'
          : 'permissions'
      const detail = options.description ?? options.decisionReason ?? describeClaudeTool(toolName, input)
      const decision = await new Promise<AgentApprovalDecision>((resolve) => {
        this.#pendingApprovals.set(requestId, { agentRequestId: request.id, resolve })
        const onAbort = (): void => {
          const pending = this.#pendingApprovals.get(requestId)
          if (pending == null) return
          this.#pendingApprovals.delete(requestId)
          pending.resolve('decline')
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
        emit({
          id: request.id,
          kind: 'approval',
          approval: {
            requestId,
            itemId,
            type,
            title: options.title ?? `Allow ${options.displayName ?? toolName}?`,
            detail
          }
        })
        emit({
          id: request.id,
          kind: 'activity',
          activity: {
            id: itemId,
            kind: type === 'command' ? 'command' : type === 'file-change' ? 'file' : 'tool',
            title: options.displayName ?? toolName,
            detail,
            status: 'waiting'
          }
        })
      })
      if (decision === 'decline') return { behavior: 'deny', message: 'The user denied this tool.' }
      return {
        behavior: 'allow',
        updatedInput: input,
        ...(decision === 'acceptForSession' && options.suggestions != null
          ? {
              updatedPermissions: options.suggestions.map((suggestion) => ({
                ...suggestion,
                destination: 'session' as const
              }))
            }
          : {})
      }
    }

    const { query: queryClaude } = await loadClaudeSdk()
    const runtime = queryClaude({
      prompt: composeAgentPrompt(request.prompt, request.context),
      options: {
        cwd,
        pathToClaudeCodeExecutable: executable,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        includePartialMessages: true,
        forwardSubagentText: true,
        ...(request.accessMode === 'auto' ? { canUseTool } : {}),
        ...access,
        ...(request.model === '' || request.model === 'default' ? {} : { model: request.model }),
        ...(request.effort === '' || request.effort === 'default'
          ? {}
          : { effort: request.effort as NonNullable<ClaudeOptions['effort']> }),
        ...(request.resumeSessionId == null
          ? {}
          : { resume: request.resumeSessionId, forkSession: true })
      }
    })
    this.#active.set(request.id, runtime)
    // The cap is on silence, not on length: the timer is re-armed by every
    // message, and only the absolute ceiling ends a turn that is still talking.
    const deadline = Date.now() + MAX_AGENT_RUNTIME_MS
    const expiry: { reason: 'idle' | 'limit' | null; timer: ReturnType<typeof setTimeout> | null } = {
      reason: null,
      timer: null
    }
    const armTimeout = (): void => {
      if (expiry.timer != null) clearTimeout(expiry.timer)
      const remaining = deadline - Date.now()
      const reachedLimit = remaining <= AGENT_IDLE_TIMEOUT_MS
      expiry.timer = setTimeout(() => {
        expiry.reason = reachedLimit ? 'limit' : 'idle'
        runtime.close()
      }, Math.max(0, reachedLimit ? remaining : AGENT_IDLE_TIMEOUT_MS))
    }
    armTimeout()
    const readText = createAgentTextReader()
    let failure: string | null = null
    let emittedSessionId: string | null = null
    try {
      for await (const message of runtime) {
        if (!this.#active.has(request.id)) return
        armTimeout()
        const chunk = interpretAgentEnvelope(message as unknown as Record<string, unknown>, request.accessMode)
        if (chunk == null) continue
        for (const activity of chunk.activities ?? (chunk.activity == null ? [] : [chunk.activity])) {
          emit({ id: request.id, kind: 'activity', activity })
        }
        if (chunk.usage != null) {
          emit({ id: request.id, kind: 'usage', usage: { model: request.model, ...chunk.usage } })
        }
        if (chunk.kind === 'session' && chunk.sessionId != null) {
          if (chunk.sessionId !== emittedSessionId) {
            emittedSessionId = chunk.sessionId
            emit({ id: request.id, kind: 'session', sessionId: chunk.sessionId })
          }
        } else if (chunk.kind === 'result' && chunk.failed === true) {
          failure = chunk.text || 'Claude could not finish the turn.'
        } else if (chunk.kind !== 'activity') {
          const text = readText(chunk)
          if (text != null) emit({ id: request.id, kind: 'text', text })
        }
      }
    } finally {
      if (expiry.timer != null) clearTimeout(expiry.timer)
      runtime.close()
      this.#active.delete(request.id)
      for (const [approvalId, pending] of this.#pendingApprovals) {
        if (pending.agentRequestId !== request.id) continue
        this.#pendingApprovals.delete(approvalId)
        pending.resolve('decline')
      }
    }
    emit(expiry.reason != null
      ? {
          id: request.id,
          kind: 'error',
          text: expiry.reason === 'idle'
            ? 'Claude stopped responding.'
            : 'Claude reached the maximum turn length.'
        }
      : failure == null
        ? { id: request.id, kind: 'done' }
        : { id: request.id, kind: 'error', text: failure })
  }

  /**
   * One JSON document conforming to `schema`, with no tools, no saved session
   * and no streamed text: only phases. A model the account cannot use is
   * retried once on the provider default.
   */
  async runStructured(request: StructuredRunRequest): Promise<StructuredRunResult> {
    if (this.#structured.has(request.id)) throw new Error('This run is already in progress.')
    if (request.prompt.length > MAX_STRUCTURED_PROMPT_CHARS) throw new Error('The prompt is too long.')
    // Registered before the first await, so a cancel while the CLI is found,
    // its sign-in checked and the SDK loaded is not lost; each run below
    // replaces this entry with one that stops its process.
    const token = { cancelled: false }
    const hold = (): void => {
      this.#structured.set(request.id, { close: () => { token.cancelled = true } })
    }
    const stopIfCancelled = (): void => {
      if (!token.cancelled) return
      this.#structured.delete(request.id)
      throw new StructuredRunCancelled()
    }
    hold()
    try {
      return await this.#runStructuredHeld(request, token, hold, stopIfCancelled)
    } finally {
      this.#structured.delete(request.id)
    }
  }

  async #runStructuredHeld(
    request: StructuredRunRequest,
    token: { cancelled: boolean },
    hold: () => void,
    stopIfCancelled: () => void
  ): Promise<StructuredRunResult> {
    const executable = this.#deps.resolveExecutable != null
      ? await this.#deps.resolveExecutable(request.provider)
      : request.provider === 'claude'
        ? await resolveExecutable(CLAUDE_CANDIDATES, 'claude')
        : await resolveExecutable(CODEX_CANDIDATES, 'codex')
    const cached = await this.#providerStatus(request.provider)
    const status = cached.authenticated ? cached : await this.#providerStatus(request.provider, true)
    stopIfCancelled()
    if (!status.authenticated) {
      throw new Error(`${request.provider === 'claude' ? 'Claude Code' : 'Codex'} is not connected. Select Sign in in the agent panel.`)
    }
    const run = (model: string): Promise<StructuredRunResult> => request.provider === 'claude'
      ? this.#runClaudeStructured(request, executable, model, token)
      : this.#runCodexStructured(request, executable, model, token)
    const named = request.model !== '' && request.model !== 'default'
    try {
      return await run(request.model)
    } catch (error) {
      if (!named || error instanceof StructuredRunCancelled || token.cancelled ||
          !(error instanceof Error) || !MODEL_UNAVAILABLE.test(error.message)) throw error
      hold()
      return await run('default')
    }
  }

  async #runClaudeStructured(
    request: StructuredRunRequest,
    executable: string,
    model: string,
    token: { cancelled: boolean }
  ): Promise<StructuredRunResult> {
    const queryClaude = this.#deps.loadClaudeQuery != null
      ? await this.#deps.loadClaudeQuery()
      : (await loadClaudeSdk()).query
    if (token.cancelled) throw new StructuredRunCancelled()
    const runtime = queryClaude({
      prompt: request.prompt,
      options: {
        cwd: request.cwd,
        pathToClaudeCodeExecutable: executable,
        outputFormat: { type: 'json_schema', schema: request.schema },
        tools: [],
        permissionMode: 'dontAsk',
        persistSession: false,
        // The schema is answered through an end-turn tool, which the CLI may
        // retry on a validation failure.
        maxTurns: 4,
        settingSources: [],
        includePartialMessages: true,
        ...(model === '' || model === 'default' ? {} : { model }),
        ...(request.effort === '' || request.effort === 'default'
          ? {}
          : { effort: request.effort as NonNullable<ClaudeOptions['effort']> })
      }
    })
    let cancelled = false
    this.#structured.set(request.id, {
      close: () => {
        cancelled = true
        token.cancelled = true
        runtime.close()
      }
    })
    const deadline = Date.now() + request.timeoutMs
    const expiry: { reason: 'idle' | 'limit' | null; timer: ReturnType<typeof setTimeout> | null } = {
      reason: null,
      timer: null
    }
    const armTimeout = (): void => {
      if (expiry.timer != null) clearTimeout(expiry.timer)
      const remaining = deadline - Date.now()
      const reachedLimit = remaining <= AGENT_IDLE_TIMEOUT_MS
      expiry.timer = setTimeout(() => {
        expiry.reason = reachedLimit ? 'limit' : 'idle'
        runtime.close()
      }, Math.max(0, reachedLimit ? remaining : AGENT_IDLE_TIMEOUT_MS))
    }
    armTimeout()
    let result: Record<string, unknown> | null = null
    try {
      for await (const value of runtime) {
        if (cancelled) break
        armTimeout()
        const message = value as unknown as Record<string, unknown>
        if (message.type === 'stream_event') {
          const event = message.event as Record<string, unknown> | undefined
          const block = (event?.type === 'content_block_start' ? event.content_block : event?.delta) as
            | { type?: unknown }
            | undefined
          const type = block?.type
          if (type === 'thinking' || type === 'thinking_delta') request.onPhase?.('thinking')
          else if (type === 'text' || type === 'text_delta' || type === 'tool_use' || type === 'input_json_delta') {
            request.onPhase?.('writing')
          }
        } else if (message.type === 'result') {
          result = message
        }
      }
    } finally {
      if (expiry.timer != null) clearTimeout(expiry.timer)
      runtime.close()
      this.#structured.delete(request.id)
    }
    if (cancelled) throw new StructuredRunCancelled()
    if (expiry.reason != null) {
      throw new Error(expiry.reason === 'idle' ? 'Claude stopped responding.' : 'The agent request timed out.')
    }
    if (result == null) throw new Error('Claude stopped before answering.')
    return { json: extractStructuredJson(result), model, usage: readClaudeUsage(result, model) }
  }

  async #runCodexStructured(
    request: StructuredRunRequest,
    executable: string,
    model: string,
    token: { cancelled: boolean }
  ): Promise<StructuredRunResult> {
    if (token.cancelled) throw new StructuredRunCancelled()
    // Its own server: the chat's app-server holds one thread and one turn at a
    // time, and a guide must neither wait for a chat nor end up in its history.
    const server = this.#deps.createCodexServer?.() ?? new CodexAppServer({ configOverrides: CODEX_TOOLLESS_CONFIG })
    let cancelled = false
    this.#structured.set(request.id, {
      close: () => {
        cancelled = true
        token.cancelled = true
        server.interrupt()
        server.stop()
      }
    })
    try {
      const text = await server.runStructured({
        executable,
        cwd: request.cwd,
        prompt: request.prompt,
        model,
        effort: request.effort,
        schema: request.schema,
        timeoutMs: request.timeoutMs,
        ...(request.onPhase == null ? {} : { onPhase: request.onPhase })
      })
      if (cancelled) throw new StructuredRunCancelled()
      const json = parseJsonLoose(text)
      if (json === undefined) throw new Error('The model did not return JSON.')
      return { json, model, usage: null }
    } catch (error) {
      if (cancelled) throw new StructuredRunCancelled()
      throw error
    } finally {
      this.#structured.delete(request.id)
      server.stop()
    }
  }

  async ask(
    requestValue: unknown,
    cwd: string,
    emit: (event: AgentEvent) => void
  ): Promise<void> {
    const request = await parseAgentAskRequest(requestValue)
    if (this.#active.has(request.id) || this.#codexRequests.has(request.id)) {
      throw new Error('This question is already running.')
    }

    const executable = request.provider === 'claude'
      ? await resolveExecutable(CLAUDE_CANDIDATES, 'claude')
      : await resolveExecutable(CODEX_CANDIDATES, 'codex')

    // A cached "connected" is trusted — the provider's own error surfaces if the
    // token expired — but a cached refusal is re-probed before it blocks a user
    // who has just signed in.
    const cached = await this.#providerStatus(request.provider)
    const status = cached.authenticated ? cached : await this.#providerStatus(request.provider, true)
    if (!status.authenticated) {
      throw new Error(`${request.provider === 'claude' ? 'Claude Code' : 'Codex'} is not connected. Select Sign in in the agent panel.`)
    }

    if (request.provider === 'codex') {
      await this.#askCodex(request, executable, cwd, emit)
      return
    }
    await this.#askClaude(request, executable, cwd, emit)
  }
}

function describeClaudeTool(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash' && typeof input.command === 'string') return input.command
  const path = typeof input.file_path === 'string' ? input.file_path : null
  if (path != null) return path
  const summary = JSON.stringify(input)
  return summary === '{}' ? toolName : summary.slice(0, 2_000)
}

export function composeAgentPrompt(question: string, reviewContext = ''): string {
  const instructions = [
    'Kodi already loaded this review into the matching local checkout.',
    'The working directory is that checkout. Stay inside it.',
    'Do not fetch remotes, clone repositories, or call GitHub, gh, or the network.',
    'If a review bundle path is listed, read that patch first, then only the listed files and their direct callers or callees.',
    'The working tree is the current codebase and may differ from the pull-request head. Treat the patch as the change under review.',
    'Cite concrete file paths and line numbers. Separate verified facts from inferences.',
    'When a flow, state machine, or sequence helps, include a mermaid diagram.',
    'Do not change files unless the user explicitly asks for a change.'
  ].join(' ')
  if (reviewContext === '') return `${question}\n\nReview instructions: ${instructions}`
  return `${question}\n\nReview instructions: ${instructions}\n\nCurrent review context:\n${reviewContext}`
}
