import { afterEach, describe, expect, it } from 'bun:test'

import {
  buildPerformanceChart,
  clearMemorySamples,
  findNearestSampleIndex,
  interpolateChartY,
  formatSpan,
  formatTrendPerHour,
  getMemorySamples,
  memoryTrendPerHour,
  recordMemorySample,
  type MemorySample
} from './performanceHistory'

function series(count: number, startMegabytes: number, stepMegabytes: number, stepMs = 3_000): MemorySample[] {
  return Array.from({ length: count }, (_unused, index) => ({
    atMs: index * stepMs,
    workingSetMegabytes: startMegabytes + index * stepMegabytes,
    rendererPrivateMegabytes: startMegabytes / 2
  }))
}

afterEach(() => clearMemorySamples())

describe('memoryTrendPerHour', () => {
  it('waits out the startup ramp before reporting a slope', () => {
    expect(memoryTrendPerHour(series(4, 500, 1))).toBeNull()
    expect(memoryTrendPerHour(series(40, 500, 1))).toBeNull()
  })

  it('reports megabytes per hour for a rising series', () => {
    // 1 MB every 3s is 1200 MB/h.
    expect(memoryTrendPerHour(series(80, 500, 1))).toBeCloseTo(1_200, 5)
  })

  it('reports zero for a flat series', () => {
    expect(memoryTrendPerHour(series(80, 500, 0))).toBeCloseTo(0, 5)
  })

  it('reads only recent history, so an old ramp stops dominating', () => {
    const ramp = series(120, 300, 5)
    const settledStart = ramp[ramp.length - 1]?.atMs ?? 0
    const settled = Array.from({ length: 500 }, (_unused, index) => ({
      atMs: settledStart + (index + 1) * 3_000,
      workingSetMegabytes: 900,
      rendererPrivateMegabytes: 400
    }))
    expect(memoryTrendPerHour([...ramp, ...settled])).toBeCloseTo(0, 5)
  })

  it('does not report a leak for one transient final spike', () => {
    const stable = series(80, 500, 0)
    stable[stable.length - 1] = {
      ...stable[stable.length - 1]!,
      workingSetMegabytes: 900
    }
    expect(memoryTrendPerHour(stable)).toBeCloseTo(0, 5)
  })
})

describe('formatTrendPerHour', () => {
  it('labels the unmeasured, flat, rising and falling cases', () => {
    expect(formatTrendPerHour(null)).toBe('Measuring…')
    expect(formatTrendPerHour(0.2)).toBe('Flat')
    expect(formatTrendPerHour(18.6)).toBe('+19 MB/h')
    expect(formatTrendPerHour(-42)).toBe('−42 MB/h')
  })
})

describe('formatSpan', () => {
  it('formats sub-minute, minute and hour spans', () => {
    expect(formatSpan(20_000)).toBe('under a minute')
    expect(formatSpan(9 * 60_000)).toBe('9 min')
    expect(formatSpan(120 * 60_000)).toBe('2 h')
    expect(formatSpan(95 * 60_000)).toBe('1 h 35 min')
  })
})

describe('buildPerformanceChart', () => {
  it('uses a padded memory domain and preserves elapsed sample time', () => {
    const geometry = buildPerformanceChart(series(3, 500, 10), 'memory', 400, 160)
    expect(geometry?.domainLow).toBe(200)
    expect(geometry?.domainHigh).toBe(575)
    expect(geometry?.primary.points[0]?.x).toBe(38)
    expect(geometry?.primary.points[1]?.x).toBe(215)
    expect(geometry?.primary.points[2]?.x).toBe(392)
  })

  it('starts CPU charts at zero and includes GPU values', () => {
    const history = series(2, 500, 0).map((sample, index) => ({
      ...sample,
      cpuPercent: 16 + index * 4,
      gpuProcessCpuPercent: 3 + index
    }))
    const geometry = buildPerformanceChart(history, 'cpu', 400, 160)
    expect(geometry?.domainLow).toBe(0)
    expect(geometry?.domainHigh).toBe(30)
    expect(geometry?.secondary.points).toHaveLength(2)
  })
})

describe('findNearestSampleIndex', () => {
  it('finds the closest timestamp and resolves ties to the earlier sample', () => {
    const history = series(3, 500, 1)
    expect(findNearestSampleIndex(history, -1)).toBe(0)
    expect(findNearestSampleIndex(history, 1_500)).toBe(0)
    expect(findNearestSampleIndex(history, 4_900)).toBe(2)
    expect(findNearestSampleIndex(history, 99_000)).toBe(2)
  })

  it('returns -1 for empty history', () => {
    expect(findNearestSampleIndex([], Date.now())).toBe(-1)
  })
})

describe('interpolateChartY', () => {
  it('returns null for an empty series and clamps to the ends', () => {
    expect(interpolateChartY([], 10)).toBeNull()
    expect(interpolateChartY([{ x: 4, y: 8 }, { x: 12, y: 20 }], 0)).toBe(8)
    expect(interpolateChartY([{ x: 4, y: 8 }, { x: 12, y: 20 }], 40)).toBe(20)
  })

  it('lerps between neighboring points', () => {
    expect(interpolateChartY([{ x: 0, y: 10 }, { x: 10, y: 20 }], 5)).toBe(15)
  })
})

describe('recordMemorySample', () => {
  it('keeps a rolling recent history', () => {
    for (const sample of series(1_300, 100, 1)) recordMemorySample(sample)
    const history = getMemorySamples()
    expect(history.length).toBe(401)
    expect(history[0]?.workingSetMegabytes).toBe(999)
    expect(history[history.length - 1]?.workingSetMegabytes).toBe(1_399)
  })

  it('starts a new series after a sampling gap', () => {
    recordMemorySample(series(1, 500, 0)[0]!)
    recordMemorySample({
      atMs: 31_000,
      workingSetMegabytes: 510,
      rendererPrivateMegabytes: 250
    })
    expect(getMemorySamples()).toHaveLength(1)
    expect(getMemorySamples()[0]?.workingSetMegabytes).toBe(510)
  })

  it('ignores duplicate and out-of-order samples without replacing the history', () => {
    const history = recordMemorySample({
      atMs: 10,
      workingSetMegabytes: 500,
      rendererPrivateMegabytes: 250
    })

    expect(recordMemorySample({
      atMs: 10,
      workingSetMegabytes: 900,
      rendererPrivateMegabytes: 450
    })).toBe(history)
    expect(recordMemorySample({
      atMs: 9,
      workingSetMegabytes: 800,
      rendererPrivateMegabytes: 400
    })).toBe(history)
    expect(getMemorySamples()).toHaveLength(1)
    expect(getMemorySamples()[0]?.workingSetMegabytes).toBe(500)
  })
})
