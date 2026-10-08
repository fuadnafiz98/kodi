import { isAbsolute } from 'node:path'

import type { ReviewGuideRequest } from '../../shared/reviewGuide.js'
import { decodeAgentSubject } from '../agentRequest.js'

const MAX_CUSTOM_PROMPT_CHARS = 4_000

/** Rebuilt field by field: main never spreads a renderer payload into a typed object. */
export function decodeReviewGuideRequest(value: unknown): ReviewGuideRequest {
  if (typeof value !== 'object' || value == null || Array.isArray(value)) {
    throw new Error('The guide request is not valid.')
  }
  const candidate = value as Record<string, unknown>
  const subject = decodeAgentSubject(candidate.subject)
  if (subject == null || subject.tabId.trim() === '' || subject.tabId.length > 512 ||
      !isAbsolute(subject.repositoryRoot) || subject.repositoryRoot.length > 4_096) {
    throw new Error('The review tab could not be identified.')
  }
  if (subject.source !== 'workingTree' && (subject.baseOid == null || subject.headOid == null)) {
    throw new Error('The review tab does not identify an exact revision.')
  }
  const { provider, model, effort, force, cachedOnly, customPrompt } = candidate
  if (provider !== 'claude' && provider !== 'codex') throw new Error('The agent provider is not valid.')
  if (typeof model !== 'string' || (model !== '' && !/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,127}$/.test(model))) {
    throw new Error('The selected agent model is not valid.')
  }
  if (typeof effort !== 'string' || !/^[a-z0-9-]{0,32}$/i.test(effort)) {
    throw new Error('The selected reasoning effort is not valid.')
  }
  if (customPrompt !== undefined && (typeof customPrompt !== 'string' || customPrompt.length > MAX_CUSTOM_PROMPT_CHARS)) {
    throw new Error('The guide instructions are too long.')
  }
  return {
    subject,
    provider,
    model,
    effort,
    ...(force === true ? { force: true } : {}),
    ...(cachedOnly === true ? { cachedOnly: true } : {}),
    ...(typeof customPrompt === 'string' && customPrompt.trim() !== '' ? { customPrompt } : {})
  }
}
