import { describe, expect, test } from 'bun:test'

import { formatGuideMarkdown } from './formatGuideMarkdown'
import { guideHomeFiles, guideItemOrder, orderItemsByGuide, sectionIndexForItem, sectionLabel } from './guideOrder'
import { testGuide } from './testGuide'

const items = (...paths: string[]): Array<{ id: string }> => paths.map((path) => ({ id: `review:${path}` }))

describe('guide order', () => {
  test('draws each file once, at its home section, in the section\'s order', () => {
    expect(guideHomeFiles(testGuide()).map((file) => [file.path, file.sectionIndex])).toEqual([
      ['src/b.ts', 0],
      ['src/a.ts', 0],
      ['src/c.ts', 1],
      ['test/a.test.ts', 2]
    ])
  })

  test('puts a pill on each section\'s first file only', () => {
    const order = guideItemOrder(testGuide())
    expect([...order.pills]).toEqual([
      ['review:src/b.ts', '01 · Parser'],
      ['review:src/c.ts', '02 · Callers'],
      ['review:test/a.test.ts', 'Supporting · Tests']
    ])
  })

  test('sorts items by the guide and keeps unknown files at the end in load order', () => {
    const order = guideItemOrder(testGuide())
    const sorted = orderItemsByGuide(items('test/a.test.ts', 'new.ts', 'src/a.ts', 'later.ts', 'src/c.ts', 'src/b.ts'), order)
    expect(sorted.map((item) => item.id)).toEqual([
      'review:src/b.ts', 'review:src/a.ts', 'review:src/c.ts', 'review:test/a.test.ts', 'review:new.ts', 'review:later.ts'
    ])
  })

  test('items not loaded yet are simply absent', () => {
    const sorted = orderItemsByGuide(items('src/c.ts', 'src/b.ts'), guideItemOrder(testGuide()))
    expect(sorted.map((item) => item.id)).toEqual(['review:src/b.ts', 'review:src/c.ts'])
  })

  test('finds an item\'s home section', () => {
    const guide = testGuide()
    expect(sectionIndexForItem(guide, 'review:src/b.ts')).toBe(0)
    expect(sectionIndexForItem(guide, 'review:test/a.test.ts')).toBe(2)
    expect(sectionIndexForItem(guide, 'review:unknown.ts')).toBeNull()
    expect(sectionIndexForItem(guide, null)).toBeNull()
  })

  test('labels numbered and supporting sections', () => {
    const [first, , supporting] = testGuide().sections
    expect(sectionLabel(first!)).toBe('01')
    expect(sectionLabel(supporting!)).toBe('Supporting')
  })
})

describe('formatGuideMarkdown', () => {
  test('writes title, overview, sections and files, pointing repeats back', () => {
    expect(formatGuideMarkdown(testGuide())).toBe([
      '# Teach the parser comments',
      '',
      'Comments are now skipped.',
      '',
      '## 01 · Parser',
      '',
      'Parser body.',
      '',
      '- `src/b.ts` +2 −1',
      '- `src/a.ts` +2 −1',
      '',
      '## 02 · Callers',
      '',
      'Callers body.',
      '',
      '- `src/c.ts` +2 −1',
      '- `src/b.ts` (see above)',
      '',
      '## Supporting · Tests',
      '',
      'Tests body.',
      '',
      '- `test/a.test.ts` +5',
      ''
    ].join('\n'))
  })
})
