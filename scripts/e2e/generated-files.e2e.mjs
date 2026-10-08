// Generated files in a review: a lockfile starts as its header ("Generated"),
// a click opens it and it stays open across a tab switch; `.gitattributes`
// decides over the path heuristics both ways (`-linguist-generated` keeps a
// lockfile open, `linguist-generated` folds a hand-named file); "Hide
// generated" drops them from the tree. Open in editor (the header action and
// ⇧⌘O) reaches main with the file.
//
// The old build drew every lockfile in full.
//
//   bun run build && bun scripts/e2e/generated-files.e2e.mjs
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createRepository, git, launchApp, press, removeLater, runSuite } from './harness.mjs'

const lockfile = (count) => Array.from({ length: 400 }, (_unused, index) => `"package-${index}@${count}.0.0":\n  version "${count}.0.${index}"\n`).join('')
const deep = (selector) => `(() => {
  const out = []
  const walk = (root) => {
    out.push(...root.querySelectorAll(${JSON.stringify(selector)}))
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot != null) walk(element.shadowRoot)
  }
  walk(document)
  return out
})()`
const collapsed = (path) => `window.__INSTANCE?.getItem('review:${path}')?.collapsed === true`
const expanded = (path) => `window.__INSTANCE?.getItem('review:${path}') != null && window.__INSTANCE.getItem('review:${path}').collapsed !== true`

await runSuite('generated-files', async (suite, cleanup) => {
  const fixture = await createRepository('generated-files')
  cleanup(removeLater(fixture))
  await mkdir(join(fixture, 'vendor'), { recursive: true })
  // `vendor/` is hand-named generated; `pnpm-lock.yaml` is declared not generated.
  await writeFile(join(fixture, '.gitattributes'), 'vendor/** linguist-generated\npnpm-lock.yaml -linguist-generated\n')
  await writeFile(join(fixture, 'src/app.ts'), 'export const app = 1\n')
  await writeFile(join(fixture, 'yarn.lock'), lockfile(1))
  await writeFile(join(fixture, 'pnpm-lock.yaml'), lockfile(1))
  await writeFile(join(fixture, 'vendor/lib.js'), 'module.exports = 1\n')
  await git(fixture, 'add', '-A')
  await git(fixture, 'commit', '--quiet', '-m', 'Base')
  await writeFile(join(fixture, 'src/app.ts'), 'export const app = 2\n')
  await writeFile(join(fixture, 'yarn.lock'), lockfile(2))
  await writeFile(join(fixture, 'pnpm-lock.yaml'), lockfile(2))
  await writeFile(join(fixture, 'vendor/lib.js'), 'module.exports = 2\n')

  const app = await launchApp({ folder: fixture })
  cleanup(app.stop)
  const { cdp } = app

  const firstRow = `${deep('[data-item-path="src/app.ts"][data-item-type="file"]')}[0]`
  await cdp.waitFor(`${firstRow} != null || document.querySelector('.multi-file-review') != null`, 30_000, 16)
  if (!await cdp.eval(`document.querySelector('.multi-file-review') != null`)) await press(cdp, `${firstRow}.click()`)
  await cdp.waitFor(`window.__INSTANCE?.getItem('review:yarn.lock') != null && window.__INSTANCE?.getItem('review:vendor/lib.js') != null`, 30_000, 16)
  await Bun.sleep(800)

  suite.record('a lockfile starts collapsed, with a Generated tag', await cdp.eval(collapsed('yarn.lock'))
    && await cdp.eval(`${deep('[data-review-generated]')}.length >= 1`))
  suite.record('the source file stays open', await cdp.eval(expanded('src/app.ts')))
  // Attributes answer a moment after the first items: a later file is decided by them.
  suite.record('.gitattributes: -linguist-generated keeps a lockfile open, linguist-generated folds vendor/',
    await cdp.eval(expanded('pnpm-lock.yaml')) && await cdp.eval(collapsed('vendor/lib.js')),
  { pnpm: await cdp.eval(`window.__INSTANCE?.getItem('review:pnpm-lock.yaml')?.collapsed ?? null`), vendor: await cdp.eval(`window.__INSTANCE?.getItem('review:vendor/lib.js')?.collapsed ?? null`) })

  // ── a click opens it, and it stays open ───────────────────────────────────
  await cdp.eval(`window.__INSTANCE.scrollTo({ type: 'item', id: 'review:yarn.lock', align: 'start', behavior: 'instant' })`)
  const button = `${deep('[data-review-collapse-button][aria-label="Expand yarn.lock"]')}[0]`
  const found = await cdp.waitFor(`${button} != null`, 5_000, 16)
  if (!found.timedOut) await press(cdp, `${button}.click()`)
  const opened = await cdp.waitFor(expanded('yarn.lock'), 5_000, 16)
  suite.record('a click opens the lockfile', !found.timedOut && !opened.timedOut)
  // Rewrite a file: the review reloads its items, and the reader's choice holds.
  await writeFile(join(fixture, 'src/app.ts'), 'export const app = 3\n')
  await Bun.sleep(2_000)
  suite.record('it stays open when the review reloads', await cdp.eval(expanded('yarn.lock')))

  // ── Hide generated drops them from the tree ───────────────────────────────
  // The chips sit behind the filter button beside the field.
  await cdp.waitFor(`document.querySelector('.filter-toggle') != null`, 5_000, 16)
  await press(cdp, `document.querySelector('.filter-toggle[aria-expanded="false"]')?.click()`)
  const chip = `[...document.querySelectorAll('.filter-chip')].find((element) => /Hide generated/.test(element.textContent ?? ''))`
  const chipFound = await cdp.waitFor(`${chip} != null`, 5_000, 16)
  if (!chipFound.timedOut) await press(cdp, `${chip}.click()`)
  const hidden = await cdp.waitFor(`${deep('[data-item-path="yarn.lock"][data-item-type="file"]')}.length === 0 && ${deep('[data-item-path="src/app.ts"][data-item-type="file"]')}.length === 1`, 5_000, 16)
  suite.record('Hide generated drops lockfiles from the tree', !chipFound.timedOut && !hidden.timedOut)
  // ── Open in editor (WS-H): the header action and ⇧⌘O reach main with the file ─
  await app.main.send('Runtime.evaluate', { includeCommandLineAPI: true, expression: `(() => {
    const { ipcMain } = require('electron')
    globalThis.__e2eEditorCalls = []
    ipcMain.removeHandler('repository:open-in-editor')
    ipcMain.handle('repository:open-in-editor', (_event, path, line, command) => { globalThis.__e2eEditorCalls.push({ path, line, command }) })
  })()` })
  const editorCalls = async () => JSON.parse((await app.main.send('Runtime.evaluate', { returnByValue: true, expression: 'JSON.stringify(globalThis.__e2eEditorCalls)' })).result.value)
  await cdp.eval(`window.__INSTANCE.scrollTo({ type: 'item', id: 'review:src/app.ts', align: 'start', behavior: 'instant' })`)
  const editorButton = `${deep('[data-review-open-editor][aria-label="Open src/app.ts in editor"]')}[0]`
  const buttonFound = await cdp.waitFor(`${editorButton} != null`, 5_000, 16)
  if (!buttonFound.timedOut) await press(cdp, `${editorButton}.click()`)
  await Bun.sleep(300)
  const fromHeader = await editorCalls()
  suite.record('the file header opens the file in the editor', fromHeader.length === 1 && fromHeader[0].path === 'src/app.ts', { calls: fromHeader })
  await cdp.combo('o', 'KeyO', 79, 12)
  await Bun.sleep(300)
  const fromShortcut = await editorCalls()
  suite.record('⇧⌘O opens the file in front', fromShortcut.length === 2 && typeof fromShortcut[1].path === 'string', { calls: fromShortcut })

  suite.record('memory at end', true, await app.memory())
})
