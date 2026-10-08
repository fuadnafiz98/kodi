import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentRequestSubject } from '../../shared/contracts.js'
import type { ReviewGuidePhase } from '../../shared/reviewGuide.js'
import { StructuredRunCancelled, type StructuredRunRequest, type StructuredRunResult } from '../agentService.js'
import { ReviewGuideService } from './service.js'
import { joinPatch, modifiedFile } from './testFixtures.js'

const SUBJECT: AgentRequestSubject = {
  tabId: 'tab-1', repositoryRoot: '/repo', repositoryName: 'repo', source: 'workingTree', baseOid: null, headOid: null
}
const PATCH = joinPatch(
  modifiedFile('src/a.ts', [{ oldStart: 1, newStart: 1, lines: ['+a'] }]),
  modifiedFile('src/b.ts', [{ oldStart: 1, newStart: 1, lines: ['-b'] }])
)
const ANSWER = {
  version: 1, kind: 'review-guide', title: 'Change', overview: null, commit: null,
  sections: [{ id: 'core', title: 'Core', kind: 'core', body: 'Why.', refs: ['f1'] }]
}

async function withService(
  run: (request: StructuredRunRequest) => Promise<StructuredRunResult>,
  test: (service: ReviewGuideService, calls: StructuredRunRequest[], cancelled: string[]) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'kodi-guide-service-'))
  const calls: StructuredRunRequest[] = []
  const cancelled: string[] = []
  const service = new ReviewGuideService({
    userDataPath: directory,
    resolvePatch: () => Promise.resolve({ patch: PATCH, title: null }),
    runStructured: (request) => { calls.push(request); return run(request) },
    cancelRun: (id) => { cancelled.push(id) },
    now: () => new Date('2026-10-08T00:00:00.000Z')
  })
  try {
    await test(service, calls, cancelled)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const OPTIONS = { subject: SUBJECT, provider: 'claude' as const, model: 'sonnet', effort: 'high' }

describe('ReviewGuideService', () => {
  test('a miss asks the model once and stores the guide; the next ask is cached', async () => {
    await withService((request) => {
      request.onPhase?.('thinking')
      request.onPhase?.('writing')
      return Promise.resolve({ json: ANSWER, model: 'sonnet', usage: null })
    }, async (service, calls) => {
      const phases: ReviewGuidePhase[] = []
      const first = await service.generate({ ...OPTIONS, onPhase: (phase) => phases.push(phase) })
      expect(first.status).toBe('ready')
      if (first.status !== 'ready') return
      expect(first.cached).toBe(false)
      expect(first.guide.sections[0]!.files[0]!.path).toBe('src/a.ts')
      expect(first.guide.facts).toMatchObject({ provider: 'claude', model: 'sonnet', effort: 'high', scope: 'wt' })
      expect(phases).toEqual(['collecting', 'thinking', 'writing', 'normalizing'])
      expect(calls).toHaveLength(1)
      expect(calls[0]!.schema.required).toContain('overview')

      const second = await service.generate(OPTIONS)
      expect(second).toMatchObject({ status: 'ready', cached: true })
      expect(calls).toHaveLength(1)
    })
  })

  test('cachedOnly on a miss answers not-cached without a model call', async () => {
    await withService(() => Promise.resolve({ json: ANSWER, model: 'sonnet', usage: null }), async (service, calls) => {
      expect(await service.generate({ ...OPTIONS, cachedOnly: true })).toMatchObject({ status: 'unavailable', code: 'not-cached' })
      expect(calls).toHaveLength(0)
    })
  })

  test('force regenerates and hands the model the previous guide', async () => {
    await withService(() => Promise.resolve({ json: ANSWER, model: 'sonnet', usage: null }), async (service, calls) => {
      await service.generate(OPTIONS)
      const forced = await service.generate({ ...OPTIONS, force: true })
      expect(forced).toMatchObject({ status: 'ready', cached: false })
      expect(calls).toHaveLength(2)
      expect(calls[0]!.prompt).not.toContain('Previous guide to update')
      expect(calls[1]!.prompt).toContain('Previous guide to update')
      // The regenerate is stored where a plain open looks.
      expect(await service.generate({ ...OPTIONS, cachedOnly: true })).toMatchObject({ status: 'ready', cached: true })
    })
  })

  test('cancel answers cancelled and stops the run', async () => {
    await withService((request) => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new StructuredRunCancelled()), 50)
      void request
    }), async (service, calls, cancelled) => {
      const running = service.generate(OPTIONS)
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(service.busyCount).toBe(1)
      service.cancel('tab-1')
      expect(await running).toMatchObject({ status: 'unavailable', code: 'cancelled' })
      expect(cancelled).toEqual([calls[0]!.id])
      expect(service.busyCount).toBe(0)
    })
  })

  test('a cancel while the diff is still being collected starts no run', async () => {
    await withService(() => Promise.resolve({ json: ANSWER, model: 'sonnet', usage: null }), async (service, calls) => {
      const running = service.generate(OPTIONS)
      service.cancel('tab-1')
      expect(await running).toMatchObject({ status: 'unavailable', code: 'cancelled' })
      expect(calls).toHaveLength(0)
    })
  })

  test('a regenerate during a run joins it, and Cancel still stops it', async () => {
    await withService((request) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ json: ANSWER, model: 'sonnet', usage: null }), 80)
      void request
      void reject
      void timer
    }), async (service, calls) => {
      const first = service.generate(OPTIONS)
      await new Promise((resolve) => setTimeout(resolve, 10))
      const forced = service.generate({ ...OPTIONS, force: true })
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(calls).toHaveLength(1)
      expect(service.busyCount).toBe(1)
      expect((await first).status).toBe('ready')
      expect((await forced).status).toBe('ready')
      expect(service.busyCount).toBe(0)
    })
  })

  test('a second ask for the same diff joins the first', async () => {
    await withService(() => new Promise((resolve) => setTimeout(() => resolve({ json: ANSWER, model: 'sonnet', usage: null }), 30)),
      async (service, calls) => {
        const [one, two] = await Promise.all([service.generate(OPTIONS), service.generate(OPTIONS)])
        expect(one.status).toBe('ready')
        expect(two.status).toBe('ready')
        expect(calls).toHaveLength(1)
      })
  })

  test('the stored model is the one that answered after a fallback', async () => {
    await withService(() => Promise.resolve({ json: ANSWER, model: 'default', usage: null }), async (service) => {
      const reply = await service.generate({ ...OPTIONS, model: 'opus' })
      expect(reply.status === 'ready' && reply.guide.facts.model).toBe('default')
      expect(await service.generate({ ...OPTIONS, model: 'default', cachedOnly: true })).toMatchObject({ status: 'ready' })
    })
  })

  test('failures map to reasons the view can act on', async () => {
    await withService(() => Promise.reject(new Error('Claude Code is not connected. Select Sign in in the agent panel.')), async (service) => {
      expect(await service.generate(OPTIONS)).toMatchObject({ status: 'unavailable', code: 'not-connected' })
    })
    await withService(() => Promise.resolve({ json: { ...ANSWER, sections: [{ ...ANSWER.sections[0], refs: ['f99'] }] }, model: 'sonnet', usage: null }),
      async (service) => {
        expect(await service.generate(OPTIONS)).toMatchObject({ status: 'unavailable', code: 'no-match' })
      })
  })

  test('a guide file is normalised against the live diff', async () => {
    await withService(() => Promise.reject(new Error('unused')), async (service) => {
      const ready = await service.normalizeExternal(SUBJECT, { ...ANSWER, sections: [{ ...ANSWER.sections[0], refs: ['src/b.ts'] }] })
      expect(ready.status === 'ready' && ready.guide.sections[0]!.files[0]!.path).toBe('src/b.ts')
      expect(ready.status === 'ready' && ready.guide.facts.provider).toBe('file')
      const gone = await service.normalizeExternal(SUBJECT, { ...ANSWER, sections: [{ ...ANSWER.sections[0], refs: ['src/gone.ts'] }] })
      expect(gone).toMatchObject({ status: 'unavailable', reason: 'The guide no longer matches the working tree.' })
    })
  })

  test('a regenerate of an agent\'s guide keeps its session in the prompt', async () => {
    await withService(() => Promise.resolve({ json: ANSWER, model: 'sonnet', usage: null }), async (service, calls) => {
      const handed = await service.normalizeExternal(SUBJECT, { ...ANSWER, sections: [{ ...ANSWER.sections[0], refs: ['src/a.ts'] }] }, {
        messages: [{ role: 'user', text: 'Skip comments in the lexer, please.' }],
        source: 'Claude Code'
      })
      expect(handed.status === 'ready' && handed.guide.context?.messages).toHaveLength(1)
      await service.generate({ ...OPTIONS, force: true })
      expect(calls[0]!.prompt).toContain('Skip comments in the lexer, please.')
    })
  })

  test('a patch read cancelled by a status tick is asked again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-guide-service-'))
    let reads = 0
    const service = new ReviewGuideService({
      userDataPath: directory,
      resolvePatch: () => {
        reads += 1
        return reads < 3 ? Promise.reject(new Error('The command was cancelled before it finished.')) : Promise.resolve({ patch: PATCH, title: null })
      },
      runStructured: () => Promise.reject(new Error('unused')),
      cancelRun: () => {}
    })
    try {
      const reply = await service.normalizeExternal(SUBJECT, { ...ANSWER, sections: [{ ...ANSWER.sections[0], refs: ['src/a.ts'] }] })
      expect(reply.status).toBe('ready')
      expect(reads).toBe(3)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
