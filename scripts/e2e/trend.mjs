// Prints the last runs of an e2e suite side by side, one row per step, so a
// regression shows up as a column that jumped.
//
//   bun scripts/e2e/trend.mjs large-worktree        # last 5 runs
//   bun scripts/e2e/trend.mjs large-worktree 10
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [suite, countArg] = process.argv.slice(2)
if (suite == null) {
  console.error('usage: bun scripts/e2e/trend.mjs <suite> [runs]')
  process.exit(2)
}
const file = join(fileURLToPath(new URL('.', import.meta.url)), 'results', `${suite}.jsonl`)
const runs = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  .slice(-Number(countArg ?? 5))

// Stall for timed steps, the measured value for growth and memory records.
const cell = (result) => {
  if (result == null) return '—'
  const mark = result.ok ? '' : ' ✗'
  if (result.maxRendererStallMs != null) return `${result.maxRendererStallMs}ms${mark}`
  if (result.grew != null) return `+${result.grew}${mark}`
  if (result.jsHeapUsedMb != null) return `${result.jsHeapUsedMb}MB/${result.rssMb}MB${mark}`
  return result.ok ? 'ok' : 'fail'
}

const steps = [...new Set(runs.flatMap((run) => run.results.map((result) => result.step)))]
const header = ['step', ...runs.map((run) => `${run.commit}${run.build === 'installed' ? ' (installed)' : ''} ${run.at.slice(5, 16)}`)]
const rows = steps.map((step) => [step, ...runs.map((run) => cell(run.results.find((result) => result.step === step)))])
const widths = header.map((_unused, column) => Math.max(...[header, ...rows].map((row) => String(row[column]).length)))
for (const row of [header, ...rows]) {
  console.log(row.map((value, column) => String(value).padEnd(widths[column])).join('  '))
}
