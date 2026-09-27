import { describe, expect, it } from 'bun:test'

import {
  createFileSearchIndex,
  fileSearchEntriesScored,
  isNoisySearchPath,
  priorityPathSet,
  rankFilePaths
} from './fileSearch'

function paths(index: ReturnType<typeof rankFilePaths>): string[] {
  return index.map((result) => result.path)
}

describe('createFileSearchIndex', () => {
  it('derives a directory entry for every ancestor exactly once', () => {
    const index = createFileSearchIndex([
      'src/components/Button.tsx',
      'src/components/Panel.tsx',
      'README.md'
    ])

    expect(index.filter((entry) => entry.kind === 'dir').map((entry) => entry.path)).toEqual([
      'src',
      'src/components'
    ])
    expect(index.filter((entry) => entry.kind === 'file')).toHaveLength(3)
  })

  it('returns the same index for the same path array', () => {
    const input = ['src/a.ts', 'src/b.ts']

    expect(createFileSearchIndex(input)).toBe(createFileSearchIndex(input))
    expect(createFileSearchIndex([...input])).not.toBe(createFileSearchIndex(input))
  })
})

describe('rankFilePaths', () => {
  it('prioritizes filename matches and handles case-insensitive queries', () => {
    const index = createFileSearchIndex([
      'docs/application-notes.md',
      'src/App.tsx',
      'src/components/AppPanel.tsx',
      'src/components/Button.tsx'
    ])

    expect(paths(rankFilePaths(index, 'APP'))).toEqual([
      'src/App.tsx',
      'src/components/AppPanel.tsx',
      'docs/application-notes.md'
    ])
  })

  it('returns a bounded set for broad searches', () => {
    const searchPaths = Array.from({ length: 1_000 }, (_, index) => `src/file-${index}.ts`)

    const results = rankFilePaths(createFileSearchIndex(searchPaths), 'file', { limit: 25 })

    expect(results).toHaveLength(25)
    expect(results[0]?.path).toBe('src/file-0.ts')
  })

  it('ranks directories alongside files and labels them', () => {
    const index = createFileSearchIndex([
      'src/components/Button.tsx',
      'docs/components.md'
    ])

    const results = rankFilePaths(index, 'components')

    expect(results).toContainEqual({ path: 'src/components', kind: 'dir' })
    expect(results).toContainEqual({ path: 'docs/components.md', kind: 'file' })
  })

  it('ranks review files ahead of other matches', () => {
    const index = createFileSearchIndex([
      'apps/data-platform/src/apps/files/service.py',
      'apps/data-platform/src/apps/storage_backends/service.py',
      'apps/aim2-backend/src/services/jobs.py',
      'apps/aim2-backend/src/services/analytics.py',
      'apps/web/src/services/test_heatmap_service.py'
    ])
    const priorityPaths = new Set(['apps/web/src/services/test_heatmap_service.py'])

    expect(rankFilePaths(index, 'service', { priorityPaths })[0]?.path).toBe(
      'apps/web/src/services/test_heatmap_service.py'
    )
    expect(rankFilePaths(index, 'service')[0]?.path).toBe(
      'apps/data-platform/src/apps/files/service.py'
    )
  })

  it('filters 20k paths without waiting on git status', () => {
    const searchPaths = Array.from({ length: 20_000 }, (_, index) => `src/pkg-${index % 40}/file-${index}.ts`)
    const index = createFileSearchIndex(searchPaths)
    const started = performance.now()
    const results = rankFilePaths(index, 'file-199', { limit: 32 })
    expect(performance.now() - started).toBeLessThan(80)
    expect(results[0]?.path).toBe('src/pkg-39/file-199.ts')
  })

  it('keeps review files first when the result set is bounded', () => {
    const priorityPaths = new Set(['src/z-review-file.ts'])
    const searchPaths = [
      'src/z-review-file.ts',
      ...Array.from({ length: 40 }, (_, index) => `src/file-${index}.ts`)
    ]

    expect(paths(rankFilePaths(createFileSearchIndex(searchPaths), 'file', {
      limit: 8,
      priorityPaths
    }))).toEqual([
      'src/z-review-file.ts',
      'src/file-0.ts',
      'src/file-1.ts',
      'src/file-2.ts',
      'src/file-3.ts',
      'src/file-4.ts',
      'src/file-5.ts',
      'src/file-6.ts'
    ])
  })

  it('omits virtualenvs and bytecode from the searchable index', () => {
    expect(isNoisySearchPath('.venv/lib/python3.12/site-packages/foo.py')).toBe(true)
    expect(isNoisySearchPath('apps/api/__pycache__/verify.cpython-312.pyc')).toBe(true)
    expect(isNoisySearchPath('src/verify.py')).toBe(false)

    const index = createFileSearchIndex([
      'apps/license-backend/src/api/v1/endpoints/verify_license.py',
      '.venv/lib/python3.12/site-packages/verify/api.py',
      'apps/aim2-backend/__pycache__/verify.cpython-312.pyc'
    ])

    expect(paths(rankFilePaths(index, 'verify', { limit: 10 }))).toEqual([
      'apps/license-backend/src/api/v1/endpoints/verify_license.py'
    ])
  })
})

describe('rankFilePaths result identity', () => {
  const index = createFileSearchIndex(['src/app.ts', 'src/other.ts', 'docs/guide.md'])

  it('hands back the same array for the same inputs', () => {
    const priorityPaths = new Set(['src/app.ts'])

    expect(rankFilePaths(index, 'app', { limit: 8, priorityPaths }))
      .toBe(rankFilePaths(index, 'app', { limit: 8, priorityPaths }))
  })

  it('hands back the same array when another character changes nothing', () => {
    const first = rankFilePaths(index, 'app', { limit: 8 })

    expect(rankFilePaths(index, 'app.', { limit: 8 })).toBe(first)
  })

  it('hands back a new array when the rows change', () => {
    const first = rankFilePaths(index, 'app', { limit: 8 })

    expect(rankFilePaths(index, 'guide', { limit: 8 })).not.toBe(first)
  })
})

describe('rankFilePaths with an empty query', () => {
  const index = createFileSearchIndex([
    'README.md',
    'docs/guide.md',
    'src/app.ts',
    'src/deep/nested/leaf.ts',
    'src/util.ts'
  ])

  it('leads with recent files, then changed files, then top-level directories', () => {
    const results = paths(rankFilePaths(index, '', {
      limit: 40,
      priorityPaths: new Set(['src/util.ts']),
      recentPaths: ['src/deep/nested/leaf.ts', 'src/app.ts']
    }))

    expect(results.slice(0, 5)).toEqual([
      'src/deep/nested/leaf.ts',
      'src/app.ts',
      'src/util.ts',
      'docs',
      'src'
    ])
    expect(results).toContain('README.md')
  })

  it('offers files and folders even with no history and no changes', () => {
    const results = rankFilePaths(index, '', { limit: 40 })

    expect(results.length).toBeGreaterThanOrEqual(7)
    expect(results[0]).toEqual({ path: 'docs', kind: 'dir' })
    expect(results.some((result) => result.kind === 'file')).toBe(true)
  })

  it('honours the cap', () => {
    const many = createFileSearchIndex(
      Array.from({ length: 200 }, (_, order) => `src/file-${order}.ts`)
    )

    expect(rankFilePaths(many, '', { limit: 40 })).toHaveLength(40)
  })

  it('ignores a recent path that is no longer in the repository', () => {
    const results = paths(rankFilePaths(index, '', {
      limit: 40,
      recentPaths: ['src/deleted.ts', 'src/app.ts']
    }))

    expect(results[0]).toBe('src/app.ts')
    expect(results).not.toContain('src/deleted.ts')
  })
})

// Deterministic, so a failure reproduces. The shape is a monorepo's: packages,
// nested feature folders, and file names that share most of their letters.
function monorepoPaths(count: number, seed = 7): string[] {
  const words = ['components', 'service', 'utils', 'hooks', 'models', 'views', 'api', 'core',
    'shared', 'feature', 'store', 'reducers', 'tests', 'fixtures', 'handlers', 'routes']
  const suffixes = ['Button', 'Panel', 'Service', 'Store', 'Hook', 'Model', 'View']
  const extensions = ['ts', 'tsx', 'py', 'md']
  let state = seed
  const random = (): number => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff
    return state / 0x7fffffff
  }
  const pick = <Value,>(values: readonly Value[]): Value => values[Math.floor(random() * values.length)]!
  const generated: string[] = []
  for (let index = 0; index < count; index += 1) {
    const parts = [`packages/pkg-${index % 200}`]
    const depth = 2 + Math.floor(random() * 4)
    for (let level = 0; level < depth; level += 1) {
      parts.push(level === 0 ? pick(words) : `${pick(words)}-${Math.floor(random() * 20)}`)
    }
    parts.push(`${pick(words)}${pick(suffixes)}${index}.${pick(extensions)}`)
    generated.push(parts.join('/'))
  }
  return generated
}

describe('rankFilePaths narrowing', () => {
  it('ranks an extended query from the previous match set, not the whole index', () => {
    const index = createFileSearchIndex(monorepoPaths(100_000))
    const scoredPerKeystroke: number[] = []
    for (const query of ['h', 'ha', 'han', 'hand', 'handl', 'handle', 'handler', 'handlers/']) {
      const before = fileSearchEntriesScored()
      rankFilePaths(index, query, { limit: 32 })
      scoredPerKeystroke.push(fileSearchEntriesScored() - before)
    }

    // The first character has nothing to narrow from; every later one does.
    expect(scoredPerKeystroke[0]).toBe(index.length)
    for (const [keystroke, scored] of scoredPerKeystroke.entries()) {
      if (keystroke === 0) continue
      expect(scored).toBeLessThanOrEqual(scoredPerKeystroke[keystroke - 1]!)
    }
    // By the fourth character the keystroke scores a fraction of the index.
    expect(scoredPerKeystroke[3]!).toBeLessThan(index.length / 2)
  })

  it('re-ranks a changed review set without scanning past the current matches', () => {
    const paths = monorepoPaths(100_000)
    const index = createFileSearchIndex(paths)
    rankFilePaths(index, 'store', { limit: 32 })
    const matched = fileSearchEntriesScored()
    rankFilePaths(index, 'storep', { limit: 32 })
    const before = fileSearchEntriesScored()

    rankFilePaths(index, 'storep', { limit: 32, priorityPaths: new Set([paths[5]!]) })

    expect(fileSearchEntriesScored() - before).toBeLessThan(matched)
  })

  it('returns exactly what a full scan returns, for random typing and backspacing', () => {
    const paths = monorepoPaths(10_000, 11)
    const narrowed = createFileSearchIndex(paths)
    const priorityPaths = new Set(paths.filter((_, order) => order % 499 === 0))
    const alphabet = 'abcdefghiklmnoprstuvy-/._ AS0123456789'
    let state = 3
    const random = (): number => {
      state = (state * 1_103_515_245 + 12_345) & 0x7fffffff
      return state / 0x7fffffff
    }
    const sessions: string[][] = []
    for (let session = 0; session < 25; session += 1) {
      const typed: string[] = []
      let query = ''
      for (let keystroke = 0; keystroke < 12; keystroke += 1) {
        if (query.length > 0 && random() < 0.2) query = query.slice(0, -1)
        else if (random() < 0.5) {
          // Mostly letters from a real path, so the queries keep matching things.
          const source = paths[Math.floor(random() * paths.length)]!
          query += source[Math.floor(random() * source.length)]!
        } else query += alphabet[Math.floor(random() * alphabet.length)]!
        typed.push(query)
      }
      sessions.push(typed)
    }

    // Ranking another index in between leaves nothing to narrow from, so every
    // reference ranking is a scan of the whole index.
    const full = createFileSearchIndex([...paths])
    const elsewhere = createFileSearchIndex(['elsewhere.ts'])
    const expected = sessions.map((typed) => typed.map((query) => {
      rankFilePaths(elsewhere, 'e')
      const before = fileSearchEntriesScored()
      const results = [...rankFilePaths(full, query, { limit: 32, priorityPaths })]
      const scored = fileSearchEntriesScored() - before
      if (query.trim() !== '' && scored !== full.length) throw new Error('reference ranking narrowed')
      return results
    }))
    const actual = sessions.map((typed) => typed.map((query) =>
      [...rankFilePaths(narrowed, query, { limit: 32, priorityPaths })]))

    expect(actual).toEqual(expected)
    // The sessions exercise real narrowing, not a run of empty result lists.
    expect(expected.flat().filter((results) => results.length > 0).length).toBeGreaterThan(100)
  })

  it('settles a keystroke on 100k paths well inside a frame budget', () => {
    const index = createFileSearchIndex(monorepoPaths(100_000))
    for (const query of ['s', 'se', 'ser', 'serv']) rankFilePaths(index, query, { limit: 32 })
    const started = performance.now()
    rankFilePaths(index, 'servi', { limit: 32 })
    expect(performance.now() - started).toBeLessThan(30)
  })
})

describe('priorityPathSet', () => {
  it('keeps one instance while the contents are unchanged', () => {
    const first = priorityPathSet(['src/a.ts', 'src/b.ts'])

    expect(priorityPathSet(['src/b.ts', 'src/a.ts'])).toBe(first)
    expect(priorityPathSet(['src/a.ts', 'src/c.ts'])).not.toBe(first)
    expect(priorityPathSet([])).toBeUndefined()
  })
})
