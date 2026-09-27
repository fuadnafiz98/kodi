// Runs every *.e2e.mjs suite in this folder one after another (they share the
// DevTools port) and exits non-zero if any failed. Needs `bun run build` first.
//
//   bun run e2e                 # all suites
//   bun run e2e large-worktree  # only suites whose name contains the argument
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('.', import.meta.url))
const filter = process.argv[2] ?? ''
const suites = readdirSync(directory)
  .filter((name) => name.endsWith('.e2e.mjs') && name.includes(filter))
  .sort()

const failed = []
for (const suite of suites) {
  console.log(`\n── ${suite}`)
  const child = Bun.spawn(['bun', join(directory, suite)], { stdout: 'inherit', stderr: 'inherit' })
  if (await child.exited !== 0) failed.push(suite)
}
console.log(`\n${suites.length - failed.length}/${suites.length} suites passed${failed.length > 0 ? ` — failed: ${failed.join(', ')}` : ''}`)
process.exit(failed.length > 0 ? 1 : 0)
