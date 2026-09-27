// The first launch after an install must end on the folder's live snapshot.
// Main opens the folder while the window is still loading and answers with the
// skeleton listing when git is slower than a short deadline; the live snapshot
// then went out as an event before the page was listening, and the renderer
// never asked again. On the first launch after every build, with the changed
// file clicked as soon as it showed, it stayed on the
// skeleton for good: "Detached HEAD", a handful of files, nothing clickable.
//
// That timing only shows on a launch right after the app's files were written,
// so this suite rebuilds the app under test first (KODI_E2E_REBUILD=0 skips it,
// e.g. when `bun run build` just ran). The old build failed its first launch
// here every time.
//
//   bun run e2e cold-start
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createRepository, git, launchApp, REPO_ROOT, removeLater, runSuite, writeTree } from './harness.mjs'

const LAUNCHES = 3
const LINES = 4_000

await runSuite('cold-start', async (suite, cleanup) => {
  if (process.env.KODI_E2E_REBUILD !== '0') {
    const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: process.env.KODI_E2E_APP_DIR ?? REPO_ROOT, stdout: 'ignore', stderr: 'pipe' })
    if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString().slice(-400)}`)
  }
  const fixture = await createRepository('cold')
  cleanup(removeLater(fixture))
  // Deeper than the skeleton listing reaches, so skeleton and live differ.
  const total = await writeTree(fixture, 'lib', { top: 40, sub: 10, files: 5 }) + 4
  const source = (edited) => Array.from({ length: LINES }, (_unused, line) =>
    edited && line % 4 === 0
      ? `export const value${line} = computeSomething(${line}, 'edited') // changed line ${line}\n`
      : `export const value${line} = computeSomething(${line}, 'original')\n`).join('')
  await writeFile(join(fixture, 'src/big.ts'), source(false))
  await git(fixture, 'add', '-A')
  await git(fixture, 'commit', '--quiet', '-m', 'Library')
  await writeFile(join(fixture, 'src/big.ts'), source(true))

  const fullCount = `Number((document.querySelector('.sidebar-file-count')?.textContent ?? '').replace(/[^0-9]/g, '')) >= ${total}`
  const badged = `(() => {
    const walk = (root) => root.querySelector('[data-item-git-status]') != null
      || [...root.querySelectorAll('*')].some((element) => element.shadowRoot != null && walk(element.shadowRoot))
    return walk(document)
  })()`
  for (let launch = 0; launch < LAUNCHES; launch += 1) {
    const app = await launchApp({ folder: fixture })
    try {
      // A reader clicks the changed file the moment it shows — while the
      // skeleton is still on screen. That click is part of what lost the update.
      const row = `(() => {
        const walk = (root) => root.querySelector('[data-item-path="src/big.ts"][data-item-type="file"]')
          ?? [...root.querySelectorAll('*')].reduce((found, element) => found ?? (element.shadowRoot == null ? null : walk(element.shadowRoot)), null)
        return walk(document)
      })()`
      await app.cdp.waitFor(`${row} != null`, 20_000, 16)
      await app.cdp.tryEval(`${row}.click()`)
      const settled = await app.cdp.waitFor(`${fullCount} && ${badged}`, 15_000, 25)
      suite.record(`launch ${launch + 1}${launch === 0 ? ' (cold)' : ''} ends on the live snapshot`, !settled.timedOut, {
        fileCount: await app.cdp.tryEval(`document.querySelector('.sidebar-file-count')?.textContent ?? null`),
        expected: total
      })
    } finally {
      await app.stop()
    }
  }
})
