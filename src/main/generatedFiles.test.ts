import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { markReviewFiles, parseCheckAttr } from './generatedFiles.js'

describe('parseCheckAttr', () => {
  test('reads set, unset and category attributes', () => {
    const output = Buffer.from([
      'a.lock', 'linguist-generated', 'unset',
      'docs/x.md', 'linguist-generated', 'set',
      'spec/f.json', 'review-test', 'set',
      'src/a.ts', 'review-test', 'unspecified'
    ].join('\0') + '\0')
    const attributes = parseCheckAttr(output)
    expect(attributes.get('a.lock')).toEqual({ generated: false })
    expect(attributes.get('docs/x.md')).toEqual({ generated: true })
    expect(attributes.get('spec/f.json')).toEqual({ category: 'test' })
    expect(attributes.has('src/a.ts')).toBe(false)
  })
})

describe('markReviewFiles', () => {
  test('.gitattributes overrides the heuristics both ways and sets review categories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-generated-'))
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      await writeFile(join(root, '.gitattributes'), [
        'docs/*.md linguist-generated',
        'bun.lock -linguist-generated',
        'spec/fixtures/** review-test',
        'api/** review-generated'
      ].join('\n'))
      const paths = ['docs/api.md', 'bun.lock', 'yarn.lock', 'spec/fixtures/data.json', 'api/client.ts', 'src/app.ts', 'README.md']
      const marks = await markReviewFiles(root, paths)
      expect([...marks.generated].sort()).toEqual(['api/client.ts', 'docs/api.md', 'yarn.lock'])
      expect(marks.categories.get('bun.lock')).toBe('implementation')
      expect(marks.categories.get('spec/fixtures/data.json')).toBe('test')
      expect(marks.categories.get('src/app.ts')).toBe('implementation')
      expect(marks.categories.get('README.md')).toBe('documentation')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('outside git the heuristics stand', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-generated-plain-'))
    try {
      const marks = await markReviewFiles(root, ['package-lock.json', 'src/a.ts'])
      expect([...marks.generated]).toEqual(['package-lock.json'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('many paths go in batches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-generated-many-'))
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root })
      const paths = Array.from({ length: 6_000 }, (_unused, index) => `src/deeply/nested/folder/name/file-${index}.generated.ts`)
      const marks = await markReviewFiles(root, paths)
      expect(marks.generated.size).toBe(6_000)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
