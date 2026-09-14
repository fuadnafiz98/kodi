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
    expect(applyReviewFileFilter(paths, { query: '', hideTests: true, hideApi: false })).toEqual([
      'src/api/v1/verify.py',
      'src/services/jobs.py'
    ])
    expect(applyReviewFileFilter(paths, { query: '', hideTests: false, hideApi: true })).toEqual([
      'src/services/jobs.py',
      'tests/e2e/verify.py'
    ])
    expect(applyReviewFileFilter(paths, { query: '', hideTests: false, hideApi: false })).toBe(paths)
  })

  test('treats a typed query as a show-only glob or substring', () => {
    const paths = [
      'src/api/v1/verify.py',
      'src/api/v1/users.py',
      'src/services/jobs.py',
      'tests/e2e/verify.py'
    ]
    expect(applyReviewFileFilter(paths, { query: '/api/*', hideTests: false, hideApi: false })).toEqual([
      'src/api/v1/verify.py',
      'src/api/v1/users.py'
    ])
    expect(applyReviewFileFilter(paths, { query: '*.py, jobs', hideTests: true, hideApi: false })).toEqual([
      'src/api/v1/verify.py',
      'src/api/v1/users.py',
      'src/services/jobs.py'
    ])
    expect(pathMatchesFilterQuery('src/api/v1/verify.py', 'verify')).toBe(true)
    expect(pathMatchesFilterQuery('src/services/jobs.py', 'api')).toBe(false)
  })
})
