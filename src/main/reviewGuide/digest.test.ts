import { describe, expect, test } from 'bun:test'

import { categorizePath } from '../../shared/reviewCategories.js'
import { buildGuideDigest, buildGuidePrompt, excerptBudgets, guideTimeoutMs, sectionInstruction } from './digest.js'
import { indexReviewHunks, parsePatchSections } from './hunks.js'
import { joinPatch, modifiedFile } from './testFixtures.js'

function indexFor(patch: string) {
  return indexReviewHunks(parsePatchSections(patch), 'wt', (path) => categorizePath(path))
}

describe('buildGuideDigest', () => {
  const patch = joinPatch(
    modifiedFile('src/z.test.ts', [{ oldStart: 1, newStart: 1, lines: ['+test'] }]),
    modifiedFile('src/b.ts', [
      { oldStart: 1, newStart: 1, lines: ['+one'] },
      { oldStart: 50, newStart: 51, lines: ['+two'] }
    ]),
    modifiedFile('src/a.ts', [{ oldStart: 1, newStart: 1, lines: ['-gone'] }]),
    modifiedFile('bun.lock', [{ oldStart: 1, newStart: 1, lines: ['+x'] }])
  )

  test('lists implementation first, then by path, with global sequential aliases', () => {
    const digest = buildGuideDigest(indexFor(patch), { type: 'working-tree' })
    expect(digest.input.files.map((file) => [file.ref, file.path])).toEqual([
      ['f1', 'src/a.ts'], ['f2', 'src/b.ts'], ['f3', 'bun.lock'], ['f4', 'src/z.test.ts']
    ])
    expect(digest.input.files.flatMap((file) => file.hunks.map((hunk) => hunk.ref))).toEqual(['h1', 'h2', 'h3', 'h4', 'h5'])
    expect(digest.hunkCount).toBe(5)
  })

  test('the alias maps round-trip to paths and hunk ids', () => {
    const index = indexFor(patch)
    const digest = buildGuideDigest(index, { type: 'working-tree' })
    for (const file of digest.input.files) {
      expect(digest.aliases.files.get(file.ref)).toBe(file.path)
      for (const hunk of file.hunks) expect(index.byId.has(digest.aliases.hunks.get(hunk.ref)!)).toBe(true)
    }
    expect(digest.aliases.hunks.get('h3')).toBe('src/b.ts:wt:h2')
  })

  test('generated files carry no excerpt; text hunks do', () => {
    const digest = buildGuideDigest(indexFor(patch), { type: 'working-tree' })
    const lock = digest.input.files.find((file) => file.path === 'bun.lock')!
    expect(lock.generated).toBe(true)
    expect(lock.hunks[0]!.patch).toBeUndefined()
    expect(lock.hunks[0]!.kind).toBe('synthetic')
    expect(digest.input.files[0]!.hunks[0]!.patch).toBe('-gone')
  })

  test('an excerpt over its share is cut and ends in …', () => {
    const long = Array.from({ length: 2_000 }, (_, line) => `+line ${line} ${'x'.repeat(20)}`)
    const digest = buildGuideDigest(indexFor(joinPatch(modifiedFile('big.ts', [{ oldStart: 1, newStart: 1, lines: long }]))), { type: 'working-tree' })
    const excerpt = digest.input.files[0]!.hunks[0]!.patch!
    expect(excerpt.length).toBe(8_000)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  test('budgets shrink with the review', () => {
    expect(excerptBudgets(8)).toEqual({ perFile: 8_000, total: 60_000 })
    expect(excerptBudgets(9)).toEqual({ perFile: 2_500, total: 60_000 })
    expect(excerptBudgets(33)).toEqual({ perFile: 700, total: 35_000 })
  })

  test('a pull request description is capped at 4,000 characters', () => {
    const digest = buildGuideDigest(indexFor(patch), { type: 'pull-request', number: 4, description: 'd'.repeat(5_000) })
    expect(digest.input.source.description!.length).toBe(4_000)
  })
})

describe('sizing and timeout', () => {
  test('sectionInstruction picks the ceiling for each band', () => {
    expect(sectionInstruction(2, 30)).toBe('Use 1 section')
    expect(sectionInstruction(10, 12)).toBe('Use at most 2 sections')
    expect(sectionInstruction(4, 16)).toBe('Use at most 2 sections')
    expect(sectionInstruction(8, 32)).toBe('Use at most 4 sections')
    expect(sectionInstruction(30, 200)).toBe('Use 3–6 sections')
    expect(sectionInstruction(31, 200)).toBe('Use 4–8 sections')
  })

  test('the timeout scales with size and clamps', () => {
    expect(guideTimeoutMs(1, 1)).toBe(90_000)
    expect(guideTimeoutMs(18, 22)).toBe(90_000 + 10_000 + 20_000)
    expect(guideTimeoutMs(500, 900)).toBe(300_000)
  })

  test('the prompt carries the counts, sizing and digest, and a previous guide only as prose', () => {
    const digest = buildGuideDigest(indexFor(joinPatch(modifiedFile('a.ts', [{ oldStart: 1, newStart: 1, lines: ['+x'] }]))), { type: 'working-tree' })
    const prompt = buildGuidePrompt(digest, { customPrompt: 'Be terse.' })
    expect(prompt).toContain('The digest has 1 files and 1 hunks.')
    expect(prompt).toContain('- Use 1 section; this is a ceiling')
    expect(prompt).toContain('Custom guide instructions:\nBe terse.')
    expect(prompt).toContain('"ref":"f1"')
    expect(prompt).not.toContain('Previous guide to update')
  })
})
