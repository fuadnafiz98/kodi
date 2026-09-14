import { describe, expect, test } from 'bun:test'

import {
  fileNameFromPath,
  isCommandOnlyQuery,
  paletteFilterQuery,
  pathCompletion,
  pullRequestNumber,
  searchQueryForRepository
} from './paletteQuery'

describe('isCommandOnlyQuery', () => {
  test('only a leading > switches to commands', () => {
    expect(isCommandOnlyQuery('>')).toBe(true)
    expect(isCommandOnlyQuery('  > term')).toBe(true)
    expect(isCommandOnlyQuery('a > b')).toBe(false)
    expect(isCommandOnlyQuery('')).toBe(false)
  })
})

describe('paletteFilterQuery', () => {
  test('strips the > marker and trims what follows', () => {
    expect(paletteFilterQuery('> settings ')).toBe('settings')
    expect(paletteFilterQuery('>')).toBe('')
  })

  test('leaves an ordinary query untouched, whitespace included', () => {
    expect(paletteFilterQuery(' src/app ')).toBe(' src/app ')
  })
})

describe('searchQueryForRepository', () => {
  test('a commands-only query searches nothing', () => {
    expect(searchQueryForRepository('> term')).toBe('')
    expect(searchQueryForRepository('src/app')).toBe('src/app')
  })
})

describe('pathCompletion', () => {
  test('completes a genuine case-insensitive prefix', () => {
    expect(pathCompletion('src/ap', 'src/app.ts')).toBe('p.ts')
    expect(pathCompletion('SRC/ap', 'src/app.ts')).toBe('p.ts')
  })

  test('offers nothing without a prefix match or a remainder', () => {
    expect(pathCompletion('', 'src/app.ts')).toBeNull()
    expect(pathCompletion('src/app.ts', 'src/app.ts')).toBeNull()
    expect(pathCompletion('app', 'src/app.ts')).toBeNull()
    expect(pathCompletion('src/ap', undefined)).toBeNull()
  })
})

describe('pullRequestNumber', () => {
  test('reads a number straight through and digs one out of a URL', () => {
    expect(pullRequestNumber(123)).toBe(123)
    expect(pullRequestNumber('https://github.com/acme/app/pull/717')).toBe(717)
  })
})

describe('fileNameFromPath', () => {
  test('is the last segment, or the whole path at the root', () => {
    expect(fileNameFromPath('src/renderer/App.tsx')).toBe('App.tsx')
    expect(fileNameFromPath('README.md')).toBe('README.md')
  })
})
