import type { AgentAccessMode } from '../../../shared/contracts'

export const ACCESS_MODES: Record<AgentAccessMode, { label: string; description: string }> = {
  review: { label: 'Review', description: 'Read, search, and sandboxed Bash. Repository writes are blocked.' },
  auto: { label: 'Auto', description: 'Run sandboxed commands and workspace edits. Ask when more access is required.' },
  'full-access': { label: 'Full access', description: 'Run without approvals or sandbox limits until Kodi restarts.' }
}

export const EFFORT_LABELS: Record<string, string> = {
  low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra'
}

export const QUICK_PROMPTS = [
  { label: 'Explain', prompt: 'Explain what this change does and why, in a few short paragraphs.' },
  { label: 'Find risks', prompt: 'Review this change for bugs, edge cases, and risky behavior. Cite exact file paths and lines.' },
  { label: 'Diagram', prompt: 'Walk through this change with mermaid diagrams: a state or sequence flow for the new behavior, and how it differs from the current checkout. Stay inside the listed files and their callers.' },
  { label: 'Test plan', prompt: 'Inspect the code and propose the highest-value tests. List concrete cases and affected files.' }
] as const
