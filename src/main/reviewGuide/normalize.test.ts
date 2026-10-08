import { describe, expect, test } from 'bun:test'

import type { AgentRequestSubject } from '../../shared/contracts.js'
import { categorizePath } from '../../shared/reviewCategories.js'
import type { GuideFacts } from '../../shared/reviewGuide.js'
import { buildGuideDigest } from './digest.js'
import { indexReviewHunks, parsePatchSections } from './hunks.js'
import { flattenProse, GuideNoMatchError, GuideShapeError, normalizeGuide, resolveGuideRef } from './normalize.js'
import { joinPatch, modifiedFile } from './testFixtures.js'

const PATCH = joinPatch(
  modifiedFile('src/api.ts', [
    { oldStart: 1, newStart: 1, lines: [' a', '-b', '+B', '+C'] },
    { oldStart: 300, newStart: 301, lines: [' x', '+y'] }
  ]),
  modifiedFile('src/model.ts', [{ oldStart: 5, newStart: 5, lines: ['-old', '+new'] }]),
  modifiedFile('src/view.ts', [{ oldStart: 9, newStart: 9, lines: ['+view'] }]),
  modifiedFile('src/api.test.ts', [{ oldStart: 1, newStart: 1, lines: ['+it()'] }]),
  modifiedFile('README.md', [{ oldStart: 1, newStart: 1, lines: ['+docs'] }]),
  modifiedFile('bun.lock', [{ oldStart: 1, newStart: 1, lines: ['+lock', '+lock2'] }])
)

const SUBJECT: AgentRequestSubject = {
  tabId: 'tab', repositoryRoot: '/repo', repositoryName: 'repo', source: 'workingTree', baseOid: null, headOid: null
}

function setup(scope = 'wt') {
  const index = indexReviewHunks(parsePatchSections(PATCH), scope, (path) => categorizePath(path))
  const digest = buildGuideDigest(index, { type: 'working-tree' })
  const facts: GuideFacts = { generatedAt: '2026-10-08T00:00:00.000Z', provider: 'claude', model: 'sonnet', scope, subject: SUBJECT }
  return { index, aliases: digest.aliases, facts, alias: (path: string) => [...digest.aliases.files].find(([, value]) => value === path)![0] }
}

function guide(sections: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { version: 1, kind: 'review-guide', title: 'Change', sections, ...extra }
}

function section(id: string, refs: string[], kind = 'core', title = id, body = `${id} body`): Record<string, unknown> {
  return { id, title, kind, body, refs }
}

describe('normalizeGuide', () => {
  test('garbage throws a shape error', () => {
    const { index, aliases, facts } = setup()
    for (const raw of [null, 'text', [], { version: 2, kind: 'review-guide', title: 't', sections: [{}] },
      { version: 1, kind: 'review-guide', title: 't', sections: [] }, { version: 1, kind: 'other', title: 't', sections: [{}] }]) {
      expect(() => normalizeGuide(raw, index, aliases, facts)).toThrow(GuideShapeError)
    }
  })

  test('an unknown alias is dropped and a section left empty disappears', () => {
    const { index, aliases, facts, alias } = setup()
    const result = normalizeGuide(guide([
      section('core', [alias('src/model.ts'), 'f99', 'h99']),
      section('ghost', ['f404'])
    ]), index, aliases, facts)
    expect(result.sections.filter((entry) => !entry.automatic).map((entry) => entry.id)).toEqual(['core'])
    expect(result.sectionCount).toBe(1)
  })

  test('zero core sections is no match', () => {
    const { index, aliases, facts, alias } = setup()
    expect(() => normalizeGuide(guide([section('a', ['f404']), section('b', [alias('src/view.ts')], 'supporting')]), index, aliases, facts))
      .toThrow(GuideNoMatchError)
  })

  test('a hunk named twice stays in the first section', () => {
    const { index, aliases, facts } = setup()
    const result = normalizeGuide(guide([section('one', ['h1']), section('two', ['h1', 'h3'])]), index, aliases, facts)
    expect(result.sections[0]!.files.flatMap((file) => file.focus.map((hunk) => hunk.id))).toEqual(['src/api.ts:wt:h1'])
    expect(result.sections[1]!.files.flatMap((file) => file.focus.map((hunk) => hunk.id))).toEqual(['src/model.ts:wt:h1'])
  })

  test('a whole-file ref after a single-hunk ref takes the rest, and points home', () => {
    const { index, aliases, facts, alias } = setup()
    const result = normalizeGuide(guide([section('one', ['h2']), section('two', [alias('src/api.ts')])]), index, aliases, facts)
    const [one, two] = result.sections
    expect(one!.files[0]).toMatchObject({ path: 'src/api.ts', home: true })
    expect(one!.files[0]!.focus.map((hunk) => hunk.id)).toEqual(['src/api.ts:wt:h2'])
    expect(two!.files[0]).toMatchObject({ path: 'src/api.ts', home: false })
    expect(two!.files[0]!.focus.map((hunk) => hunk.id)).toEqual(['src/api.ts:wt:h1'])
  })

  test('core sections come before supporting ones, whatever the model order', () => {
    const { index, aliases, facts, alias } = setup()
    const result = normalizeGuide(guide([
      section('later', [alias('src/view.ts')], 'supporting'),
      section('first', [alias('src/model.ts')])
    ]), index, aliases, facts)
    expect(result.sections.slice(0, 2).map((entry) => [entry.id, entry.number, entry.kind])).toEqual([
      ['first', 1, 'core'], ['later', 2, 'supporting']
    ])
  })

  test('unowned hunks fall into automatic sections in category order with fixed titles', () => {
    const { index, aliases, facts, alias } = setup()
    const result = normalizeGuide(guide([section('core', [alias('src/model.ts')])]), index, aliases, facts)
    const automatic = result.sections.filter((entry) => entry.automatic)
    expect(automatic.map((entry) => [entry.title, entry.number, entry.category])).toEqual([
      ['Tests', null, 'test'],
      ['Documentation', null, 'documentation'],
      ['Generated files', null, 'generated'],
      ['Other changes', null, 'implementation']
    ])
    expect(automatic.at(-1)!.files.map((file) => file.path)).toEqual(['src/api.ts', 'src/view.ts'])
    expect(automatic.every((entry) => entry.kind === 'supporting' && entry.files.every((file) => file.home))).toBe(true)
  })

  test('the ninth model section falls through to the automatic sections', () => {
    const index = indexReviewHunks(parsePatchSections(joinPatch(...Array.from({ length: 9 }, (_, n) =>
      modifiedFile(`src/f${n}.ts`, [{ oldStart: 1, newStart: 1, lines: ['+x'] }])))), 'wt', (path) => categorizePath(path))
    const digest = buildGuideDigest(index, { type: 'working-tree' })
    const facts: GuideFacts = { generatedAt: '', provider: 'claude', model: 'm', scope: 'wt', subject: SUBJECT }
    const result = normalizeGuide(guide(Array.from({ length: 9 }, (_, n) => section(`s${n}`, [`f${n + 1}`]))), index, digest.aliases, facts)
    expect(result.sectionCount).toBe(8)
    expect(result.sections.at(-1)).toMatchObject({ automatic: true, title: 'Other changes' })
    expect(result.sections.at(-1)!.files.map((file) => file.path)).toEqual([digest.aliases.files.get('f9')!])
  })

  test('caps trim titles, bodies, the overview and refs', () => {
    const { index, aliases, facts, alias } = setup()
    const refs = [alias('src/model.ts'), ...Array.from({ length: 50 }, () => 'f404'), alias('src/view.ts')]
    const result = normalizeGuide(guide([section('core', refs, 'core', 'T'.repeat(80), 'b'.repeat(2_000))], { overview: 'o'.repeat(600) }), index, aliases, facts)
    expect(result.sections[0]!.title.length).toBe(48)
    expect(result.sections[0]!.title.endsWith('…')).toBe(true)
    expect(result.sections[0]!.body.length).toBe(900)
    expect(result.overview!.length).toBe(400)
    // Only the first 40 refs are read: the view file sits past them.
    expect(result.sections[0]!.files.map((file) => file.path)).toEqual(['src/model.ts'])
  })

  test('markdown is flattened to sentences, inline code kept', () => {
    const { index, aliases, facts, alias } = setup()
    const body = '## Why\n- Keeps `api` stable.\n1. Then this.\n```ts\nconst x = 1\n```\nDone.'
    const result = normalizeGuide(guide([section('core', [alias('src/model.ts')], 'core', '# Title', body)]), index, aliases, facts)
    expect(result.sections[0]!.body).toBe('Why Keeps `api` stable. Then this. Done.')
    expect(result.sections[0]!.title).toBe('Title')
    expect(flattenProse('> quoted\n* star')).toBe('quoted star')
  })

  test('counts come from the hunks, never from the model', () => {
    const { index, aliases, facts } = setup()
    const raw = guide([{ ...section('core', ['h1', 'f3']), added: 999 }])
    const result = normalizeGuide(raw, index, aliases, facts)
    expect(result.sections[0]).toMatchObject({ added: 3, deleted: 1, implementationAdded: 3, implementationDeleted: 1 })
    expect(result.totals).toEqual({ added: 9, deleted: 2, implementationAdded: 5, implementationDeleted: 2, files: 6 })
    const tests = result.sections.find((entry) => entry.category === 'test')!
    expect(tests).toMatchObject({ added: 1, implementationAdded: 0 })
  })

  test('duplicate section ids get a suffix', () => {
    const { index, aliases, facts } = setup()
    const result = normalizeGuide(guide([section('same', ['h1']), section('same', ['h3']), section('', ['h4'])]), index, aliases, facts)
    expect(result.sections.slice(0, 3).map((entry) => entry.id)).toEqual(['same', 'same-2', 'section-3'])
  })

  test('commit is kept for the working tree and stripped for a patch', () => {
    const { index, aliases, facts } = setup()
    const raw = guide([section('core', ['h1'])], { commit: { title: 'Add things', body: 'Because.' } })
    expect(normalizeGuide(raw, index, aliases, facts).commit).toEqual({ title: 'Add things', body: 'Because.' })
    const patchFacts = { ...facts, subject: { ...SUBJECT, source: 'patch' as const } }
    expect(normalizeGuide(raw, index, aliases, patchFacts).commit).toBeUndefined()
  })

  test('null optional fields from a strict schema are treated as absent', () => {
    const { index, aliases, facts } = setup()
    const result = normalizeGuide(guide([section('core', ['h1'])], { overview: null, commit: null }), index, aliases, facts)
    expect(result.overview).toBeUndefined()
    expect(result.commit).toBeUndefined()
  })
})

describe('resolveGuideRef', () => {
  test('paths and hunk ids work without aliases', () => {
    const { index } = setup()
    expect(resolveGuideRef('src/api.ts', index, null).map((hunk) => hunk.id)).toEqual(['src/api.ts:wt:h1', 'src/api.ts:wt:h2'])
    expect(resolveGuideRef('src/api.ts:wt:h2', index, null).map((hunk) => hunk.id)).toEqual(['src/api.ts:wt:h2'])
    expect(resolveGuideRef('src/api.ts:wt:h9', index, null)).toEqual([])
  })

  test('an id written in another scope resolves to the hunk at the same place', () => {
    const { index } = setup('pull-request:12')
    expect(resolveGuideRef('src/model.ts:staged:h1', index, null).map((hunk) => hunk.id)).toEqual(['src/model.ts:pull-request:12:h1'])
    expect(resolveGuideRef('src/model.ts:pull-request:12:h1', index, null)).toHaveLength(1)
  })

  test('a pinned fingerprint must match the live hunk', () => {
    const { index } = setup()
    const live = index.byId.get('src/model.ts:wt:h1')!
    expect(resolveGuideRef(`src/model.ts:${'a'.repeat(40)}:h1@${live.fingerprint}`, index, null)).toHaveLength(1)
    expect(resolveGuideRef(`src/model.ts:${'a'.repeat(40)}:h1@f0000000000000000`, index, null)).toEqual([])
  })
})
