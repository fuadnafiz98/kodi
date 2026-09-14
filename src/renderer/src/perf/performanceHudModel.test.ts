import { describe, expect, test } from 'bun:test'

import type { PerformanceMetrics } from '../../../shared/contracts'
import {
  buildLabel,
  formatStartupTiming,
  performanceDescription,
  processPeakMegabytes,
  samplingStatusLabel,
  workingSetSummary
} from './performanceHudModel'

function metrics(overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    cpuPercent: 1.2,
    gpuProcessCpuPercent: 0.4,
    workingSetMegabytes: 512,
    rendererPrivateMegabytes: 128,
    lastRendererTermination: null,
    processCount: 4,
    production: true,
    sampledAt: 0,
    detail: null,
    ...overrides
  }
}

describe('performanceDescription', () => {
  test('names the build, the process count and the working set', () => {
    const text = performanceDescription(metrics(), false)
    expect(text).toContain('Production build.')
    expect(text).toContain('4 processes.')
    expect(text).not.toContain('High memory warning')
  })

  test('appends the warning only when memory is high', () => {
    expect(performanceDescription(metrics(), true)).toContain('High memory warning.')
  })

  test('says what it is doing before the first sample', () => {
    expect(performanceDescription(null, false)).toBe('Collecting application performance metrics.')
  })
})

describe('buildLabel', () => {
  test('production, development, or not yet known', () => {
    expect(buildLabel(metrics())).toBe('Production build')
    expect(buildLabel(metrics({ production: false }))).toBe('Development build')
    expect(buildLabel(null)).toBe('Detecting build')
  })
})

describe('samplingStatusLabel', () => {
  test('a failed sample is Stale when a reading survives and Unavailable when none does', () => {
    expect(samplingStatusLabel('live', metrics())).toBe('Live')
    expect(samplingStatusLabel('sampling', null)).toBe('Sampling')
    expect(samplingStatusLabel('unavailable', metrics())).toBe('Stale')
    expect(samplingStatusLabel('unavailable', null)).toBe('Unavailable')
  })
})

describe('workingSetSummary', () => {
  test('flags a high working set beside the process count', () => {
    expect(workingSetSummary(metrics(), false)).toBe('4 processes')
    expect(workingSetSummary(metrics(), true)).toBe('High · 4 processes')
    expect(workingSetSummary(null, false)).toBe('Sampling…')
  })
})

describe('processPeakMegabytes', () => {
  test('is the widest process, never below 1', () => {
    expect(processPeakMegabytes(null)).toBe(1)
    expect(processPeakMegabytes({
      memoryByProcessType: [{ type: 'Browser', megabytes: 40 }, { type: 'GPU', megabytes: 120 }]
    } as unknown as PerformanceMetrics['detail'])).toBe(120)
  })
})

describe('formatStartupTiming', () => {
  test('rounds to whole milliseconds and dashes out a missing mark', () => {
    expect(formatStartupTiming(12.4)).toBe('12 ms')
    expect(formatStartupTiming(null)).toBe('—')
    expect(formatStartupTiming(undefined)).toBe('—')
  })
})
