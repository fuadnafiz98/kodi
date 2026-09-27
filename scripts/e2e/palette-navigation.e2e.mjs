// ⌘K → a file must take the reader to that file, wherever they are: to its
// section in a folder review or a commit review (the list scrolls there and the
// tree follows), and to the file itself in the single-file view, header and all.
//
//   bun run build && bun run e2e palette-navigation
//
// What this suite was written against (see scripts/e2e/results/palette-navigation.jsonl):
//   - an invoke's reply and the progress events sent before it are separate IPC
//     messages, and Electron does not order one against the other. When the reply
//     won, the folder review stopped at the first streamed file (or read "no
//     patch" and fetched fifty files one by one) and a commit review stopped at
//     its first page, so ⌘K to any other file did nothing at all. The suite runs
//     every load three times: as sent, with each reply ahead of all its pages,
//     and with the reply between the first page and the rest;
//   - the single-file view kept the previous file's header — name and line
//     counts — over the new file's diff after a ⌘K jump.
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  counters, createRepository, git, launchApp, press, removeLater, reorderReviewProgress, runSuite,
  takeLongTasks, writeTree
} from './harness.mjs'

const CHANGED = 40
const LINES = 240
const pad = (index) => String(index).padStart(2, '0')
const changedPath = (index) => `changed/c${pad(index)}.ts`
const historyPath = (index) => `hist/h${pad(index)}.ts`
const source = (label, edited) => Array.from({ length: LINES }, (_unused, line) =>
  edited && line % 6 === 0
    ? `export const ${label}${line} = compute(${line}, 'edited')\n`
    : `export const ${label}${line} = compute(${line}, 'original')\n`).join('')

const deepAll = (selector) => `(() => {
  const found = []
  const walk = (root) => {
    for (const element of root.querySelectorAll(${JSON.stringify(selector)})) found.push(element)
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot != null) walk(element.shadowRoot)
  }
  walk(document)
  return found
})()`
const fileRow = (path) => `${deepAll(`[data-item-path="${path}"][data-item-type="file"]`)}[0]`
const treeSelection = `${deepAll('[data-item-selected="true"]')}.map((row) => row.getAttribute('data-item-path'))`
// The file whose header sits at the top of the review: the one the reader is on.
const reviewTop = `(() => {
  const scroller = document.querySelector('.multi-file-code-view')
  if (scroller == null) return null
  const top = scroller.getBoundingClientRect().top
  const headers = ${deepAll('[data-diffs-header] [data-title]')}
    .map((title) => ({ path: title.textContent, y: title.getBoundingClientRect().top - top }))
    .filter((header) => header.y > -8 && header.y < 64)
    .sort((a, b) => a.y - b.y)
  return headers[0]?.path ?? null
})()`
const onReviewFile = (path) => `(${reviewTop}) === ${JSON.stringify(path)}
  && (${treeSelection}).includes(${JSON.stringify(path)})`
// The single-file view. A clean file shows its path bar (`.editor-breadcrumbs`);
// a changed file shows the toolbar title and a diff card whose header — inside
// Pierre's shadow root — must name the same file, and the dimmed "previous file
// while the next loads" state must be over.
const inSingleFileView = `document.querySelector('.multi-file-code-view') == null
  && document.querySelector('.diff-stale[data-dim]') == null`
const pathBarReads = (path) => `${inSingleFileView}
  && document.querySelector('.editor-breadcrumbs')?.textContent.replaceAll('›', '/') === ${JSON.stringify(path)}`
const onSingleFile = (path) => `${inSingleFileView}
  && document.querySelector('.diff-file-title')?.getAttribute('title') === ${JSON.stringify(path)}
  && ${deepAll('[data-diffs-header] [data-title]')}[0]?.textContent === ${JSON.stringify(path)}`
const scrollReviewBy = (distance) => `document.querySelector('.multi-file-code-view').scrollBy(0, ${distance})`

const paletteInput = `document.querySelector('#command-palette-input')`

/** ⌘K, the query, then Enter or a click on the first file result. */
async function pick(cdp, query, how) {
  await cdp.combo('k', 'KeyK', 75, 4)
  await cdp.waitFor(`document.activeElement === ${paletteInput}`, 8_000, 4)
  for (const character of query) {
    await cdp.send('Input.insertText', { text: character })
    await Bun.sleep(25)
  }
  await cdp.waitFor(`[...document.querySelectorAll('.command-palette-results button')]
    .some((row) => row.textContent.includes(${JSON.stringify(query)}))`, 5_000, 16)
  // Only the pick itself is timed: the typing above paces itself.
  const started = performance.now()
  if (how === 'enter') await cdp.enter()
  else {
    await press(cdp, `[...document.querySelectorAll('.command-palette-results button')]
      .find((row) => row.textContent.includes(${JSON.stringify(query)})).click()`)
  }
  return { slowestMs: performance.now() - started }
}

// A jump costs one scroll and one tree follow; neither may freeze the renderer,
// and none may fall back to fetching files one by one.
// The main-process ceiling is loose on purpose: a jump does no main work, and
// an idle Electron main answers the inspector in 10–40 ms, more on a busy
// machine (a profile of three jumps: 2.39 s of 2.4 s idle).
const JUMP_BUDGET = {
  timedAction: false,
  settleMs: 1_200,
  rendererMs: 300,
  mainMs: 250,
  longTaskMs: 150,
  counterBudgets: { reviewPagedFallbacks: 0, comparisonRequests: 0 }
}

await runSuite('palette-navigation', async (suite, cleanup) => {
  const fixture = await createRepository('palette-nav')
  cleanup(removeLater(fixture))
  await writeTree(fixture, 'lib', { top: 10, sub: 5, files: 4 })
  await mkdir(join(fixture, 'changed'), { recursive: true })
  await mkdir(join(fixture, 'hist'), { recursive: true })
  for (let index = 0; index < CHANGED; index += 1) {
    await writeFile(join(fixture, changedPath(index)), source(`c${index}_`, false))
    await writeFile(join(fixture, historyPath(index)), source(`h${index}_`, false))
  }
  await git(fixture, 'add', '-A')
  await git(fixture, 'commit', '--quiet', '-m', 'Base')
  // The commit a reviewer opens from History: every history file at once.
  for (let index = 0; index < CHANGED; index += 1) {
    await writeFile(join(fixture, historyPath(index)), source(`h${index}_`, true))
  }
  await git(fixture, 'add', '-A')
  await git(fixture, 'commit', '--quiet', '-m', 'Wide commit')
  // The folder review: every changed file edited in the working tree.
  for (let index = 0; index < CHANGED; index += 1) {
    await writeFile(join(fixture, changedPath(index)), source(`c${index}_`, true))
  }

  const modes = {
    'as sent': null,
    'reply first': { passFirst: false },
    'reply after the first page': { passFirst: true }
  }
  for (const [mode, reorder] of Object.entries(modes)) {
    const app = await launchApp({ folder: fixture })
    // Also on Ctrl-C, which runs the suite's cleanups but not this loop's finally.
    cleanup(app.stop)
    const { cdp } = app
    try {
      if (reorder != null) await reorderReviewProgress(app, reorder)
      const label = (text) => `${text} (${mode})`

      // ── folder review ──────────────────────────────────────────────────────
      await cdp.waitFor(`${fileRow(changedPath(0))} != null`, 30_000, 16)
      await press(cdp, `${fileRow(changedPath(0))}.click()`)
      await suite.step(cdp, label('the folder review opens on the clicked file'), async () => {},
        `document.querySelector('.multi-file-code-view') != null && (${reviewTop}) === ${JSON.stringify(changedPath(0))}`,
        { timeoutMs: 20_000 })
      await Bun.sleep(1_500)
      const loaded = await counters(cdp)
      suite.record(label('the folder review loaded in one patch, not file by file'),
        (loaded.reviewPagedFallbacks ?? 0) === 0 && (loaded.comparisonRequests ?? 0) === 0,
        { fallbacks: loaded.reviewPagedFallbacks ?? 0, comparisonRequests: loaded.comparisonRequests ?? 0,
          reason: await cdp.tryEval('window.__kodiLastReason?.reviewPagedFallbacks ?? null') })

      const targets = [[changedPath(CHANGED - 1), 'enter'], [changedPath(17), 'click'], [changedPath(3), 'enter'], [changedPath(28), 'click']]
      for (const [path, how] of targets) {
        await suite.watch(app, label(`⌘K ${how === 'enter' ? 'Enter' : 'click'} on ${path} scrolls the folder review to it`),
          () => pick(cdp, path, how), { ...JUMP_BUDGET, done: onReviewFile(path), check: onReviewFile(path) })
      }

      // ⌘K to the file that is already selected — picked (or clicked) a moment
      // ago, then scrolled away from — changes no app state. It used to do
      // nothing at all.
      const lastPicked = targets.at(-1)[0]
      await cdp.eval(scrollReviewBy(9_000))
      await Bun.sleep(400)
      await suite.watch(app, label(`⌘K back to the selected ${lastPicked} after scrolling away returns to it`),
        () => pick(cdp, lastPicked, 'enter'), { ...JUMP_BUDGET, done: onReviewFile(lastPicked), check: onReviewFile(lastPicked) })
      // Headers are sticky, so inside a file its header still sits at the top:
      // only the scroll offset says whether the pick moved anything.
      await cdp.eval(scrollReviewBy(400))
      await Bun.sleep(400)
      const insideTop = await cdp.eval(`document.querySelector('.multi-file-code-view').scrollTop`)
      const backAtFileTop = `${onReviewFile(lastPicked)}
        && document.querySelector('.multi-file-code-view').scrollTop <= ${insideTop - 350}`
      await suite.watch(app, label(`⌘K to ${lastPicked} again from inside it returns to its top`),
        () => pick(cdp, lastPicked, 'click'), { ...JUMP_BUDGET, done: backAtFileTop, check: backAtFileTop })

      // ── single-file view ───────────────────────────────────────────────────
      // A clean file opens on its own; every changed file picked after it opens
      // in the same view, and the card's header must be the picked file's.
      const clean = 'lib/m3/s1/f2.ts'
      await suite.watch(app, label(`⌘K on the clean ${clean} opens it`),
        () => pick(cdp, clean, 'enter'), { ...JUMP_BUDGET, counterBudgets: {}, done: pathBarReads(clean), check: pathBarReads(clean) })
      for (const [path, how] of [[changedPath(7), 'enter'], [changedPath(21), 'click'], [changedPath(33), 'enter']]) {
        await suite.watch(app, label(`⌘K on ${path} shows its own header in the single-file view`),
          () => pick(cdp, path, how), { ...JUMP_BUDGET, counterBudgets: {}, done: onSingleFile(path), check: onSingleFile(path) })
      }

      // Back into the folder review on the selected row, deep in the list: the
      // commit review opened from here must start on its own first file, not at
      // this scroll offset.
      const deepPath = changedPath(33)
      await suite.watch(app, label(`clicking the selected ${deepPath} row returns to the folder review there`),
        () => press(cdp, `${fileRow(deepPath)}.click()`),
        { ...JUMP_BUDGET, timedAction: true, done: onReviewFile(deepPath), check: onReviewFile(deepPath) })

      // ── commit review ──────────────────────────────────────────────────────
      await press(cdp, `document.querySelector('.chrome-branch-button').click()`)
      await cdp.waitFor(`[...document.querySelectorAll('.git-panel-tabs [role="tab"]')].some((tab) => tab.textContent.startsWith('History'))`, 10_000, 16)
      await press(cdp, `[...document.querySelectorAll('.git-panel-tabs [role="tab"]')].find((tab) => tab.textContent.startsWith('History')).click()`)
      await cdp.waitFor(`document.querySelector('.commit-row button[aria-label^="Review commit"]') != null`, 10_000, 16)
      await press(cdp, `document.querySelector('.commit-row button[aria-label^="Review commit"]').click()`)
      await suite.step(cdp, label('the commit review opens on its first file, not at the folder review\'s offset'), async () => {},
        `document.querySelector('.multi-file-code-view') != null && (${reviewTop}) === ${JSON.stringify(historyPath(0))}`,
        { timeoutMs: 20_000 })
      await Bun.sleep(1_000)
      for (const [path, how] of [[historyPath(CHANGED - 1), 'enter'], [historyPath(12), 'click'], [historyPath(26), 'enter']]) {
        await suite.watch(app, label(`⌘K ${how === 'enter' ? 'Enter' : 'click'} on ${path} scrolls the commit review to it`),
          () => pick(cdp, path, how), { ...JUMP_BUDGET, done: onReviewFile(path), check: onReviewFile(path) })
      }

      // Switching tabs is a restore, not a navigation: each review comes back
      // where its reader left it, the Desk on the file it was reading.
      const tab = (source) => `[...document.querySelectorAll('.world-tab button[role="tab"]')]
        .find((button) => button.querySelector('[data-source="${source}"]') != null)`
      await cdp.eval(scrollReviewBy(-2_500))
      await Bun.sleep(500)
      const leftAt = await cdp.eval(`document.querySelector('.multi-file-code-view').scrollTop`)
      await suite.watch(app, label(`switching to the Desk tab brings back its folder review on ${deepPath}`),
        () => press(cdp, `${tab('desk')}.click()`),
        { ...JUMP_BUDGET, timedAction: true, done: onReviewFile(deepPath), check: onReviewFile(deepPath) })
      const backWhereLeft = `document.querySelector('.multi-file-code-view') != null
        && Math.abs(document.querySelector('.multi-file-code-view').scrollTop - ${leftAt}) <= 40`
      await suite.watch(app, label('switching back to the commit tab returns to where it was left'),
        () => press(cdp, `${tab('patch')}.click()`),
        { ...JUMP_BUDGET, timedAction: true, done: backWhereLeft, check: backWhereLeft })

      await takeLongTasks(cdp)
      const banner = await cdp.tryEval(`document.querySelector('.error-banner')?.textContent ?? null`)
      suite.record(label('no error banner'), banner == null, { banner })
      suite.record(label('memory at end'), true, await app.memory())
    } finally {
      await app.stop()
    }
  }
})
