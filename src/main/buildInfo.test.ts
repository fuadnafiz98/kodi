import { describe, expect, it } from 'bun:test'

import { BUILD_TIME, formatBuildTime } from './buildInfo.js'

describe('formatBuildTime', () => {
  it('renders a UTC stamp in the reader\'s own timezone', () => {
    const stamp = '2026-09-14T22:19:00.000Z'
    const local = new Date(stamp)
    const pad = (value: number): string => String(value).padStart(2, '0')
    const expected = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`
      + ` ${pad(local.getHours())}:${pad(local.getMinutes())}`
    expect(formatBuildTime(stamp)).toBe(expected)
  })

  it('reports nothing rather than a guess when the bundle carries no stamp', () => {
    expect(formatBuildTime(null)).toBeNull()
    expect(formatBuildTime('')).toBeNull()
  })

  it('reports nothing for a stamp that is not a date', () => {
    expect(formatBuildTime('built on a Tuesday')).toBeNull()
  })

  it('leaves BUILD_TIME null in an unbundled run instead of throwing', () => {
    // `__BUILD_TIME__` is substituted only by the bundler, so a test run reaches
    // the `typeof` guard rather than a ReferenceError.
    expect(BUILD_TIME).toBeNull()
  })
})
