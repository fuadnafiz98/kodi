// A working tree with tens of thousands of changed files must keep the window
// responsive: expand/collapse all in the explorer, a watcher burst of new files,
// and staging everything from the Changes tab.
//
//   bun run build && bun run e2e:large-worktree
//
// Before the fix this suite was written for, collapse-all froze the renderer for
// 15 s on this fixture (one tree notification per folder, O(folders²)).
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createRepository, deepCount, git, launchApp, press, removeLater, runSuite, writeTree } from './harness.mjs'

// Folder-dense on purpose: the cost that froze the window grew with the number
// of folders, not files. 240 × 25 leaf folders of 4 files is ~24k files in ~6.2k
// folders — the shape of a vendored tool checkout like `imux/`.
const SHAPE = { top: Number(process.env.KODI_E2E_TOP_FOLDERS ?? 240), sub: 25, files: 4 }
const BURST = { top: 40, sub: 25, files: 4 }
const CYCLES = 5
// Heap a repeated expand/collapse may keep. A leak of one projection per cycle
// on this tree is tens of MB.
const HEAP_GROWTH_BUDGET_MB = 25

const fileCountExpression = (atLeast) => `(() => {
  const text = document.querySelector('.sidebar-file-count')?.textContent ?? ''
  return Number(text.replace(/[^0-9]/g, '')) >= ${atLeast}
})()`

await runSuite('large-worktree', async (suite, cleanup) => {
  const fixture = await createRepository('large')
  cleanup(removeLater(fixture))
  // The shape from the bug report: a large untracked checkout inside the repo.
  const fileCount = await writeTree(fixture, 'imux', SHAPE) + 3
  await writeFile(join(fixture, 'src/app.ts'), 'export const changed = true\n')

  const app = await launchApp({ folder: fixture })
  cleanup(app.stop)
  const { cdp } = app

  await suite.step(cdp, 'opens the repository and lists every file', async () => {}, fileCountExpression(fileCount))

  const toggle = `document.querySelector('.sidebar-heading-actions button[aria-label$="all folders"]')`
  const label = (value) => `${toggle}?.getAttribute('aria-label') === '${value}'`
  await suite.step(cdp, 'expand all folders stays responsive',
    () => press(cdp, `${toggle}.click()`), label('Collapse all folders'))
  await suite.step(cdp, 'collapse all folders stays responsive',
    () => press(cdp, `${toggle}.click()`), label('Expand all folders'))

  const heapBefore = await app.memory()
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    await suite.step(cdp, `expand/collapse cycle ${cycle + 1}`, async () => {
      await press(cdp, `${toggle}.click()`)
      await cdp.waitFor(label('Collapse all folders'), 30_000, 16)
      await press(cdp, `${toggle}.click()`)
    }, label('Expand all folders'))
  }
  const heapAfter = await app.memory()
  suite.growth('expand/collapse cycles do not grow the heap', heapBefore.jsHeapUsedMb, heapAfter.jsHeapUsedMb, HEAP_GROWTH_BUDGET_MB)

  await press(cdp, `${toggle}.click()`)
  // A rebuilt tree must come back with its git badges: the rows on screen
  // still say which files changed.
  const badged = await cdp.tryEval(deepCount('[data-item-git-status]'))
  suite.record('git badges survive expand/collapse', Number(badged) > 0, { badgedRows: badged })

  // A very dirty repository: every one of these ~24k files is a status, and a
  // tick that changes one of them used to re-sort and re-walk them all.
  for (let tick = 0; tick < 3; tick += 1) {
    await suite.watch(app, `status tick ${tick + 1} over ~24k changed files stays cheap`, async () => {
      if (tick === 0) await writeFile(join(fixture, 'README.md'), '# changed\n')
      else await git(fixture, ...(tick === 1 ? ['add'] : ['reset', '--quiet']), '--', 'README.md')
    }, { settleMs: 1_500, longTaskMs: 150, rendererMs: 400, mainMs: 150 })
  }

  const burstCount = fileCount + BURST.top * BURST.sub * BURST.files
  await suite.step(cdp, 'a watcher burst of new folders stays responsive',
    () => writeTree(fixture, 'imux-burst', BURST), fileCountExpression(burstCount))

  await suite.step(cdp, 'source control opens on the large change list',
    () => press(cdp, `document.querySelector('.source-control-titlebar-button').click()`),
    `document.querySelectorAll('.scm-row').length > 0 && !!document.querySelector('.scm-more')`)
  await suite.step(cdp, 'Stage All moves every change into Staged Changes',
    () => press(cdp, `document.querySelector('.scm-section-button.suggested').click()`),
    `(() => { const header = document.querySelector('[data-section="staged"] .scm-count');
      return header != null && Number(header.textContent) >= ${burstCount - 3}
        && document.querySelector('[data-section="unstaged"]') == null })()`)
  await suite.step(cdp, 'Unstage All puts them back',
    () => press(cdp, `document.querySelector('[data-section="staged"] .scm-section-button').click()`),
    `document.querySelector('[data-section="staged"]') == null
      && Number(document.querySelector('[data-section="unstaged"] .scm-count')?.textContent ?? 0) >= ${burstCount - 3}`)

  const banner = await cdp.tryEval(`document.querySelector('.error-banner')?.textContent ?? null`)
  suite.record('no error banner', banner == null, { banner })
  suite.record('memory at end', true, await app.memory())
})
