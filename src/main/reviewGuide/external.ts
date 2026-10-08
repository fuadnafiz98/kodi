import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { GuideContextMessage } from '../../shared/reviewGuide.js'

export const MAX_GUIDE_FILE_BYTES = 8 * 1024 * 1024
const MAX_TRANSCRIPT_TAIL_BYTES = 16 * 1024 * 1024
const MAX_CONTEXT_MESSAGES = 18
const MAX_CONTEXT_MESSAGE_CHARS = 2_400
const MAX_CONTEXT_TOTAL_CHARS = 28_000

async function readTail(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return { text: buffer.toString('utf8'), truncated: length < size }
  } finally {
    await handle.close()
  }
}

/** A guide an agent wrote (`kodi --guide-file`): parsed JSON, or an error a reader can act on. */
export async function readGuideFile(path: string): Promise<unknown> {
  const info = await stat(path).catch(() => null)
  if (info == null || !info.isFile()) throw new Error(`No guide file at ${path}.`)
  if (info.size > MAX_GUIDE_FILE_BYTES) throw new Error('The guide file is larger than 8 MB.')
  const { text } = await readTail(path, MAX_GUIDE_FILE_BYTES)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error('The guide file is not valid JSON.')
  }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part): part is { type: 'text'; text: string } =>
      part != null && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
      && typeof (part as { text?: unknown }).text === 'string')
    .map((part) => part.text)
    .join('\n')
}

/**
 * The last words of a Claude Code session, from its transcript: user and
 * assistant text only (no tool calls or results), newest kept, capped so a
 * long session cannot swamp a later prompt.
 */
export function contextFromTranscript(text: string, truncated: boolean): GuideContextMessage[] {
  const lines = text.split('\n')
  // A tail read starts mid-line.
  if (truncated) lines.shift()
  const messages: GuideContextMessage[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    let entry: { type?: unknown; isMeta?: unknown; message?: { role?: unknown; content?: unknown } }
    try {
      entry = JSON.parse(line) as typeof entry
    } catch {
      continue
    }
    if ((entry.type !== 'user' && entry.type !== 'assistant') || entry.isMeta === true) continue
    const role = entry.message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const body = messageText(entry.message?.content).trim()
    // Slash-command plumbing and interrupted turns are not the conversation.
    if (body === '' || body.startsWith('<command-') || body.startsWith('<local-command') || body.startsWith('[Request interrupted')) continue
    messages.push({ role, text: body.length > MAX_CONTEXT_MESSAGE_CHARS ? `${body.slice(0, MAX_CONTEXT_MESSAGE_CHARS - 1)}…` : body })
  }
  const kept: GuideContextMessage[] = []
  let total = 0
  for (const message of messages.reverse()) {
    if (kept.length >= MAX_CONTEXT_MESSAGES || total + message.text.length > MAX_CONTEXT_TOTAL_CHARS) break
    kept.push(message)
    total += message.text.length
  }
  return kept.reverse()
}

/** `~/.claude/projects/<any>/<sessionId>.jsonl`, read from its tail; empty when there is none. */
export async function readClaudeSessionContext(homeDirectory: string, sessionId: string): Promise<GuideContextMessage[]> {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return []
  const projects = join(homeDirectory, '.claude', 'projects')
  const folders = await readdir(projects, { withFileTypes: true }).catch(() => [])
  for (const folder of folders) {
    if (!folder.isDirectory()) continue
    const path = join(projects, folder.name, `${sessionId}.jsonl`)
    const info = await stat(path).catch(() => null)
    if (info?.isFile() !== true) continue
    const { text, truncated } = await readTail(path, MAX_TRANSCRIPT_TAIL_BYTES)
    return contextFromTranscript(text, truncated)
  }
  return []
}
