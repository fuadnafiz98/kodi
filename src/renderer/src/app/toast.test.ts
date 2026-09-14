import { describe, expect, test } from 'bun:test'

import { toastEvictionCount } from './toast'

describe('toastEvictionCount', () => {
  test('keeps the stack below the cap once the next toast lands', () => {
    expect(toastEvictionCount(0, 3)).toBe(0)
    expect(toastEvictionCount(2, 3)).toBe(0)
    expect(toastEvictionCount(3, 3)).toBe(1)
    expect(toastEvictionCount(5, 3)).toBe(3)
  })

  test('never asks for a negative eviction', () => {
    expect(toastEvictionCount(0, 1)).toBe(0)
  })
})
