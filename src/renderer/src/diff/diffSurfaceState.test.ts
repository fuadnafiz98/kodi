import { describe, expect, test } from 'bun:test'

import type { FileComparison } from '../../../shared/contracts'
import { diffSurfaceState } from './diffSurfaceState'

function comparison(overrides: Partial<FileComparison> = {}): FileComparison {
  return {
    path: 'src/app.ts',
    status: 'modified',
    mode: 'diff',
    binary: false,
    oversized: false,
    oldFile: { cacheKey: 'a' },
    newFile: { cacheKey: 'b' },
    ...overrides
  } as unknown as FileComparison
}

describe('diffSurfaceState', () => {
  test('loading wins over everything', () => {
    expect(diffSurfaceState(comparison(), true)).toBe('loading')
    expect(diffSurfaceState(null, true)).toBe('loading')
  })

  test('no comparison means nothing is selected', () => {
    expect(diffSurfaceState(null, false)).toBe('no-selection')
  })

  test('an image preview beats the binary flag', () => {
    const image = { old: null, new: { byteLength: 4, dataUrl: 'data:image/png;base64,AAAA' } }
    expect(diffSurfaceState(comparison({ binary: true, image } as Partial<FileComparison>), false)).toBe('image')
  })

  test('binary, oversized and contentless files each get their own screen', () => {
    expect(diffSurfaceState(comparison({ binary: true }), false)).toBe('binary')
    expect(diffSurfaceState(comparison({ oversized: true }), false)).toBe('oversized')
    expect(diffSurfaceState(comparison({ oldFile: null, newFile: null }), false)).toBe('no-contents')
  })

  test('a renderable comparison is code', () => {
    expect(diffSurfaceState(comparison(), false)).toBe('code')
    expect(diffSurfaceState(comparison({ oldFile: null }), false)).toBe('code')
  })
})
