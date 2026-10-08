import type { AgentProvider } from '../shared/contracts.js'
import type { StructuredRunRequest, StructuredRunResult } from './agentService.js'
import { findPatchSectionStarts } from './patchBuilder.js'

export const COMMIT_DIFF_BUDGET = 60_000
const MAX_TITLE = 72

export const COMMIT_MESSAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body'],
  properties: {
    title: { type: 'string' },
    body: { type: 'string' }
  }
} as const

export interface CommitMessageRequest {
  id: string
  root: string
  name: string
  branch: string | null
  provider: AgentProvider
  model: string
  effort: string
}

export interface CommitMessageDependencies {
  stagedDiff(root: string): Promise<string>
  runStructured(request: StructuredRunRequest): Promise<StructuredRunResult>
}

/**
 * The staged diff within a budget, every file getting a fair share: a lockfile
 * cannot crowd out the change it came with. `…` marks a cut.
 */
export function fairTruncateDiff(diff: string, budget = COMMIT_DIFF_BUDGET): string {
  if (diff.length <= budget) return diff
  const starts = findPatchSectionStarts(diff)
  const sections = starts.length === 0
    ? [diff]
    : starts.map((start, index) => diff.slice(start, starts[index + 1] ?? diff.length))
  const sorted = [...sections].sort((left, right) => left.length - right.length)
  const shares = new Map<string, number>()
  let remaining = budget
  sorted.forEach((section, index) => {
    const share = Math.floor(remaining / (sorted.length - index))
    const taken = Math.min(section.length, share)
    shares.set(section, taken)
    remaining -= taken
  })
  return sections.map((section) => {
    const taken = shares.get(section) ?? 0
    return taken >= section.length ? section : `${section.slice(0, taken)}\n…\n`
  }).join('')
}

export function buildCommitPrompt(name: string, branch: string | null, diff: string): string {
  return [
    'Write a git commit message for the staged change below. Return JSON only: {"title": "...", "body": "..."}.',
    'title: imperative, at most 72 characters, no trailing period. body: short paragraphs explaining what',
    'and why, wrapped at 72 columns; empty string when the title says it all. Do not restate the title in',
    'the body. Do not invent motivation the diff does not support.',
    '',
    `Repository: ${name} · Branch: ${branch ?? 'detached'}`,
    '',
    'Staged diff (excerpts; … marks truncation):',
    fairTruncateDiff(diff)
  ].join('\n')
}

/** Title and body as the composer takes them: one line of ≤ 72, no period, the title not repeated. */
export function normalizeCommitMessage(raw: unknown): { title: string; body: string } {
  const value = raw as { title?: unknown; body?: unknown } | null
  let title = typeof value?.title === 'string' ? value.title.split('\n')[0]!.trim() : ''
  let body = typeof value?.body === 'string' ? value.body.trim() : ''
  if (title === '') throw new Error('The model did not suggest a commit title.')
  title = title.replace(/\.+$/, '')
  if (title.length > MAX_TITLE) title = `${title.slice(0, MAX_TITLE - 1).trimEnd()}…`
  const [firstLine, ...rest] = body.split('\n')
  if (firstLine != null && firstLine.trim().replace(/\.+$/, '') === title) body = rest.join('\n').trim()
  return { title, body }
}

export async function suggestCommitMessage(
  request: CommitMessageRequest,
  deps: CommitMessageDependencies
): Promise<{ title: string; body: string }> {
  const diff = await deps.stagedDiff(request.root)
  if (diff.trim() === '') throw new Error('Stage changes first: the suggestion reads the staged diff.')
  const result = await deps.runStructured({
    id: request.id,
    provider: request.provider,
    model: request.model,
    effort: request.effort,
    prompt: buildCommitPrompt(request.name, request.branch, diff),
    schema: COMMIT_MESSAGE_SCHEMA as unknown as StructuredRunRequest['schema'],
    cwd: request.root,
    timeoutMs: 120_000
  })
  return normalizeCommitMessage(result.json)
}
