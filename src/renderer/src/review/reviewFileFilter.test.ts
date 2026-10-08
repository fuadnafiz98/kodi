import { describe, expect, test } from 'bun:test'

import {
  applyReviewFileFilter,
  isApiFilePath,
  isTestFilePath,
  pathMatchesFilterQuery
} from './reviewFileFilter'

describe('review file filters', () => {
  test('recognizes common test and API path shapes', () => {
    expect(isTestFilePath('apps/aim2-backend/tests/e2e/verify.py')).toBe(true)
    expect(isTestFilePath('src/components/Button.test.tsx')).toBe(true)
    expect(isTestFilePath('src/auth_test.py')).toBe(true)
    expect(isTestFilePath('src/api/v1/endpoints/verify_license.py')).toBe(false)
    expect(isApiFilePath('apps/license-backend/src/api/v1/endpoints/verify_license.py')).toBe(true)
    expect(isApiFilePath('src/services/jobs.py')).toBe(false)
  })

  test('hides selected groups and keeps the original array when nothing matches', () => {
    const paths = [
      'src/api/v1/verify.py',
      'src/services/jobs.py',
      'tests/e2e/verify.py'
    ]
    expect(applyReviewFileFilter(paths, { query: '', hideTests: true, hideApi: false, hideGenerated: false })).toEqual([
      'src/api/v1/verify.py',
      'src/services/jobs.py'
    ])
    expect(applyReviewFileFilter(paths, { query: '', hideTests: false, hideApi: true, hideGenerated: false })).toEqual([
      'src/services/jobs.py',
      'tests/e2e/verify.py'
    ])
    expect(applyReviewFileFilter(paths, { query: '', hideTests: false, hideApi: false, hideGenerated: false })).toBe(paths)
  })

  test('hides generated files: lockfiles, snapshots, minified bundles', () => {
    const paths = ['bun.lock', 'src/app.ts', 'src/__snapshots__/app.test.ts.snap', 'dist/app.min.js']
    expect(applyReviewFileFilter(paths, { query: '', hideTests: false, hideApi: false, hideGenerated: true })).toEqual(['src/app.ts'])
  })

  test('treats a typed query as a show-only glob or substring', () => {
    const paths = [
      'src/api/v1/verify.py',
      'src/api/v1/users.py',
      'src/services/jobs.py',
      'tests/e2e/verify.py'
    ]
    expect(applyReviewFileFilter(paths, { query: '/api/*', hideTests: false, hideApi: false, hideGenerated: false })).toEqual([
      'src/api/v1/verify.py',
      'src/api/v1/users.py'
    ])
    expect(applyReviewFileFilter(paths, { query: '*.py, jobs', hideTests: true, hideApi: false, hideGenerated: false })).toEqual([
      'src/api/v1/verify.py',
      'src/api/v1/users.py',
      'src/services/jobs.py'
    ])
    expect(pathMatchesFilterQuery('src/api/v1/verify.py', 'verify')).toBe(true)
    expect(pathMatchesFilterQuery('src/services/jobs.py', 'api')).toBe(false)
  })
})
