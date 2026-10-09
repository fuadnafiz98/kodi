// ⌘F over a multi-file review finds every match in every file — files the
// viewer has not drawn yet, collapsed ones and folded unchanged lines included
// (Enter opens the fold) — counts them right,
// and moves the viewer to each: opening a collapsed file, landing on the
// deleted row for a match on the old side, wrapping at the end. The count
// follows a rewrite of a file, Escape clears the marks, and flinging with a
// search open stays free of long tasks.
//
// The old build used Chromium's find in page, which only sees the rows the
// viewer has drawn: on this review it counted the first screen's matches and
// never reached file 55.
//
//   bun run build && bun scripts/e2e/review-find.e2e.mjs
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  createRepository, git, largestScroller, launchApp, press, removeLater, runSuite, scrollGesture,
  startFrames, stopFrames, takeLongTasks
} from './harness.mjs'

const FILES = 60
const name = (index) => `src/f${String(index).padStart(2, '0')}.ts`
// File 40's line 6 never changes: it sits in a folded run of unchanged lines.
const original = (index) => Array.from({ length: 60 }, (_unused, line) => {
  if (index === 20 && line === 30) return 'export const removed = "a needle in the old file"\n'
  if (index === 40 && line === 5) return 'export const folded = "a haystack inside a fold"\n'
  return `export const v${index}_${line} = ${line}\n`
}).join('')
const edited = (index, { keepNeedle55 = true } = {}) => original(index).split('\n').map((text, line) => {
  if (line !== 30) return text
  if (index === 3) return 'export const collapsed = "a needle in a collapsed file"'
  if (index === 20) return 'export const removed = "gone"'
  if (index === 55) return keepNeedle55 ? 'export const far = "a needle far below"' : 'export const far = "nothing here now"'
  return `export const v${index}_${line} = ${line} + 1`
}).join('\n')

const deep = (selector) => `(() => {
  const out = []
  const walk = (root) => {
    out.push(...root.querySelectorAll(${JSON.stringify(selector)}))
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot != null) walk(element.shadowRoot)
  }
  walk(document)
  return out
})()`
const COUNT = `(document.querySelector('.find-count')?.textContent ?? null)`
// The current match as painted: its text, row, side, file and whether it is on screen.
const ACTIVE = `(() => {
  const highlight = CSS.highlights.get('kodi-review-find-active')
  if (highlight == null || highlight.size === 0) return null
  const range = [...highlight][0]
  const rect = range.getBoundingClientRect()
  const row = range.startContainer.parentElement?.closest('[data-line]')
  const root = range.startContainer.getRootNode()
  const scroller = ${deep('.multi-file-code-view')}[0]?.getBoundingClientRect()
  return {
    text: range.toString(),
    line: row?.dataset.line ?? null,
    lineType: row?.dataset.lineType ?? null,
    file: root.querySelector?.('[data-diffs-header] [data-title]')?.textContent ?? null,
    onScreen: scroller != null && rect.height > 0 && rect.top >= scroller.top && rect.bottom <= scroller.bottom
  }
})()`
const PAINTED = `(CSS.highlights.get('kodi-review-find')?.size ?? 0) + (CSS.highlights.get('kodi-review-find-active')?.size ?? 0)`

// True once `expression` has held on three reads in a row, 50 ms apart: a mark
// is repainted a frame after the viewer redraws its row, so one read can land
// in between.
const settled = async (cdp, expression, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  let streak = 0
  while (Date.now() < deadline) {
    streak = await cdp.tryEval(expression) ? streak + 1 : 0
    if (streak >= 3) return true
    await Bun.sleep(50)
  }
  return false
}

// What the find controller did over the last two seconds, and the painted
// match a second later: whether a stale mark is being repaired or left alone.
const failureTrace = async (cdp) => {
  const recent = await cdp.eval(`(window.__kodiReviewFindTrace ?? []).filter(([at]) => at > performance.now() - 2_000).slice(-40)`)
  await Bun.sleep(1_000)
  return { recent, activeASecondLater: await cdp.eval(ACTIVE) }
}

await runSuite('review-find', async (suite, cleanup) => {
  const fixture = await createRepository('review-find')
  cleanup(removeLater(fixture))
  for (let index = 0; index < FILES; index += 1) await writeFile(join(fixture, name(index)), original(index))
  await git(fixture, 'add', '-A')
  await git(fixture, 'commit', '--quiet', '-m', 'Sixty files')
  for (let index = 0; index < FILES; index += 1) await writeFile(join(fixture, name(index)), edited(index))

  const app = await launchApp({ folder: fixture, viewport: { width: 1440, height: 900 } })
  cleanup(app.stop)
  const { cdp } = app

  // ── open the review and collapse file 3 ───────────────────────────────────
  const firstRow = `${deep(`[data-item-path="${name(0)}"][data-item-type="file"]`)}[0]`
  await cdp.waitFor(`${firstRow} != null`, 30_000, 16)
  await press(cdp, `${firstRow}.click()`)
  await cdp.waitFor(`${deep('[data-content] [data-line]')}.length > 0`, 30_000, 16)
  await cdp.waitFor(`${deep('[data-diffs-header] [data-title]')}.length >= 1`, 10_000, 16)
  await Bun.sleep(1_500)
  const collapseButton = `${deep(`[data-review-collapse-button][aria-label="Collapse ${name(3)}"]`)}[0]`
  await cdp.eval(`window.__INSTANCE.scrollTo({ type: 'item', id: 'review:${name(3)}', align: 'start', behavior: 'instant' })`)
  const collapseReady = await cdp.waitFor(`${collapseButton} != null`, 10_000, 16)
  if (!collapseReady.timedOut) await press(cdp, `${collapseButton}.click()`)
  const collapsed = await cdp.waitFor(`window.__INSTANCE.getItem('review:${name(3)}')?.collapsed === true`, 5_000, 16)
  suite.record('file 3 is collapsed before the search', !collapsed.timedOut, { buttonFound: !collapseReady.timedOut })
  await cdp.eval(`window.__INSTANCE.scrollTo({ type: 'position', position: 0, behavior: 'instant' })`)
  await Bun.sleep(600)

  // ── ⌘F counts every match, drawn or not ───────────────────────────────────
  await cdp.combo('f', 'KeyF', 70, 4)
  await cdp.waitFor(`document.activeElement === document.querySelector('.find-bar input')`, 8_000, 16)
  // The controller's own log, read back when a step fails (see `failureTrace`).
  await cdp.eval('window.__kodiReviewFindTrace = []; true')
  await cdp.send('Input.insertText', { text: 'needle' })
  const counted = await cdp.waitFor(`${COUNT} === '1/3'`, 5_000, 16)
  suite.record('⌘F counts the matches in every file, drawn or not', !counted.timedOut, { count: await cdp.eval(COUNT) })

  // ── the first match is in the collapsed file: it opens and lands on screen ─
  const first = await settled(cdp, `(() => { const a = ${ACTIVE}; return a != null && a.onScreen && a.file === '${name(3)}' })()`, 5_000)
  suite.record('the first match opens the collapsed file and is on screen', first
    && await cdp.eval(`window.__INSTANCE.getItem('review:${name(3)}')?.collapsed !== true`),
  { active: await cdp.eval(ACTIVE), painted: await cdp.eval(PAINTED) })

  // ── Enter: the deleted row of file 20 ─────────────────────────────────────
  await cdp.enter()
  const second = await settled(cdp, `(() => { const a = ${ACTIVE}; return ${COUNT} === '2/3' && a != null && a.onScreen && a.file === '${name(20)}' })()`, 5_000)
  const secondActive = await cdp.eval(ACTIVE)
  const secondOk = second && secondActive?.lineType === 'change-deletion' && secondActive?.line === '31'
    && secondActive?.text === 'needle'
  suite.record('Enter lands on the match on the old side, in its deleted row', secondOk,
    { count: await cdp.eval(COUNT), active: secondActive, ...(secondOk ? {} : await failureTrace(cdp)) })

  // ── Enter: file 55, far below anything drawn ──────────────────────────────
  await cdp.enter()
  const third = await settled(cdp, `(() => { const a = ${ACTIVE}; return ${COUNT} === '3/3' && a != null && a.onScreen && a.file === '${name(55)}' })()`, 8_000)
  const thirdActive = await cdp.eval(ACTIVE)
  const thirdOk = third && thirdActive?.lineType === 'change-addition' && thirdActive?.line === '31'
  suite.record('Enter reaches a file the viewer had not drawn', thirdOk,
    { count: await cdp.eval(COUNT), active: thirdActive, ...(thirdOk ? {} : await failureTrace(cdp)) })

  // ── Enter wraps; Shift+Enter goes back ────────────────────────────────────
  await cdp.enter()
  const wrapped = await settled(cdp, `(() => { const a = ${ACTIVE}; return ${COUNT} === '1/3' && a != null && a.onScreen && a.file === '${name(3)}' })()`, 8_000)
  await cdp.key('keyDown', 'Enter', 'Enter', 13, 8, '\r')
  await cdp.key('keyUp', 'Enter', 'Enter', 13, 8)
  const back = await settled(cdp, `(() => { const a = ${ACTIVE}; return ${COUNT} === '3/3' && a != null && a.file === '${name(55)}' })()`, 8_000)
  suite.record('Enter wraps to the first match and Shift+Enter goes back', wrapped && back,
    { count: await cdp.eval(COUNT), active: await cdp.eval(ACTIVE) })

  // ── a rewrite that removes a match updates the count ──────────────────────
  const rewriteStarted = performance.now()
  await writeFile(join(fixture, name(55)), edited(55, { keepNeedle55: false }))
  const recounted = await cdp.waitFor(`/\\/2$/.test(${COUNT} ?? '')`, 8_000, 16)
  suite.record('a rewrite that removes a match updates the count', !recounted.timedOut,
    { count: await cdp.eval(COUNT), afterMs: Math.round(performance.now() - rewriteStarted) })

  // ── flinging with a search open stays free of long tasks ──────────────────
  const scroller = await cdp.eval(largestScroller())
  await takeLongTasks(cdp)
  await startFrames(cdp)
  if (scroller != null) {
    await scrollGesture(cdp, scroller, 6_000, 3_000)
    await scrollGesture(cdp, scroller, -6_000, 3_000)
  }
  const frames = await stopFrames(cdp)
  const tasks = await takeLongTasks(cdp)
  suite.record('flinging with a search open has no long task', scroller != null && tasks.longestMs < 50,
    { longTasks: tasks, frames })

  // ── a word only in folded unchanged code: counted, and Enter opens its fold ─
  await cdp.eval(`(() => { const input = document.querySelector('.find-bar input'); input.focus(); input.select(); return true })()`)
  await cdp.send('Input.insertText', { text: 'haystack' })
  const foldCounted = await cdp.waitFor(`${COUNT} === '1/1'`, 5_000, 16)
  const foldShown = await settled(cdp, `(() => { const a = ${ACTIVE}; return a != null && a.onScreen && a.file === '${name(40)}' && a.line === '6' })()`, 8_000)
  suite.record('a match in folded unchanged code is counted and its fold opens on it', !foldCounted.timedOut && foldShown,
    { count: await cdp.eval(COUNT), active: await cdp.eval(ACTIVE), ...(foldShown ? {} : await failureTrace(cdp)),
      ...(foldShown ? {} : { item: await cdp.eval(`(() => { const r = window.__INSTANCE.idToItem?.get('review:${name(40)}'); const i = r?.instance; return { found: r != null, partial: i?.fileDiff?.isPartial ?? null, load: typeof i?.loadFilesIfNecessary, reveal: typeof i?.revealLine, top: window.__INSTANCE.getTopForItem('review:${name(40)}'), pending: i?.pendingExpansions ?? null, hunks: i?.fileDiff?.hunks?.map((h) => [h.additionStart, h.additionCount, h.collapsedBefore]), expanded: [...(i?.hunksRenderer?.getExpandedHunksMap?.() ?? new Map()).entries()], expandUnchanged: i?.options?.expandUnchanged, threshold: i?.options?.collapsedContextThreshold, scrollTop: window.__INSTANCE.root?.scrollTop, trace: (window.__kodiReviewFindTrace ?? []).filter((e) => e[1] !== 'paint').slice(-12) } })()`) }) })

  // ── Escape clears every mark ──────────────────────────────────────────────
  await cdp.escape()
  const cleared = await cdp.waitFor(`${PAINTED} === 0 && document.querySelector('.find-bar[data-open]') == null`, 3_000, 16)
  suite.record('Escape closes find and clears every mark', !cleared.timedOut, { painted: await cdp.eval(PAINTED) })

  suite.record('memory at end', true, await app.memory())
})
