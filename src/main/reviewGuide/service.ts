import { randomUUID } from 'node:crypto'

import type { AgentProvider, AgentRequestSubject } from '../../shared/contracts.js'
import { categorizePath, type ReviewFileAttributes } from '../../shared/reviewCategories.js'
import type {
  GuideContextMessage,
  GuideFacts,
  NormalizedGuide,
  ReviewGuidePhase,
  ReviewGuideReply,
  ReviewGuideUnavailableCode
} from '../../shared/reviewGuide.js'
import type { StructuredRunRequest, StructuredRunResult } from '../agentService.js'
import { guideCacheKey, readStoredGuide, writeStoredGuide } from './cache.js'
import { buildGuideDigest, buildGuidePrompt, guideTimeoutMs, type GuideSource } from './digest.js'
import { guideScopeForSubject, indexReviewHunks, parsePatchSections, type ReviewHunkIndex } from './hunks.js'
import { GuideNoMatchError, GuideShapeError, normalizeGuide } from './normalize.js'
import { GUIDE_GENERATION_SCHEMA, GUIDE_SCHEMA_VERSION, strictResponseSchema } from './schema.js'

export interface ReviewGuideServiceDependencies {
  userDataPath: string
  /** The patch the review tab shows; null when there is nothing to describe. */
  resolvePatch(subject: AgentRequestSubject): Promise<{ patch: string; title: string | null } | null>
  runStructured(request: StructuredRunRequest): Promise<StructuredRunResult>
  cancelRun(id: string): void
  /** `.gitattributes` for the review's paths (WS-G); path heuristics without it. */
  readAttributes?(
    subject: AgentRequestSubject,
    paths: readonly string[]
  ): Promise<ReadonlyMap<string, ReviewFileAttributes>>
  now?(): Date
}

export interface GenerateGuideOptions {
  subject: AgentRequestSubject
  provider: AgentProvider
  model: string
  effort: string
  force?: boolean
  cachedOnly?: boolean
  customPrompt?: string
  context?: readonly GuideContextMessage[]
  onPhase?(phase: ReviewGuidePhase): void
}

interface Flight {
  promise: Promise<ReviewGuideReply>
  runId: string
  tabIds: Set<string>
  cancelled: boolean
}

const MAX_REMEMBERED_TAB_GUIDES = 32
const MAX_PATCH_ATTEMPTS = 4
const STRICT_GENERATION_SCHEMA = strictResponseSchema(GUIDE_GENERATION_SCHEMA)

function unavailable(reason: string, code: ReviewGuideUnavailableCode): ReviewGuideReply {
  return { status: 'unavailable', reason, code }
}

function describeFailure(error: unknown): ReviewGuideReply {
  const message = error instanceof Error ? error.message : 'The guide could not be written.'
  if (error instanceof GuideNoMatchError) return unavailable("The model's guide did not match this diff.", 'no-match')
  if (error instanceof GuideShapeError) return unavailable(message, 'failed')
  if (/not connected/i.test(message)) return unavailable(message, 'not-connected')
  if (/ENOENT|not installed/i.test(message)) return unavailable('The agent CLI is not installed.', 'not-installed')
  if (/timed out|stopped responding|maximum turn length/i.test(message)) {
    return unavailable('The model took too long to write the guide.', 'timeout')
  }
  return unavailable(message.split('\n')[0]!.slice(0, 400), 'failed')
}

function sourceFor(subject: AgentRequestSubject, title: string | null): GuideSource {
  if (subject.source === 'workingTree') return { type: 'working-tree' }
  const number = subject.pullRequestUrl == null ? null : /\/pull\/(\d+)/.exec(subject.pullRequestUrl)?.[1]
  if (number != null && subject.pullRequestUrl != null) {
    return {
      type: 'pull-request',
      number: Number(number),
      url: subject.pullRequestUrl,
      ...(title == null ? {} : { title: title.replace(/^#\d+\s+/, '') })
    }
  }
  return { type: 'compare', ...(title == null ? {} : { title }) }
}

/**
 * Writes, caches and serves review guides. The renderer never sees what a model
 * returned: only `normalizeGuide`'s output, resolved against the live diff.
 */
export class ReviewGuideService {
  readonly #deps: ReviewGuideServiceDependencies
  #flights = new Map<string, Flight>()
  #flightByTab = new Map<string, string>()
  // A request still collecting its diff or reading the cache: no flight yet,
  // so Cancel marks this and the request stops before it starts a run.
  #startingByTab = new Map<string, { cancelled: boolean }>()
  // The last guide each tab showed, so Regenerate can hand the model its prose
  // without the renderer sending model text back to main.
  #lastGuideByTab = new Map<string, NormalizedGuide>()

  constructor(deps: ReviewGuideServiceDependencies) {
    this.#deps = deps
  }

  /** Files and hunks for a subject, categorised; null when there is no change. */
  async collect(subject: AgentRequestSubject): Promise<{ index: ReviewHunkIndex; title: string | null } | null> {
    const resolved = await this.#resolvePatch(subject)
    if (resolved == null) return null
    const sections = parsePatchSections(resolved.patch)
    if (sections.length === 0) return null
    const attributes = this.#deps.readAttributes == null
      ? new Map<string, ReviewFileAttributes>()
      : await this.#deps.readAttributes(subject, sections.map((section) => section.path)).catch(() => new Map())
    const index = indexReviewHunks(
      sections,
      guideScopeForSubject(subject),
      (path) => categorizePath(path, attributes.get(path))
    )
    return { index, title: resolved.title }
  }

  // A status tick cancels the working tree's patch read in flight (a folder
  // reopened by `kodi`, a save); the read is simply asked again.
  async #resolvePatch(subject: AgentRequestSubject): Promise<{ patch: string; title: string | null } | null> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.#deps.resolvePatch(subject)
      } catch (error) {
        const cancelled = error instanceof Error && /cancelled before it finished/i.test(error.message)
        if (!cancelled || attempt >= MAX_PATCH_ATTEMPTS) throw error
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 150 * attempt))
      }
    }
  }

  #facts(subject: AgentRequestSubject, provider: GuideFacts['provider'], model: string, effort: string, scope: string): GuideFacts {
    return {
      generatedAt: (this.#deps.now?.() ?? new Date()).toISOString(),
      provider,
      model,
      ...(effort === '' || effort === 'default' ? {} : { effort }),
      scope,
      subject
    }
  }

  async generate(options: GenerateGuideOptions): Promise<ReviewGuideReply> {
    const starting = { cancelled: false }
    this.#startingByTab.set(options.subject.tabId, starting)
    try {
      return await this.#generate(options, starting)
    } finally {
      if (this.#startingByTab.get(options.subject.tabId) === starting) this.#startingByTab.delete(options.subject.tabId)
    }
  }

  async #generate(options: GenerateGuideOptions, starting: { cancelled: boolean }): Promise<ReviewGuideReply> {
    const { subject } = options
    options.onPhase?.('collecting')
    let collected: Awaited<ReturnType<ReviewGuideService['collect']>>
    try {
      collected = await this.collect(subject)
    } catch (error) {
      return describeFailure(error)
    }
    if (collected == null) return unavailable('This review has no changes to describe.', 'no-changes')
    const { index, title } = collected
    const digest = buildGuideDigest(index, sourceFor(subject, title), subject.workingBranch)
    const keyFor = (model: string): string => guideCacheKey({
      provider: options.provider,
      model,
      // The previous guide is left out: a regenerate is stored where the next
      // plain open of the same diff looks.
      prompt: buildGuidePrompt(digest, {
        ...(options.context == null ? {} : { context: options.context }),
        ...(options.customPrompt == null ? {} : { customPrompt: options.customPrompt })
      }),
      schemaVersion: GUIDE_SCHEMA_VERSION,
      hunkIds: index.files.flatMap((file) => file.hunks.map((hunk) => hunk.id)),
      fingerprints: index.files.flatMap((file) => file.hunks.map((hunk) => hunk.fingerprint)),
      categories: Object.fromEntries(index.files.map((file) => [file.path, file.category]))
    })
    const key = keyFor(options.model)

    if (options.force !== true) {
      const stored = await readStoredGuide(this.#deps.userDataPath, key)
      if (stored != null) {
        // Another tab may hold the same diff; facts.subject must name this one.
        const guide: NormalizedGuide = { ...stored, facts: { ...stored.facts, subject, cached: true } }
        this.#rememberTabGuide(subject.tabId, guide)
        return { status: 'ready', guide, cached: true }
      }
    }
    if (options.cachedOnly === true) return unavailable('No guide has been written for this review yet.', 'not-cached')
    if (starting.cancelled) return unavailable('The guide was cancelled.', 'cancelled')

    // A run already writing this diff's guide is joined, a regenerate too: a
    // second run would be paid for twice and leave Cancel stopping neither.
    const joined = this.#flights.get(key)
    if (joined != null) {
      joined.tabIds.add(subject.tabId)
      this.#flightByTab.set(subject.tabId, key)
      return await joined.promise
    }

    const previous = options.force === true ? this.#lastGuideByTab.get(subject.tabId) : undefined
    const context = options.context ?? (previous?.context?.messages.length ? previous.context.messages : undefined)
    const runId = `guide:${randomUUID()}`
    const flight: Flight = { promise: Promise.resolve(unavailable('', 'cancelled')), runId, tabIds: new Set([subject.tabId]), cancelled: false }
    flight.promise = (async (): Promise<ReviewGuideReply> => {
      try {
        const result = await this.#deps.runStructured({
          id: runId,
          provider: options.provider,
          model: options.model,
          effort: options.effort,
          prompt: buildGuidePrompt(digest, {
            // A guide an agent handed over brings its session; a regenerate keeps it.
            ...(context == null ? {} : { context }),
            ...(options.customPrompt == null ? {} : { customPrompt: options.customPrompt }),
            ...(previous == null ? {} : { previous })
          }),
          schema: STRICT_GENERATION_SCHEMA,
          cwd: subject.repositoryRoot,
          timeoutMs: guideTimeoutMs(digest.fileCount, digest.hunkCount),
          onPhase: (phase) => { if (!flight.cancelled) options.onPhase?.(phase) }
        })
        if (flight.cancelled) return unavailable('The guide was cancelled.', 'cancelled')
        options.onPhase?.('normalizing')
        const guide = normalizeGuide(
          result.json,
          index,
          digest.aliases,
          this.#facts(subject, options.provider, result.model, options.effort, index.scope)
        )
        const stored = writeStoredGuide(this.#deps.userDataPath, key, guide)
        await (result.model === options.model
          ? stored
          : Promise.all([stored, writeStoredGuide(this.#deps.userDataPath, keyFor(result.model), guide)]))
          .catch(() => undefined)
        this.#rememberTabGuide(subject.tabId, guide)
        return { status: 'ready', guide, cached: false }
      } catch (error) {
        if (flight.cancelled) return unavailable('The guide was cancelled.', 'cancelled')
        return describeFailure(error)
      } finally {
        if (this.#flights.get(key) === flight) this.#flights.delete(key)
        for (const tabId of flight.tabIds) {
          if (this.#flightByTab.get(tabId) === key) this.#flightByTab.delete(tabId)
        }
      }
    })()
    this.#flights.set(key, flight)
    this.#flightByTab.set(subject.tabId, key)
    return await flight.promise
  }

  /**
   * A guide someone else wrote (an agent's `--guide-file`), checked and
   * repaired against the live diff exactly like a model's answer.
   */
  async normalizeExternal(
    subject: AgentRequestSubject,
    raw: unknown,
    context?: { messages: GuideContextMessage[]; source: string }
  ): Promise<ReviewGuideReply> {
    let collected: Awaited<ReturnType<ReviewGuideService['collect']>>
    try {
      collected = await this.collect(subject)
    } catch (error) {
      return describeFailure(error)
    }
    if (collected == null) return unavailable('This review has no changes to describe.', 'no-changes')
    try {
      const guide = normalizeGuide(raw, collected.index, null, this.#facts(subject, 'file', 'agent', '', collected.index.scope))
      const withContext = context == null || context.messages.length === 0 ? guide : { ...guide, context }
      this.#rememberTabGuide(subject.tabId, withContext)
      return { status: 'ready', guide: withContext, cached: false }
    } catch (error) {
      if (error instanceof GuideNoMatchError) {
        return unavailable('The guide no longer matches the working tree.', 'no-match')
      }
      return describeFailure(error)
    }
  }

  cancel(tabId: string): void {
    const starting = this.#startingByTab.get(tabId)
    if (starting != null) starting.cancelled = true
    const key = this.#flightByTab.get(tabId)
    if (key == null) return
    this.#flightByTab.delete(tabId)
    const flight = this.#flights.get(key)
    if (flight == null) return
    flight.tabIds.delete(tabId)
    // Another tab still waiting on the same diff keeps the run going.
    if (flight.tabIds.size > 0) return
    flight.cancelled = true
    this.#deps.cancelRun(flight.runId)
  }

  #rememberTabGuide(tabId: string, guide: NormalizedGuide): void {
    this.#lastGuideByTab.delete(tabId)
    this.#lastGuideByTab.set(tabId, guide)
    while (this.#lastGuideByTab.size > MAX_REMEMBERED_TAB_GUIDES) {
      const oldest = this.#lastGuideByTab.keys().next().value
      if (oldest == null) break
      this.#lastGuideByTab.delete(oldest)
    }
  }

  get busyCount(): number {
    return this.#flights.size
  }
}
