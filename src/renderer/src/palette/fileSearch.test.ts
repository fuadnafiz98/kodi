import { describe, expect, it } from 'bun:test'

import { createFileSearchIndex, isNoisySearchPath, rankFilePaths } from './fileSearch'

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
