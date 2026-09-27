// Scrolling and the palette must feel like a native list: steady frames, no
// hitches, no stalls while idle. This is the suite that reads what the reader
// feels, rather than what a fix was meant to change:
//   - frame pacing while flinging through a large diff;
//   - ⌘K: open, type, and scroll its results;
//   - an idle window, and one where the watcher ticks every second, must not
//     freeze from time to time.
//
//   bun run build && bun run e2e smoothness
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  counters, createRepository, git, largestScroller, launchApp, press, removeLater, runSuite,
  scrollGesture, startFrames, stopFrames, takeLongTasks, writeTree
} from './harness.mjs'

const LINES = 4_000
const source = (edited) => Array.from({ length: LINES }, (_unused, line) =>
  edited && line % 4 === 0
    ? `export const value${line} = computeSomething(${line}, 'edited') // changed line ${line}\n`
    : `export const value${line} = computeSomething(${line}, 'original')\n`).join('')

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

await runSuite('smoothness', async (suite, cleanup) => {
  const fixture = await createRepository('smooth')
  cleanup(removeLater(fixture))
  await writeTree(fixture, 'lib', { top: 40, sub: 10, files: 5 })
  await writeFile(join(fixture, 'src/big.ts'), source(false))
  await git(fixture, 'add', '-A')
  await git(fixture, 'commit', '--quiet', '-m', 'Big file')
  await writeFile(join(fixture, 'src/big.ts'), source(true))

  const app = await launchApp({ folder: fixture })
  cleanup(app.stop)
  const { cdp } = app

  const bigRow = deepElement('[data-item-path="src/big.ts"][data-item-type="file"]')
  await cdp.waitFor(`${bigRow} != null`, 20_000, 16)
  await press(cdp, `${bigRow}.click()`)
  await cdp.waitFor(`${deepElement('[data-line]')} != null`, 20_000, 16)
  await Bun.sleep(1_500)

  // ── idle: nothing should run long while nobody touches anything ──────────
  await takeLongTasks(cdp)
  await startFrames(cdp)
  await Bun.sleep(6_000)
  const idleFrames = await stopFrames(cdp)
  const idleTasks = await takeLongTasks(cdp)
  suite.record('idle with the review open never freezes', idleTasks.longestMs < 100 && idleFrames.over50 === 0,
    { longTasks: idleTasks, frames: idleFrames })

  // ── diff scrolling ────────────────────────────────────────────────────────
  const scroller = await cdp.eval(largestScroller())
  suite.record('the review has a scroll container', scroller != null, {
    scroller,
    ...(scroller == null ? { view: await cdp.tryEval(`(() => { const el = document.querySelector('.multi-file-code-view'); return el == null ? document.querySelector('.workspace')?.innerText.slice(0, 200) : { sh: el.scrollHeight, ch: el.clientHeight, oy: getComputedStyle(el).overflowY } })()`) } : {})
  })
  if (scroller != null) {
    await takeLongTasks(cdp)
    const hydrationsBefore = (await counters(cdp)).autoHydrations ?? 0
    await startFrames(cdp)
    for (let pass = 0; pass < 3; pass += 1) {
      await scrollGesture(cdp, scroller, 6_000, 3_000)
      await scrollGesture(cdp, scroller, -6_000, 3_000)
    }
    const frames = await stopFrames(cdp)
    const tasks = await takeLongTasks(cdp)
    // Whole-file hydration waits for the reader to stop; during a fling it
    // fetched and highlighted every file the fling passed over.
    const hydrationsDuring = ((await counters(cdp)).autoHydrations ?? 0) - hydrationsBefore
    suite.record('flinging through a 4,000-line diff keeps steady frames',
      frames.over50 <= 2 && frames.p95Ms <= 25 && tasks.longestMs < 100 && hydrationsDuring === 0,
      { frames, longTasks: tasks, hydrationsDuring, rendersDuring: (await counters(cdp)).workspaceRenders })
  }

  // ── watcher ticks while reading: a save every second ──────────────────────
  await takeLongTasks(cdp)
  const countersBeforeTicks = await counters(cdp)
  await startFrames(cdp)
  for (let tick = 0; tick < 6; tick += 1) {
    await writeFile(join(fixture, `lib/m${tick}/s0/f0.ts`), `export const saved = ${tick}\n`)
    await Bun.sleep(1_000)
  }
  const tickFrames = await stopFrames(cdp)
  const tickTasks = await takeLongTasks(cdp)
  const countersAfterTicks = await counters(cdp)
  const refetched = (countersAfterTicks.comparisonRequests ?? 0) - (countersBeforeTicks.comparisonRequests ?? 0)
  const fellBack = (countersAfterTicks.reviewPagedFallbacks ?? 0) - (countersBeforeTicks.reviewPagedFallbacks ?? 0)
  suite.record('saves elsewhere do not stutter the open review',
    tickTasks.longestMs < 100 && tickFrames.over50 <= 1 && refetched === 0 && fellBack === 0,
    { longTasks: tickTasks, frames: tickFrames, refetched, fellBack,
      reason: fellBack > 0 ? await cdp.tryEval('window.__kodiLastReason?.reviewPagedFallbacks ?? null') : undefined })

  // ── ⌘K ────────────────────────────────────────────────────────────────────
  const rendersBefore = (await counters(cdp)).workspaceRenders ?? 0
  await takeLongTasks(cdp)
  await startFrames(cdp)
  const openStarted = performance.now()
  await cdp.combo('k', 'KeyK', 75, 4)
  const opened = await cdp.waitFor(`document.activeElement === document.querySelector('#command-palette-input')`, 8_000, 4)
  const openMs = Math.round(performance.now() - openStarted)
  let slowestKeyMs = 0
  for (const character of 'f1ts') {
    const started = performance.now()
    await cdp.send('Input.insertText', { text: character })
    slowestKeyMs = Math.max(slowestKeyMs, Math.round(performance.now() - started))
    await Bun.sleep(80)
  }
  await cdp.waitFor(`document.querySelectorAll('.command-palette-results button').length > 10`, 8_000, 16)
  const typingFrames = await stopFrames(cdp)
  const typingTasks = await takeLongTasks(cdp)
  suite.record('⌘K opens and types without a hitch',
    !opened.timedOut && openMs < 250 && slowestKeyMs < 80 && typingTasks.longestMs < 100 && typingFrames.over50 <= 1,
    { openMs, slowestKeyMs, longTasks: typingTasks, frames: typingFrames })

  const results = await cdp.eval(largestScroller('.command-palette-results, .command-palette-results *'))
  await takeLongTasks(cdp)
  await startFrames(cdp)
  if (results != null) {
    await scrollGesture(cdp, results, 2_000, 1_500)
    await scrollGesture(cdp, results, -2_000, 1_500)
  }
  for (let step = 0; step < 30; step += 1) {
    await cdp.key('keyDown', 'ArrowDown', 'ArrowDown', 40)
    await cdp.key('keyUp', 'ArrowDown', 'ArrowDown', 40)
    await Bun.sleep(30)
  }
  const listFrames = await stopFrames(cdp)
  const listTasks = await takeLongTasks(cdp)
  const rendersAfter = (await counters(cdp)).workspaceRenders ?? 0
  suite.record('⌘K results scroll and arrow through smoothly',
    listTasks.longestMs < 100 && listFrames.over50 <= 1,
    { results, longTasks: listTasks, frames: listFrames })
  suite.record('⌘K causes no workspace renders', rendersAfter === rendersBefore,
    { renders: rendersAfter - rendersBefore })
  await cdp.escape()

  suite.record('memory at end', true, await app.memory())
})
