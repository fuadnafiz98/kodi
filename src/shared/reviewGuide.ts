import type { AgentProvider, AgentRequestSubject } from './contracts.js'

/**
 * A review guide as the renderer receives it: every reference resolved against
 * the live diff, counts recomputed, and every hunk owned by exactly one section.
 * Nothing in it is model text that skipped normalisation in main.
 */

/** Linear's `review-*` categories; one `.gitattributes` serves both tools. */
export type GuideFileCategory =
  | 'implementation'
  | 'test'
  | 'documentation'
  | 'generated'
  | 'agent-guidance'
  | 'localization'
  | 'assets'

export const GUIDE_FILE_CATEGORIES: readonly GuideFileCategory[] = [
  'implementation',
  'test',
  'documentation',
  'generated',
  'agent-guidance',
  'localization',
  'assets'
]

export interface GuideHunk {
  /** `<path>:<scope>:h<n>` */
  id: string
  /** 'f' + 16 hex of the hunk body without its `@@` line. */
  fingerprint: string
  kind: 'patch' | 'synthetic'
  /** Which side the first line lives on. */
  side: 'additions' | 'deletions'
  startLine: number | null
  endLine: number | null
  added: number
  deleted: number
  summary?: string
}

export interface GuideFile {
  path: string
  previousPath?: string
  category: GuideFileCategory
  generated: boolean
  /** Whole-file counts, so a file reads the same in every section that lists it. */
  added: number
  deleted: number
  /** True in the one section that draws this file in the diff (its first owner). */
  home: boolean
  /** The hunks this section owns in this file, in file order. */
  focus: GuideHunk[]
}

export interface GuideSection {
  id: string
  /** 1-based number among model sections; null for automatic sections ("Supporting"). */
  number: number | null
  title: string
  body: string
  kind: 'core' | 'supporting'
  automatic: boolean
  category?: GuideFileCategory
  files: GuideFile[]
  added: number
  deleted: number
  implementationAdded: number
  implementationDeleted: number
}

export interface GuideFacts {
  generatedAt: string
  provider: AgentProvider | 'file'
  model: string
  effort?: string
  scope: string
  subject: AgentRequestSubject
  cached?: boolean
}

export interface GuideContextMessage {
  role: 'user' | 'assistant'
  text: string
}

export interface NormalizedGuide {
  version: 1
  kind: 'review-guide'
  title: string
  overview?: string
  sections: GuideSection[]
  /** Model sections only: the "04" in "02 / 04". */
  sectionCount: number
  totals: {
    added: number
    deleted: number
    implementationAdded: number
    implementationDeleted: number
    files: number
  }
  commit?: { title: string; body: string }
  facts: GuideFacts
  context?: { messages: GuideContextMessage[]; source: string }
}

export interface ReviewGuideRequest {
  subject: AgentRequestSubject
  provider: AgentProvider
  model: string
  effort: string
  force?: boolean
  /** Cache only: answer from disk or say there is none, never call a model. */
  cachedOnly?: boolean
  customPrompt?: string
}

export type ReviewGuideUnavailableCode =
  | 'not-connected'
  | 'not-installed'
  | 'no-changes'
  | 'no-match'
  | 'not-cached'
  | 'timeout'
  | 'cancelled'
  | 'failed'

export type ReviewGuideReply =
  | { status: 'ready'; guide: NormalizedGuide; cached: boolean }
  | { status: 'unavailable'; reason: string; code?: ReviewGuideUnavailableCode }

export type ReviewGuidePhase = 'collecting' | 'thinking' | 'writing' | 'normalizing'

export interface ReviewGuideProgressEvent {
  tabId: string
  phase: ReviewGuidePhase
}
