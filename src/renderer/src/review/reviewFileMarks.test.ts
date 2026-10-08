import { describe, expect, test } from 'bun:test'

import { generatedCollapseChanges, isGeneratedReviewPath } from './reviewFileMarks'

const pathOf = (id: string): string => id.slice('review:'.length)

describe('generated review files', () => {
  test('heuristics decide until the attributes answer, then the attributes do', () => {
    expect(isGeneratedReviewPath('bun.lock', null)).toBe(true)
    expect(isGeneratedReviewPath('src/app.ts', null)).toBe(false)
    // `bun.lock -linguist-generated`, `docs/*.md linguist-generated`
    const marked = new Set(['docs/api.md'])
    expect(isGeneratedReviewPath('bun.lock', marked)).toBe(false)
    expect(isGeneratedReviewPath('docs/api.md', marked)).toBe(true)
  })

  test('a generated item starts collapsed once per world; a reader who opens it keeps it open', () => {
    const ids = ['review:src/a.ts', 'review:bun.lock']
    const none = new Set<string>()
    expect(generatedCollapseChanges('world-a', ids, pathOf, new Set(), none)).toEqual({ collapse: [], expand: [] })
    expect(generatedCollapseChanges('world-b', ids, pathOf, null, none)).toEqual({ collapse: ['review:bun.lock'], expand: [] })
    expect(generatedCollapseChanges('world-b', ids, pathOf, null, new Set(['review:bun.lock']))).toEqual({ collapse: [], expand: [] })
    expect(generatedCollapseChanges('world-b', [...ids, 'review:yarn.lock'], pathOf, null, new Set(['review:bun.lock'])))
      .toEqual({ collapse: ['review:yarn.lock'], expand: [] })
  })

  test('the attributes correct a heuristic decision the reader has not touched', () => {
    const ids = ['review:bun.lock', 'review:yarn.lock', 'review:vendor/x.js']
    generatedCollapseChanges('world-c', ids, pathOf, null, new Set())
    // The reader opened yarn.lock before the attributes answered.
    const collapsed = new Set(['review:bun.lock'])
    // `bun.lock -linguist-generated`, `vendor/** linguist-generated`; yarn.lock stays generated.
    expect(generatedCollapseChanges('world-c', ids, pathOf, new Set(['yarn.lock', 'vendor/x.js']), collapsed))
      .toEqual({ collapse: ['review:vendor/x.js'], expand: ['review:bun.lock'] })
    expect(generatedCollapseChanges('world-c', ids, pathOf, new Set(['yarn.lock', 'vendor/x.js']), new Set()))
      .toEqual({ collapse: [], expand: [] })
  })
})
