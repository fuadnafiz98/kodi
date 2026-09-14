import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { markKey, median, round, stableReading, startupMarks, statistics, summaryLine } from './cdp.mjs'

const directories = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('markKey', () => {
  test('turns the emitted mark names into the keys the medians read', () => {
    expect(markKey('kodi:renderer-loaded')).toBe('rendererLoaded')
    expect(markKey('kodi:react-committed')).toBe('reactCommitted')
    expect(markKey('kodi:snapshot-ready')).toBe('snapshotReady')
    expect(markKey('kodi:explorer-committed')).toBe('explorerCommitted')
    expect(markKey('kodi:viewer-committed')).toBe('viewerCommitted')
  })

  test('leaves a name that is already a key alone', () => {
    expect(markKey('viewerCommitted')).toBe('viewerCommitted')
  })
})

describe('startupMarks', () => {
  test('renames and shifts marks onto the process clock', () => {
    expect(startupMarks({ 'kodi:react-committed': 120.4, 'kodi:viewer-committed': 163.6 }, 300))
      .toEqual({ reactCommitted: 420, viewerCommitted: 464 })
  })

  test('answers an empty object for a sample that never reported', () => {
    expect(startupMarks(undefined)).toEqual({})
    expect(startupMarks(null, 100)).toEqual({})
  })
})

describe('median', () => {
  test('ignores nulls and non-finite samples', () => {
    expect(median([5, null, 1, 3, undefined, Number.NaN])).toBe(3)
    expect(median([2, 4])).toBe(4)
    expect(median([])).toBeNull()
    expect(median([null, null])).toBeNull()
  })
})

describe('round', () => {
  test('keeps a missing measurement missing instead of turning it into zero', () => {
    expect(round(163.6)).toBe(164)
    expect(round(Number.NaN)).toBeNull()
    expect(round(null)).toBeNull()
    expect(round(undefined)).toBeNull()
  })
})

describe('statistics', () => {
  test('reports the median and the best sample, in whole milliseconds', () => {
    expect(statistics([284.4, 181.2, 174.6])).toEqual({
      samples: 3, failures: 0, p50: 181, p95: 284, median: 181, min: 175, max: 284
    })
  })

  test('ignores the samples that never measured anything', () => {
    expect(statistics([null, 12, undefined, Number.NaN])).toEqual({
      samples: 1, failures: 3, p50: 12, p95: 12, median: 12, min: 12, max: 12
    })
    expect(statistics([])).toEqual({
      samples: 0, failures: 0, p50: null, p95: null, median: null, min: null, max: null
    })
  })
})

describe('summaryLine', () => {
  test('prints one greppable line a before/after run can be diffed on', () => {
    const line = summaryLine('startup', 'after', { fcpMs: [284, 181, 174], restoreSettled: [] })

    expect(line.startsWith('PERF ')).toBe(true)
    expect(JSON.parse(line.slice('PERF '.length))).toEqual({
      probe: 'startup',
      label: 'after',
      metrics: {
        fcpMs: { samples: 3, failures: 0, p50: 181, p95: 284, median: 181, min: 174, max: 284 },
        restoreSettled: {
          samples: 0, failures: 0, p50: null, p95: null, median: null, min: null, max: null
        }
      }
    })
  })
})

describe('appendResult', () => {
  test('appends one timestamped JSON line per run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-perf-results-'))
    directories.push(directory)
    process.env.KODI_PERF_RESULTS_DIR = directory
    // The results directory is read at module load, so this needs its own copy.
    const { appendResult } = await import(`./cdp.mjs?results=${encodeURIComponent(directory)}`)
    delete process.env.KODI_PERF_RESULTS_DIR

    const file = await appendResult('after', { probe: 'startup', summary: { medians: { fcpMs: 180 } } })
    await appendResult('after', { probe: 'startup', summary: { medians: { fcpMs: 174 } } })

    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n')
    expect(file).toBe(join(directory, 'after.jsonl'))
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[1]).summary.medians.fcpMs).toBe(174)
    expect(typeof JSON.parse(lines[0]).at).toBe('string')
  })
})

describe('stableReading', () => {
  const noSleep = async () => {}

  test('waits for two consecutive readings to agree', async () => {
    const readings = [12, 34, 46, 46, 46]
    let index = 0
    const read = async () => readings[index++] ?? null

    expect(await stableReading(read, { settleMs: 1_000, sleep: noSleep })).toBe(46)
    // 12, 34, 46, 46 — it stops on the pair rather than draining the list.
    expect(index).toBe(4)
  })

  test('answers the last reading when the count never settles', async () => {
    let value = 0
    const read = async () => { value += 1; return value }

    expect(await stableReading(read, { settleMs: 12, everyMs: 1 })).toBeGreaterThan(1)
  })

  test('does not settle on a pair of nulls from a renderer that is not answering', async () => {
    const read = async () => null

    expect(await stableReading(read, { settleMs: 8, everyMs: 1 })).toBeNull()
  })
})
