import { describe, expect, test } from 'bun:test'

import { rubberband, withResistance } from './rubberband'

describe('rubberband', () => {
  test('gives back less than it is asked for, and less the further it goes', () => {
    const small = rubberband(20, 1_200)
    const large = rubberband(200, 1_200)
    expect(small).toBeLessThan(20)
    expect(large).toBeLessThan(200)
    expect(large / 200).toBeLessThan(small / 20)
  })

  test('is monotonic and signed', () => {
    expect(rubberband(0, 1_200)).toBe(0)
    expect(rubberband(-40, 1_200)).toBeLessThan(0)
    expect(rubberband(40, 1_200)).toBeGreaterThan(rubberband(20, 1_200))
  })

  test('a zero dimension cannot divide by zero', () => {
    expect(rubberband(50, 0)).toBe(0)
  })
})

describe('withResistance', () => {
  test('passes values inside the bounds through untouched', () => {
    expect(withResistance(300, 200, 520, 1_200)).toBe(300)
    expect(withResistance(200, 200, 520, 1_200)).toBe(200)
    expect(withResistance(520, 200, 520, 1_200)).toBe(520)
  })

  test('overshoots past a bound but never by the full amount', () => {
    const stretched = withResistance(620, 200, 520, 1_200)
    expect(stretched).toBeGreaterThan(520)
    expect(stretched).toBeLessThan(620)
  })

  test('resists below the minimum symmetrically', () => {
    const squeezed = withResistance(100, 200, 520, 1_200)
    expect(squeezed).toBeLessThan(200)
    expect(squeezed).toBeGreaterThan(100)
  })
})
