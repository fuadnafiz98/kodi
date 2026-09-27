// A large *tracked* repository — the shape of a monorepo rather than a dirty
// checkout — must stay responsive through the ticks a working session produces:
// staging from another terminal, saving files, creating new ones, filtering the
// explorer. And the tree must keep what the reader did to it.
//
//   bun run build && bun run e2e huge-repo
//
// What this suite was written against (see scripts/e2e/results/huge-repo.jsonl):
//   - every status tick re-opened a changed folder the reader had collapsed;
//   - every new file rebuilt and re-sorted the whole tree, closing every folder
//     the reader had opened, then rescanned every path with five regexes;
//   - every watcher flush built Sets of every path, twice per side, on the main
//     process (~30–45 ms of blocked IPC per tick at 100k paths).
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createRepository, deepCount, fixture as cachedFixture, git, launchApp, press, runSuite, writeTree } from './harness.mjs'

// 250 × 25 folders of 16 files: 100k tracked paths in ~6.5k folders.
const SHAPE = {
  top: Number(process.env.KODI_E2E_HUGE_TOP ?? 250),
  sub: 25,
  files: Number(process.env.KODI_E2E_HUGE_FILES ?? 16)
}
// A dirty vendored folder with more changed subfolders than the tree opens one
// by one, so re-opening it after a collapse took the rebuild path.
const VENDOR = { top: 2, sub: 30, files: 1 }

// Budgets for one watcher tick. Long tasks are the sharp signal — the renderer
// reports every stretch of 50 ms or more it spent unable to answer — while the
// round-trip ceilings only catch gross regressions: Electron's main process
// answers an inspector evaluate in 10–30 ms even when its JS is idle. Before
// the fixes a new file cost one 125–150 ms task; now none reach 50 ms.
const TICK_BUDGET = { longTaskMs: 100, rendererMs: 300, mainMs: 80, counterBudgets: { treeResets: 0 } }

const deepElement = (selector) => `(() => {
  const walk = (root) => {
    const found = root.querySelector(${JSON.stringify(selector)})
    if (found != null) return found
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot == null) continue
      const inner = walk(element.shadowRoot)
      if (inner != null) return inner
    }
    return null
  }
  return walk(document)
})()`
const folderRow = (path) => deepElement(`[data-item-path="${path}/"][data-item-type="folder"]`)
const expanded = (path) => `${folderRow(path)}?.getAttribute('aria-expanded') === 'true'`
const collapsed = (path) => `${folderRow(path)}?.getAttribute('aria-expanded') === 'false'`
const toggleFolder = (path) => `${folderRow(path)}.click()`
const fileCount = (atLeast) => `(() => {
  const text = document.querySelector('.sidebar-file-count')?.textContent ?? ''
  return Number(text.replace(/[^0-9]/g, '')) >= ${atLeast}
})()`

await runSuite('huge-repo', async (suite, cleanup) => {
  const shapeKey = `huge-${SHAPE.top}x${SHAPE.sub}x${SHAPE.files}`
  const { root: fixture, cleanup: removeFixture } = await cachedFixture(shapeKey, async () => {
    const root = await createRepository('huge')
    await writeTree(root, 'imux', SHAPE)
    await git(root, 'add', '-A')
    await git(root, 'commit', '--quiet', '-m', 'Vendor imux')
    return root
  })
  cleanup(removeFixture)
  const tracked = SHAPE.top * SHAPE.sub * SHAPE.files + 3
  // Sorts above `imux/`, so its row stays on screen with imux open.
  await writeTree(fixture, 'deps', VENDOR)
  const total = tracked + VENDOR.top * VENDOR.sub * VENDOR.files

  const app = await launchApp({ folder: fixture })
  cleanup(app.stop)
  const { cdp } = app

  await suite.step(cdp, 'opens the repository and lists every file', async () => {}, fileCount(total),
    { timeoutMs: 90_000 })
  // The changed folder opens on arrival; the reader closes it and opens two
  // clean ones by hand. Everything below checks the tree kept that.
  await cdp.waitFor(expanded('deps'), 10_000, 16)
  await press(cdp, toggleFolder('deps'))
  await press(cdp, toggleFolder('imux'))
  await cdp.waitFor(`${folderRow('imux/m1')} != null`, 10_000, 16)
  await press(cdp, toggleFolder('imux/m1'))
  const arranged = await cdp.tryEval(`${collapsed('deps')} && ${expanded('imux')} && ${expanded('imux/m1')}`)
  suite.record('reader arranges the tree', arranged === true)
  const arrangement = `${collapsed('deps')} && ${expanded('imux')} && ${expanded('imux/m1')}`

  // Staging from another terminal: only a status changes, three times over.
  for (let tick = 0; tick < 3; tick += 1) {
    await suite.watch(app, `status tick ${tick + 1} leaves the reader's folders alone`, async () => {
      if (tick === 0) await writeFile(join(fixture, 'src/app.ts'), 'export const staged = 1\n')
      await git(fixture, ...(tick % 2 === 0 ? ['add'] : ['reset', '--quiet']), '--', 'src/app.ts')
    }, { settleMs: 1_200, check: arrangement, ...TICK_BUDGET })
  }

  // A save of a tracked file: the commonest tick there is.
  for (let tick = 0; tick < 3; tick += 1) {
    await suite.watch(app, `save ${tick + 1} of a tracked file keeps both processes responsive`,
      () => writeFile(join(fixture, 'imux/m2/s2/f2.ts'), `export const saved = ${tick}\n`),
      { settleMs: 1_000, check: arrangement, ...TICK_BUDGET })
  }

  // New files: the path list itself changes, which used to rebuild the tree.
  for (let tick = 0; tick < 3; tick += 1) {
    await suite.watch(app, `new file ${tick + 1} is added without rebuilding the tree`,
      () => writeFile(join(fixture, `notes-${tick}.md`), '# note\n'),
      {
        settleMs: 1_200,
        done: fileCount(total + tick + 1),
        check: arrangement,
        ...TICK_BUDGET
      })
  }

  // Filtering: the field must keep up with typing on 100k paths. Each key is
  // timed on its own; the scan and the tree rebuild behind it may run later,
  // but never in front of the next key.
  const filterInput = `document.querySelector('input[aria-label="Filter files"]')`
  await press(cdp, `${filterInput}.focus()`)
  const query = 'm1*.ts'
  await suite.watch(app, 'typing a glob filter keeps the field responsive', async () => {
    let slowestMs = 0
    for (const character of query) {
      const started = performance.now()
      await cdp.send('Input.insertText', { text: character })
      slowestMs = Math.max(slowestMs, performance.now() - started)
      await Bun.sleep(60)
    }
    return { slowestMs }
  }, {
    timedAction: false,
    settleMs: 1_500,
    check: `${filterInput}.value === ${JSON.stringify(query)}`,
    rendererMs: 150,
    longTaskMs: 250,
    // The old field ran the scan in front of every key: six long tasks, 615 ms.
    longTaskTotalMs: 300
  })
  const typed = await cdp.tryEval(`${filterInput}.value`)
  if (typed !== query) console.log('filter field holds', JSON.stringify(typed))
  await suite.watch(app, 'clearing the filter restores the tree', async () => {
    await press(cdp, `(() => {
      const input = ${filterInput}
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
  }, { settleMs: 1_500, done: fileCount(total + 3), rendererMs: 400, longTaskMs: 250 })

  // ⌘P over 100k paths: every key ranks the index, and the workspace behind
  // the palette must not render at all.
  await cdp.combo('p', 'KeyP', 80, 4)
  await cdp.waitFor(`document.activeElement === document.querySelector('#command-palette-input')`, 8_000, 8)
  const paletteQuery = 'm12s3f1'
  await suite.watch(app, 'palette typing ranks 100k paths without stalls', async () => {
    let slowestMs = 0
    for (const character of paletteQuery) {
      const started = performance.now()
      await cdp.send('Input.insertText', { text: character })
      slowestMs = Math.max(slowestMs, performance.now() - started)
      await Bun.sleep(60)
    }
    return { slowestMs }
  }, {
    timedAction: false,
    settleMs: 1_200,
    check: `document.querySelectorAll('.command-palette-results button').length > 0`,
    rendererMs: 150,
    longTaskMs: 100,
    counterBudgets: { workspaceRenders: 0 }
  })
  await cdp.escape()
  await cdp.waitFor(`document.querySelector('#command-palette-input') == null`, 5_000, 16)

  // The Source Control panel lives beside the workspace; opening and closing it
  // must not re-render the 100k-path workspace behind it (it did 5 times).
  const panelButton = `document.querySelector('.source-control-titlebar-button')`
  await suite.watch(app, 'opening and closing Source Control leaves the workspace alone', async () => {
    await press(cdp, `${panelButton}.click()`)
    await cdp.waitFor(`document.querySelector('.scm-row, .scm-empty, [data-section]') != null`, 10_000, 16)
    await press(cdp, `${panelButton}.click()`)
  }, { settleMs: 800, rendererMs: 300, longTaskMs: 150, counterBudgets: { workspaceRenders: 1 } })

  const badged = await cdp.tryEval(deepCount('[data-item-git-status]'))
  suite.record('git badges survive', Number(badged) > 0, { badgedRows: badged })
  const banner = await cdp.tryEval(`document.querySelector('.error-banner')?.textContent ?? null`)
  suite.record('no error banner', banner == null, { banner })
  suite.record('memory at end', true, await app.memory())
})
