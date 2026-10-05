import { describe, expect, test } from 'bun:test'

import { parseFileLocation } from './fileLocation'

describe('parseFileLocation', () => {
  test('reads the places tools print after a path', () => {
    expect(parseFileLocation('src/app.ts:42')).toEqual({ path: 'src/app.ts', line: 42, column: null })
    expect(parseFileLocation('src/app.ts:42:7')).toEqual({ path: 'src/app.ts', line: 42, column: 7 })
    expect(parseFileLocation('src/app.ts:42:7:')).toEqual({ path: 'src/app.ts', line: 42, column: 7 })
    expect(parseFileLocation('src/app.ts#L42')).toEqual({ path: 'src/app.ts', line: 42, column: null })
    expect(parseFileLocation('src/app.ts#L42-L50')).toEqual({ path: 'src/app.ts', line: 42, column: null })
    expect(parseFileLocation('src/app.ts(42,7)')).toEqual({ path: 'src/app.ts', line: 42, column: 7 })
    expect(parseFileLocation('app.ts:12 ')).toEqual({ path: 'app.ts', line: 12, column: null })
  })

  test('a bare line is a line in the open file', () => {
    expect(parseFileLocation(':42')).toEqual({ path: '', line: 42, column: null })
  })

  test('anything else is only a path', () => {
    expect(parseFileLocation('src/app.ts')).toEqual({ path: 'src/app.ts', line: null, column: null })
    expect(parseFileLocation('src/app.ts:')).toEqual({ path: 'src/app.ts', line: null, column: null })
    expect(parseFileLocation('src/app.ts:0')).toEqual({ path: 'src/app.ts:0', line: null, column: null })
    expect(parseFileLocation('v2')).toEqual({ path: 'v2', line: null, column: null })
  })
})
