import { isAbsolute } from 'node:path'

import type {
  AgentAccessMode,
  AgentActivityUpdate,
  AgentRequestSelection,
  AgentRequestSubject,
  AgentRateLimitWindow,
  AgentUsageUpdate
} from '../shared/contracts.js'
import { normalizeGitHubPullRequestUrl } from '../shared/pullRequestUrl.js'

// Review mode passes this list to the agent and uses it to label activity, so
// its enforced access and displayed access cannot drift apart.
export const AGENT_READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob'] as const
export const AGENT_REVIEW_TOOLS = [...AGENT_READ_ONLY_TOOLS, 'Bash'] as const

export const MAX_AGENT_PROMPT_LENGTH = 200_000
export const MAX_AGENT_CONTEXT_LENGTH = 400_000

export interface AgentAskRequest {
  id: string
  provider: 'claude' | 'codex'
  model: string
  effort: string
  accessMode: AgentAccessMode
  prompt: string
  context: string
  subject: AgentRequestSubject
  selections: AgentRequestSelection[]
  resumeSessionId?: string
}

const AGENT_PROVIDERS = new Set<AgentAskRequest['provider']>(['claude', 'codex'])
const AGENT_ACCESS_MODES = new Set<AgentAccessMode>(['review', 'auto', 'full-access'])
const AGENT_SUBJECT_SOURCES = new Set<AgentRequestSubject['source']>(['workingTree', 'patch', 'since'])

export function decodeAgentSubject(value: unknown): AgentRequestSubject | null {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) return null
  const candidate = value as Record<string, unknown>
  const { tabId, repositoryRoot, repositoryName, source, baseOid, headOid, pullRequestUrl, workingBranch } = candidate
  if (typeof tabId !== 'string' || typeof repositoryRoot !== 'string'
    || typeof repositoryName !== 'string' || typeof source !== 'string') return null
  if (baseOid !== null && typeof baseOid !== 'string') return null
  if (headOid !== null && typeof headOid !== 'string') return null
  if (!AGENT_SUBJECT_SOURCES.has(source as AgentRequestSubject['source'])) return null
  if (pullRequestUrl !== undefined
    && (typeof pullRequestUrl !== 'string' || normalizeGitHubPullRequestUrl(pullRequestUrl) !== pullRequestUrl)) {
    return null
  }
  if (workingBranch !== undefined && (typeof workingBranch !== 'string' || workingBranch.length > 256)) {
    return null
  }
  return {
    tabId,
    repositoryRoot,
    repositoryName,
    source: source as AgentRequestSubject['source'],
    baseOid,
    headOid,
    ...(pullRequestUrl == null ? {} : { pullRequestUrl }),
    ...(workingBranch == null || workingBranch === '' ? {} : { workingBranch })
  }
}

function decodeAgentSelection(value: unknown): AgentRequestSelection | null {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) return null
  const candidate = value as Record<string, unknown>
  const { path, startLine, endLine, side, selectedText, blobOid } = candidate
  if (typeof path !== 'string' || typeof startLine !== 'number' || typeof endLine !== 'number'
    || typeof selectedText !== 'string') return null
  if (side !== 'additions' && side !== 'deletions') return null
  if (blobOid !== null && typeof blobOid !== 'string') return null
  return { path, startLine, endLine, side, selectedText, blobOid }
}

// This is the renderer -> subprocess trust boundary, so the request is rebuilt
// field by field instead of forwarded: a class instance, a prototype-polluted
// payload or extra keys can never reach the CLI invocation. Replaces an
// `effect` Schema.Struct decode that cost 35 MB of app size and 135 ms on the
// first ask for exactly this check.
function decodeAgentAskRequest(value: unknown): AgentAskRequest | null {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value) as unknown
  if (prototype !== Object.prototype && prototype !== null) return null
  const candidate = value as Record<string, unknown>
  const { id, provider, model, effort, accessMode, prompt, context, subject, selections, resumeSessionId } = candidate
  if (typeof id !== 'string' || typeof model !== 'string' || typeof effort !== 'string' ||
      typeof prompt !== 'string' || typeof context !== 'string') return null
  if (typeof provider !== 'string' || !AGENT_PROVIDERS.has(provider as AgentAskRequest['provider'])) return null
  if (typeof accessMode !== 'string' || !AGENT_ACCESS_MODES.has(accessMode as AgentAccessMode)) return null
  if (resumeSessionId !== undefined && typeof resumeSessionId !== 'string') return null
  const decodedSubject = decodeAgentSubject(subject)
  if (decodedSubject == null) return null
  if (!Array.isArray(selections)) return null
  const decodedSelections = selections.map(decodeAgentSelection)
  if (decodedSelections.some((selection) => selection == null)) return null
  return {
    id,
    provider: provider as AgentAskRequest['provider'],
    model,
    effort,
    accessMode: accessMode as AgentAccessMode,
    prompt,
    context,
    subject: decodedSubject,
    selections: decodedSelections as AgentRequestSelection[],
    ...(resumeSessionId === undefined ? {} : { resumeSessionId })
  }
}

// Renderer input reaches the agent runner as `unknown`; a decode failure must
// read as a refusal rather than a malformed subprocess invocation. The async
// signature is kept because every caller already awaits it.
export async function parseAgentAskRequest(value: unknown): Promise<AgentAskRequest> {
  const request = decodeAgentAskRequest(value)
  if (request == null) throw new Error('The agent request was not understood.')
  const prompt = request.prompt.trim()
  if (prompt === '') throw new Error('Ask the agent a question first.')
  if (prompt.length > MAX_AGENT_PROMPT_LENGTH) throw new Error('This question is too long to send.')
  if (request.id.trim() === '' || request.id.length > 128) {
    throw new Error('The agent request could not be identified.')
  }
  if (request.model !== '' &&
      !/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(request.model)) {
    throw new Error('The selected agent model is not valid.')
  }
  if (!/^[a-z0-9-]{0,32}$/i.test(request.effort)) {
    throw new Error('The selected reasoning effort is not valid.')
  }
  if (request.resumeSessionId != null && !/^[A-Za-z0-9-]{1,128}$/.test(request.resumeSessionId)) {
    throw new Error('The agent session could not be identified.')
  }
  if (request.subject.tabId.trim() === '' || request.subject.tabId.length > 512) {
    throw new Error('The review tab could not be identified.')
  }
  if (!isAbsolute(request.subject.repositoryRoot) || request.subject.repositoryRoot.length > 4_096) {
    throw new Error('The agent repository root is not valid.')
  }
  if (request.subject.repositoryName.trim() === '' || request.subject.repositoryName.length > 256) {
    throw new Error('The agent repository name is not valid.')
  }
  if (request.subject.source !== 'workingTree' && request.accessMode !== 'review') {
    throw new Error('Patch and Since tabs allow read-only agent access.')
  }
  if (request.subject.source !== 'workingTree'
    && (request.subject.baseOid == null || request.subject.headOid == null)) {
    throw new Error('The review tab does not identify an exact revision.')
  }
  for (const oid of [request.subject.baseOid, request.subject.headOid]) {
    if (oid != null && (oid.trim() === '' || oid.length > 128)) {
      throw new Error('The agent revision is not valid.')
    }
  }
  if (request.selections.length > 8) throw new Error('Too many code selections were attached.')
  for (const selection of request.selections) {
    const unsafeSegment = selection.path.split(/[\\/]/).some((segment) => segment === '..')
    if (selection.path === '' || selection.path.length > 4_096 || selection.path.includes('\0')
      || isAbsolute(selection.path) || unsafeSegment) {
      throw new Error('An attached code path is not valid.')
    }
    if (!Number.isInteger(selection.startLine) || !Number.isInteger(selection.endLine)
      || selection.startLine < 1 || selection.endLine < selection.startLine
      || selection.endLine > 10_000_000) {
      throw new Error('An attached line range is not valid.')
    }
    if (selection.selectedText === '' || selection.selectedText.length > 40_000) {
      throw new Error('An attached code selection is not valid.')
    }
    if (selection.blobOid != null
      && (selection.blobOid.trim() === '' || selection.blobOid.length > 128)) {
      throw new Error('An attached blob identity is not valid.')
    }
  }
  return {
    id: request.id,
    provider: request.provider,
    model: request.model,
    effort: request.effort,
    accessMode: request.accessMode,
    prompt,
    context: request.context.slice(0, MAX_AGENT_CONTEXT_LENGTH),
    subject: request.subject,
    selections: request.selections,
    ...(request.resumeSessionId == null ? {} : { resumeSessionId: request.resumeSessionId })
  }
}

export interface AgentStreamChunk {
  kind: 'session' | 'text' | 'result' | 'activity' | 'usage'
  text?: string
  sessionId?: string
  failed?: boolean
  activity?: AgentActivityUpdate
  activities?: AgentActivityUpdate[]
  usage?: AgentUsageUpdate
  /** Where a text chunk came from: an incremental delta or an assembled message. */
  source?: 'delta' | 'message'
}

// A tool call is the agent telling you what it is doing; showing "Read foo.ts" is
// what makes a long pause legible instead of looking stalled.
function describeToolUse(
  block: Record<string, unknown>,
  accessMode: AgentAccessMode
): AgentActivityUpdate | null {
  const name = typeof block.name === 'string' ? block.name : null
  if (name == null) return null
  const input = (typeof block.input === 'object' && block.input != null
    ? block.input
    : {}) as Record<string, unknown>
  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const pattern = typeof input.pattern === 'string' ? input.pattern : null
  const command = typeof input.command === 'string' ? input.command : null
  const id = typeof block.id === 'string' ? block.id : `claude-tool-${name}`
  // The model can still ask for a tool it was not granted; the request is denied,
  // so reporting the bare name would imply something ran that never did.
  if (accessMode === 'review' && !(AGENT_REVIEW_TOOLS as readonly string[]).includes(name)) {
    return { id, kind: 'tool', title: `${name} blocked`, detail: 'Review mode is read-only.', status: 'blocked' }
  }
  if (name === 'Read') return { id, kind: 'file', title: 'Read file', detail: filePath ?? '', status: 'running' }
  if (name === 'Grep') return { id, kind: 'search', title: 'Search code', detail: pattern ?? '', status: 'running' }
  if (name === 'Glob') return { id, kind: 'search', title: 'List files', detail: pattern ?? '', status: 'running' }
  if (name === 'Bash') return { id, kind: 'command', title: 'Run command', detail: command ?? '', status: 'running' }
  if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
    return { id, kind: 'file', title: name === 'Write' ? 'Write file' : 'Edit file', detail: filePath ?? '', status: 'running' }
  }
  const detail = JSON.stringify(input)
  return { id, kind: 'tool', title: name, detail: detail === '{}' ? '' : detail.slice(0, 1_000), status: 'running' }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readClaudeUsage(envelope: Record<string, unknown>): AgentUsageUpdate {
  const modelUsage = typeof envelope.modelUsage === 'object' && envelope.modelUsage != null
    ? envelope.modelUsage as Record<string, unknown>
    : typeof envelope.model_usage === 'object' && envelope.model_usage != null
      ? envelope.model_usage as Record<string, unknown>
      : {}
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let cacheWriteInputTokens = 0
  let costUsd = 0
  let contextWindow = 0
  let model: string | undefined
  for (const [modelId, raw] of Object.entries(modelUsage)) {
    if (typeof raw !== 'object' || raw == null) continue
    const usage = raw as Record<string, unknown>
    model ??= typeof usage.canonicalModel === 'string' ? usage.canonicalModel : modelId
    inputTokens += finiteNumber(usage.inputTokens) ?? 0
    outputTokens += finiteNumber(usage.outputTokens) ?? 0
    cachedInputTokens += finiteNumber(usage.cacheReadInputTokens) ?? 0
    cacheWriteInputTokens += finiteNumber(usage.cacheCreationInputTokens) ?? 0
    costUsd += finiteNumber(usage.costUSD) ?? 0
    contextWindow = Math.max(contextWindow, finiteNumber(usage.contextWindow) ?? 0)
  }
  const usage = typeof envelope.usage === 'object' && envelope.usage != null
    ? envelope.usage as Record<string, unknown>
    : {}
  const outputDetails = typeof usage.output_tokens_details === 'object' && usage.output_tokens_details != null
    ? usage.output_tokens_details as Record<string, unknown>
    : {}
  const reasoningTokens = finiteNumber(outputDetails.thinking_tokens) ?? 0
  const reportedCost = finiteNumber(envelope.total_cost_usd)
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + cachedInputTokens + cacheWriteInputTokens,
    ...(contextWindow === 0 ? {} : { contextWindow }),
    costUsd: reportedCost ?? costUsd,
    durationMs: finiteNumber(envelope.duration_ms) ?? 0,
    turns: finiteNumber(envelope.num_turns) ?? 0,
    ...(model == null ? {} : { model })
  }
}

function claudeRateLimitWindow(info: Record<string, unknown>): AgentRateLimitWindow | null {
  const used = finiteNumber(info.utilization)
  if (used == null) return null
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : 'plan'
  const labels: Record<string, string> = {
    five_hour: '5-hour',
    seven_day: '7-day',
    seven_day_opus: 'Opus 7-day',
    seven_day_sonnet: 'Sonnet 7-day',
    seven_day_overage_included: 'Overage 7-day',
    overage: 'Overage'
  }
  return {
    label: labels[type] ?? 'Plan',
    usedPercent: used <= 1 ? used * 100 : used,
    resetsAt: finiteNumber(info.resetsAt)
  }
}

// Claude emits incremental `stream_event` deltas AND, at the end of the turn, the
// fully assembled `assistant` message carrying the same text — so consuming both
// renders every answer twice. Deltas win when they are present; the assembled
// message stays as the fallback for CLI builds that do not support
// --include-partial-messages, and for Codex, which only writes plain text.
//
// A turn is several text blocks — "Let me check the patch.", a tool call, "Now
// let me read blob.py.", then the answer — and each block's deltas carry no
// separator of their own. Joined as they came, "blob.py.## Review" was one line
// and the heading never parsed. The assembled message marks where a block
// ended (it follows that block's deltas), so the next block starts on a new
// paragraph.
export function createAgentTextReader(): (chunk: AgentStreamChunk) => string | null {
  let sawDelta = false
  let blockEnded = false
  let tail = ''
  const emit = (text: string, newBlock: boolean): string => {
    const joined = newBlock && tail !== '' ? `${paragraphBreakAfter(tail)}${text}` : text
    tail = joined
    return joined
  }
  return (chunk) => {
    if (chunk.kind !== 'text' || chunk.text == null || chunk.text === '') return null
    if (chunk.source === 'delta') {
      sawDelta = true
      const newBlock = blockEnded
      blockEnded = false
      return emit(chunk.text, newBlock)
    }
    if (chunk.source === 'message') {
      if (sawDelta) {
        blockEnded = true
        return null
      }
      return emit(chunk.text, true)
    }
    return emit(chunk.text, false)
  }
}

function paragraphBreakAfter(text: string): string {
  if (text.endsWith('\n\n')) return ''
  return text.endsWith('\n') ? '\n' : '\n\n'
}

// Codex wraps shell work in `bash -lc "…"`; the inner command is what is worth
// showing, and it can be long enough to need trimming.
function describeCodexCommand(item: Record<string, unknown>): string {
  const raw = typeof item.command === 'string' ? item.command : ''
  const inner = /-lc\s+"([\s\S]*)"\s*$/.exec(raw)?.[1] ?? raw
  const collapsed = inner.replace(/\s+/g, ' ').trim()
  if (collapsed === '') return 'Ran a command'
  return `Ran ${collapsed.length > 64 ? `${collapsed.slice(0, 64)}…` : collapsed}`
}

// Codex writes a completely different envelope from Claude: a thread/turn
// lifecycle plus per-item events, and no token deltas at all — an agent message
// arrives whole in `item.completed`. Its event names do not collide with Claude's,
// so both shapes are read here.
function interpretCodexLine(envelope: Record<string, unknown>): AgentStreamChunk | null {
  if (envelope.type === 'thread.started') {
    return typeof envelope.thread_id === 'string'
      ? { kind: 'session', sessionId: envelope.thread_id }
      : null
  }
  if (envelope.type === 'turn.failed') {
    const error = envelope.error as { message?: unknown } | undefined
    return { kind: 'result', text: typeof error?.message === 'string' ? error.message : '', failed: true }
  }
  if (envelope.type === 'turn.completed') return { kind: 'result', text: '' }

  if (envelope.type !== 'item.started' && envelope.type !== 'item.completed') return null
  const item = envelope.item as Record<string, unknown> | undefined
  if (item == null) return null
  const completed = envelope.type === 'item.completed'

  if (item.type === 'agent_message') {
    // A turn can hold several messages (a preamble, then the answer), so each one
    // is appended as its own paragraph.
    if (!completed || typeof item.text !== 'string' || item.text === '') return null
    return { kind: 'text', text: `${item.text}\n\n`, source: 'message' }
  }
  // Reported as it starts, because the wait for a command is the pause the user sees.
  if (item.type === 'command_execution') {
    return {
      kind: 'activity',
      activity: {
        id: typeof item.id === 'string' ? item.id : 'codex-command',
        kind: 'command',
        title: 'Run command',
        detail: describeCodexCommand(item).replace(/^Ran /, ''),
        status: completed ? 'completed' : 'running'
      }
    }
  }
  if (item.type === 'reasoning') {
    return completed ? {
      kind: 'activity',
      activity: {
        id: typeof item.id === 'string' ? item.id : 'codex-reasoning',
        kind: 'reasoning',
        title: 'Reasoning',
        detail: typeof item.text === 'string' ? item.text : '',
        status: 'completed'
      }
    } : null
  }
  if (item.type === 'file_change' || item.type === 'patch_apply') {
    return {
      kind: 'activity',
      activity: {
        id: typeof item.id === 'string' ? item.id : 'codex-file-change',
        kind: 'file',
        title: 'Change files',
        status: completed ? 'completed' : 'running'
      }
    }
  }
  return null
}

// Claude streams newline-delimited JSON envelopes; Codex uses its own event shape.
// Only the fields this app renders are read, so unknown envelopes are ignored.
export function interpretAgentLine(
  line: string,
  accessMode: AgentAccessMode = 'review'
): AgentStreamChunk | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  if (!trimmed.startsWith('{')) return { kind: 'text', text: `${line}\n` }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed == null) return null
  return interpretAgentEnvelope(parsed as Record<string, unknown>, accessMode)
}

// The Claude SDK yields already-parsed messages, so that transport reads the
// envelope directly instead of stringifying each token delta only to parse it
// straight back.
export function interpretAgentEnvelope(
  envelope: Record<string, unknown>,
  accessMode: AgentAccessMode = 'review'
): AgentStreamChunk | null {
  if (typeof envelope.type === 'string' && (envelope.type.startsWith('thread.') || envelope.type.startsWith('turn.') || envelope.type.startsWith('item.'))) {
    return interpretCodexLine(envelope)
  }

  if (envelope.type === 'stream_event') {
    const event = envelope.event as {
      type?: unknown
      index?: unknown
      delta?: { type?: unknown; text?: unknown; thinking?: unknown }
      content_block?: Record<string, unknown>
    } | undefined
    const text = event?.delta?.text
    if (typeof text === 'string' && text !== '') return { kind: 'text', text, source: 'delta' }
    const thinking = event?.delta?.thinking
    if (typeof thinking === 'string' && thinking !== '') {
      return {
        kind: 'activity',
        activity: {
          id: `claude-reasoning-${typeof event?.index === 'number' ? event.index : 0}`,
          kind: 'reasoning',
          title: 'Reasoning',
          detail: thinking,
          status: 'running',
          append: 'detail'
        }
      }
    }
    if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      const activity = describeToolUse(event.content_block, accessMode)
      return activity == null ? null : { kind: 'activity', activity }
    }
    return null
  }

  if (envelope.type === 'assistant') {
    const message = envelope.message as { content?: unknown } | undefined
    if (!Array.isArray(message?.content)) return null
    let text = ''
    const activity: AgentActivityUpdate[] = []
    for (const block of message.content) {
      if (typeof block !== 'object' || block == null) continue
      const candidate = block as Record<string, unknown>
      if (candidate.type === 'text' && typeof candidate.text === 'string') text += candidate.text
      else if (candidate.type === 'thinking') {
        const thinking = typeof candidate.thinking === 'string' ? candidate.thinking : ''
        activity.push({
          id: typeof candidate.id === 'string' ? candidate.id : `claude-reasoning-${activity.length}`,
          kind: 'reasoning',
          title: 'Reasoning',
          detail: thinking,
          status: 'completed'
        })
      }
      else if (candidate.type === 'tool_use') {
        const described = describeToolUse(candidate, accessMode)
        if (described != null) activity.push(described)
      }
    }
    // Tool and thinking blocks are reported even when the same message carries
    // text, because the activity is what explains the pause before it.
    if (text !== '') {
      return {
        kind: 'text',
        text,
        source: 'message',
        ...(activity.length === 0 ? {} : { activities: activity })
      }
    }
    return activity.length === 0 ? null : { kind: 'activity', activities: activity }
  }

  if (envelope.type === 'user') {
    const message = envelope.message as { content?: unknown } | undefined
    if (!Array.isArray(message?.content)) return null
    const result = message.content.find((block) => typeof block === 'object' && block != null &&
      (block as Record<string, unknown>).type === 'tool_result') as Record<string, unknown> | undefined
    if (result == null || typeof result.tool_use_id !== 'string') return null
    const rawContent = result.content
    const output = typeof rawContent === 'string' ? rawContent : ''
    return {
      kind: 'activity',
      activity: {
        id: result.tool_use_id,
        kind: 'tool',
        title: '',
        status: result.is_error === true ? 'failed' : 'completed',
        ...(output === '' ? {} : { output: output.slice(-4_000) })
      }
    }
  }

  if (envelope.type === 'tool_progress') {
    const toolUseId = typeof envelope.tool_use_id === 'string' ? envelope.tool_use_id : null
    if (toolUseId == null) return null
    const elapsed = finiteNumber(envelope.elapsed_time_seconds)
    return {
      kind: 'activity',
      activity: {
        id: toolUseId,
        kind: 'tool',
        title: '',
        status: 'running',
        ...(elapsed == null ? {} : { output: `Running for ${Math.round(elapsed)}s` })
      }
    }
  }

  if (envelope.type === 'tool_use_summary' && typeof envelope.summary === 'string') {
    const ids = Array.isArray(envelope.preceding_tool_use_ids)
      ? envelope.preceding_tool_use_ids.filter((value): value is string => typeof value === 'string')
      : []
    return {
      kind: 'activity',
      activity: {
        id: `claude-summary-${ids.join('-').slice(0, 80) || 'tool'}`,
        kind: 'status',
        title: envelope.summary,
        status: 'completed'
      }
    }
  }

  if (envelope.type === 'rate_limit_event') {
    const info = typeof envelope.rate_limit_info === 'object' && envelope.rate_limit_info != null
      ? envelope.rate_limit_info as Record<string, unknown>
      : {}
    const window = claudeRateLimitWindow(info)
    return window == null ? null : { kind: 'usage', usage: { rateLimits: [window] } }
  }

  if (envelope.type === 'system' && envelope.subtype === 'thinking_tokens') {
    const reasoningTokens = finiteNumber(envelope.estimated_tokens)
    return reasoningTokens == null ? null : { kind: 'usage', usage: { reasoningTokens } }
  }

  if (envelope.type === 'system' && envelope.subtype === 'task_started' && envelope.skip_transcript !== true) {
    return {
      kind: 'activity',
      activity: {
        id: typeof envelope.task_id === 'string' ? envelope.task_id : 'claude-task',
        kind: 'tool',
        title: typeof envelope.subagent_type === 'string' ? `Agent · ${envelope.subagent_type}` : 'Agent task',
        detail: typeof envelope.description === 'string' ? envelope.description : '',
        status: 'running'
      }
    }
  }

  if (envelope.type === 'system' && envelope.subtype === 'task_progress' && envelope.skip_transcript !== true) {
    const taskUsage = typeof envelope.usage === 'object' && envelope.usage != null
      ? envelope.usage as Record<string, unknown>
      : {}
    const tokens = finiteNumber(taskUsage.total_tokens)
    const duration = finiteNumber(taskUsage.duration_ms)
    const output = [
      tokens == null ? null : `${Math.round(tokens).toLocaleString()} tokens`,
      duration == null ? null : `${Math.round(duration / 1_000)}s`
    ].filter((value): value is string => value != null).join(' · ')
    return {
      kind: 'activity',
      activity: {
        id: typeof envelope.task_id === 'string' ? envelope.task_id : 'claude-task',
        kind: 'tool',
        title: '',
        detail: typeof envelope.description === 'string' ? envelope.description : undefined,
        ...(output === '' ? {} : { output }),
        status: 'running'
      }
    }
  }

  if (envelope.type === 'system' && envelope.subtype === 'task_notification' && envelope.skip_transcript !== true) {
    const rawStatus = envelope.status
    const status = rawStatus === 'failed' ? 'failed' : rawStatus === 'stopped' ? 'blocked' : 'completed'
    return {
      kind: 'activity',
      activity: {
        id: typeof envelope.task_id === 'string' ? envelope.task_id : 'claude-task',
        kind: 'tool',
        title: '',
        detail: typeof envelope.summary === 'string' ? envelope.summary : undefined,
        status
      }
    }
  }

  if (envelope.type === 'result') {
    return {
      kind: 'result',
      text: typeof envelope.result === 'string' ? envelope.result : '',
      failed: envelope.is_error === true,
      usage: readClaudeUsage(envelope),
      ...(typeof envelope.session_id === 'string' ? { sessionId: envelope.session_id } : {})
    }
  }

  if (envelope.type === 'system' && typeof envelope.session_id === 'string') {
    return { kind: 'session', sessionId: envelope.session_id }
  }

  return null
}
