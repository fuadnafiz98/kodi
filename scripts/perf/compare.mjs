// Side-by-side p50/p95/max for two recorded matrix labels.
//
//   bun scripts/perf/compare.mjs <before-label> <after-label>
//
// Percentiles come from the raw samples in the JSONL records, never from a
// summary, so a run whose sample count is short is visible as a short count
// rather than as a confident number. Timeouts and missing samples stay in the
// report: dropping them is how a p95 improves without the app changing.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { RESULTS_DIRECTORY } from './cdp.mjs'

const BEFORE = process.argv[2] ?? 'ab-baseline'
const AFTER = process.argv[3] ?? 'ab-post'

function lastRecord(label, suffix = '') {
  const path = join(RESULTS_DIRECTORY, `${label}${suffix}.jsonl`)
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const rank = Math.max(0, Math.ceil(sorted.length * fraction) - 1)
  return sorted[rank]
}

function column(values) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
  return {
    n: numbers.length,
    missing: values.length - numbers.length,
    p50: percentile(numbers, 0.5),
    p95: percentile(numbers, 0.95),
    max: numbers.length === 0 ? null : Math.max(...numbers)
  }
}

// The startup probe nests its renderer marks, main timings and palette block
// one level down, so a flat key lookup silently reports every one of them as
// missing. Flatten one level and prefer the leaf name.
function flatten(sample) {
  if (sample == null) return {}
  const flat = {}
  for (const [key, value] of Object.entries(sample)) {
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      for (const [nested, nestedValue] of Object.entries(value)) flat[nested] ??= nestedValue
      continue
    }
    flat[key] ??= value
  }
  return flat
}

function collect(samples, key) {
  return samples.map((sample) => flatten(sample)[key] ?? null)
}

function folderSamples(record) {
  // The open-folder probe keeps its per-open rows under `summary.opens`.
  return record.summary?.opens ?? record.samples ?? []
}

function report(title, beforeSamples, afterSamples, keys) {
  console.log(`\n## ${title}`)
  console.log('metric,before_p50,after_p50,delta_pct,before_p95,after_p95,p95_delta_pct,before_max,after_max,before_n,after_n,before_missing,after_missing')
  for (const key of keys) {
    const before = column(collect(beforeSamples, key))
    const after = column(collect(afterSamples, key))
    if (before.n === 0 && after.n === 0) continue
    const delta = (a, b) => (a == null || b == null || a === 0 ? '' : (((b - a) / a) * 100).toFixed(1))
    console.log([
      key, before.p50, after.p50, delta(before.p50, after.p50),
      before.p95, after.p95, delta(before.p95, after.p95),
      before.max, after.max, before.n, after.n, before.missing, after.missing
    ].join(','))
  }
}

const startupKeys = [
  'navigationMs', 'firstPaintMs', 'fcpMs', 'fcpRendererMs', 'rendererLoaded',
  'reactCommitted', 'explorerCommitted', 'viewerCommitted', 'appReady',
  'windowCreated', 'restoreSettled', 'longTaskCount', 'longestTaskMs',
  'openMs', 'paletteOpenAppMs', 'typeMs', 'fileResultsMs', 'contentResultsMs',
  'workspaceRenders'
]
const folderKeys = [
  'pickerOpenMs', 'pickerRowsMs', 'headingMs', 'treeRowsMs', 'branchMs', 'publishedMs', 'liveSnapshotMs'
]

const beforeStartup = lastRecord(BEFORE)
const afterStartup = lastRecord(AFTER)
console.log(`before=${BEFORE} run=${beforeStartup.runId} after=${AFTER} run=${afterStartup.runId}`)
console.log(`machine=${beforeStartup.machine?.hostname} cacheState=${beforeStartup.cacheState}`)
report('startup', beforeStartup.samples ?? [], afterStartup.samples ?? [], startupKeys)

try {
  const beforeFolder = lastRecord(BEFORE, '-folder')
  const afterFolder = lastRecord(AFTER, '-folder')
  report('open-folder', folderSamples(beforeFolder), folderSamples(afterFolder), folderKeys)
} catch (error) {
  console.log(`\n## open-folder\nunavailable: ${error.message}`)
}

function memoryLines(label) {
  try {
    const text = readFileSync(join(RESULTS_DIRECTORY, `${label}-memory.txt`), 'utf8')
    return text.split('\n').filter((line) =>
      line.startsWith('# root_pid') || line.startsWith('summary,') || line.startsWith('retained,'))
  } catch (error) {
    return [`unavailable: ${error.message}`]
  }
}

console.log('\n## memory')
for (const label of [BEFORE, AFTER]) {
  console.log(`### ${label}`)
  for (const line of memoryLines(label)) console.log(line)
}

console.log('\n## lifecycle')
for (const label of [BEFORE, AFTER]) {
  try {
    const parsed = JSON.parse(readFileSync(join(RESULTS_DIRECTORY, `${label}-lifecycle.json`), 'utf8'))
    console.log(`${label}: pass=${parsed.pass} checks=${JSON.stringify(parsed.checks)}`)
  } catch (error) {
    console.log(`${label}: unavailable (${error.message})`)
  }
}
