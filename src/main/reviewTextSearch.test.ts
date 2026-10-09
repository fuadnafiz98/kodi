import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isSearchableQuery, searchReviewText } from './reviewTextSearch.js'

const { rgPath } = createRequire(import.meta.url)('@vscode/ripgrep') as { rgPath: string }
let root = ''
let head = ''

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kodi-review-text-'))
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' })
  git('init', '-q')
  writeFileSync(join(root, 'a.ts'), 'one\nNeedle here\nthree\n')
  writeFileSync(join(root, 'b:c.ts'), 'needle and needle\n')
  git('add', '-A')
  git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'base')
  head = git('rev-parse', 'HEAD').trim()
  writeFileSync(join(root, 'a.ts'), 'one\nchanged\nneedle now\n')
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

test('searches the working tree with ripgrep, smart-cased by the caller', async () => {
  const reply = await searchReviewText({ root, revision: null, paths: ['a.ts', 'b:c.ts', 'gone.ts'], query: 'needle', caseSensitive: false }, { ripgrep: rgPath })
  expect(reply.lines.sort((left, right) => left.path.localeCompare(right.path))).toEqual([
    { path: 'a.ts', line: 3, text: 'needle now' },
    { path: 'b:c.ts', line: 1, text: 'needle and needle' }
  ])
})

test('searches the review’s revision with git grep', async () => {
  const reply = await searchReviewText({ root, revision: head, paths: ['a.ts', 'b:c.ts'], query: 'Needle', caseSensitive: true }, { ripgrep: rgPath })
  expect(reply.lines).toEqual([{ path: 'a.ts', line: 2, text: 'Needle here' }])
})

test('refuses queries it cannot pass safely', () => {
  expect(isSearchableQuery('')).toBe(false)
  expect(isSearchableQuery('a\nb')).toBe(false)
  expect(isSearchableQuery('-e')).toBe(true)
})
