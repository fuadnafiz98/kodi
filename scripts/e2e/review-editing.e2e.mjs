// The review and the editor must not redo work nobody asked for:
//   - a status-only tick (staging a file from another terminal) while the
//     multi-file review is open must not refetch the files it already shows,
//     nor drop it into the folder's paged mode;
//   - typing in the editor must not re-render the whole workspace per key.
//
//   bun run build && bun run e2e review-editing
//
// Before the fixes: one `git add` refetched and re-highlighted fifty files and
// left a load-more sentinel behind; each keystroke re-rendered the workspace.
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { counters, createRepository, deepCount, git, launchApp, press, removeLater, runSuite, writeTree } from './harness.mjs'

// More changed files than the review's page size (50), so paged mode shows.
const CHANGED = { top: 4, sub: 5, files: 4 }
const KEYSTROKES = 60

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

await runSuite('review-editing', async (suite, cleanup) => {
  const fixture = await createRepository('review')
  cleanup(removeLater(fixture))
  const changed = await writeTree(fixture, 'pkg', { ...CHANGED, contents: (c) => `export const v = ${c}\n`.repeat(20) })
  await writeFile(join(fixture, 'notes.ts'), Array.from({ length: 40 }, (_unused, line) => `export const line${line} = ${line}\n`).join(''))
  await git(fixture, 'add', '-A')
  await git(fixture, 'commit', '--quiet', '-m', 'Add package')
  for (let a = 0; a < CHANGED.top; a += 1) {
    for (let b = 0; b < CHANGED.sub; b += 1) {
      for (let c = 0; c < CHANGED.files; c += 1) {
        await appendFile(join(fixture, 'pkg', `m${a}`, `s${b}`, `f${c}.ts`), `export const edited = ${c}\n`)
      }
    }
  }

  const app = await launchApp({ folder: fixture })
  cleanup(app.stop)
  const { cdp } = app

  await suite.step(cdp, 'opens the multi-file review of every change', async () => {
    await cdp.waitFor(`${deepElement('[data-item-path="pkg/m0/s0/f0.ts"][data-item-type="file"]')} != null`, 20_000, 16)
    await press(cdp, `${deepElement('[data-item-path="pkg/m0/s0/f0.ts"][data-item-type="file"]')}.click()`)
  }, `${deepCount('[data-line]')} > 0`, { timeoutMs: 20_000 })
  // Let the working-tree patch land for every file before measuring.
  await Bun.sleep(2_500)
  // The tree follows the review once per frame now; it still has to land on
  // the file the review shows.
  const followed = await cdp.tryEval(`${deepElement('[data-item-path="pkg/m0/s0/f0.ts"][data-item-type="file"]')}?.getAttribute('aria-selected')`)
  suite.record('the tree follows the review to its file', followed === 'true', { ariaSelected: followed })
  const loaded = await counters(cdp)
  suite.record('review loads from the working-tree patch', true, { changed, counters: loaded })

  for (let tick = 0; tick < 2; tick += 1) {
    await suite.watch(app, `staging tick ${tick + 1} refetches nothing the review shows`,
      () => git(fixture, ...(tick === 0 ? ['add'] : ['reset', '--quiet']), '--', 'pkg/m1/s1/f1.ts'),
      {
        settleMs: 2_500,
        // Paged mode is what the refetch left behind: a sentinel at the end of
        // a review that had every file already.
        check: `${deepCount('.review-load-sentinel')} === 0`,
        longTaskMs: 150,
        rendererMs: 300,
        mainMs: 150,
        counterBudgets: { comparisonRequests: 0 }
      })
  }

  await suite.step(cdp, 'opens a clean file for editing', async () => {
    await press(cdp, `${deepElement('[data-item-path="notes.ts"][data-item-type="file"]')}.click()`)
    await cdp.waitFor(`document.querySelector('.file-edit-start:not([disabled])') != null`, 10_000, 16)
    await press(cdp, `document.querySelector('.file-edit-start').click()`)
  }, `${deepElement('[contenteditable="true"]')} != null`, { timeoutMs: 15_000 })
  await press(cdp, `(() => {
    const editor = ${deepElement('[contenteditable="true"]')}
    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
    const selection = editor.getRootNode().getSelection?.() ?? window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  })()`)
  await Bun.sleep(300)

  const rendersBefore = (await counters(cdp)).workspaceRenders ?? 0
  await suite.watch(app, `typing ${KEYSTROKES} characters does not re-render the workspace per key`, async () => {
    let slowestMs = 0
    for (let key = 0; key < KEYSTROKES; key += 1) {
      const started = performance.now()
      await cdp.send('Input.insertText', { text: 'x' })
      slowestMs = Math.max(slowestMs, performance.now() - started)
      await Bun.sleep(15)
    }
    return { slowestMs }
  }, {
    timedAction: false,
    settleMs: 800,
    // The first key makes the file dirty, which the toolbar has to show; after
    // that the text is the editor's business alone.
    check: `(window.__kodiMetrics?.workspaceRenders ?? 0) - ${rendersBefore} <= 4
      && (${deepElement('[contenteditable="true"]')}?.textContent ?? '').includes(${JSON.stringify('x'.repeat(KEYSTROKES))})`,
    rendererMs: 150,
    longTaskMs: 100
  })
  const rendersAfter = (await counters(cdp)).workspaceRenders ?? 0
  suite.record('workspace renders while typing', rendersAfter - rendersBefore <= 4,
    { renders: rendersAfter - rendersBefore, keystrokes: KEYSTROKES })

  const banner = await cdp.tryEval(`document.querySelector('.error-banner')?.textContent ?? null`)
  suite.record('no error banner', banner == null, { banner })
  suite.record('memory at end', true, await app.memory())
})
