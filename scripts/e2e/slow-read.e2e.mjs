// Reading a review slowly, line by line, must move like butter: short pulls,
// a steady slow pull, wheel notches. The `smoothness` suite flings at
// 3,000 px/s and samples frames from requestAnimationFrame, which cannot see
// the compositor; this one reads what the reader sees on a slow read.
//
// The old build scrolled every slow read on the main thread: a non-passive
// `wheel` listener over the diff panel (the code zoom gesture) made Chromium
// wait for the main thread on every pull, and each main frame past the
// refresh deadline was a frame in which the text did not move — 15% of the
// frames of a stop-and-go read on PR 813, every pull starting 1–2 frames late.
// The viewer also flipped `pointer-events` on the whole rendered review twice
// per pull.
//
//   Structural checks (hidden or visible): no blocking wheel listener over
//   the review; the viewer leaves pointer-events alone; a swipe whose first
//   wheel event leans a pixel sideways still scrolls; ctrl+wheel and pinch
//   still zoom the code, and only the code.
//   Compositor checks (KODI_E2E_VISIBLE=1 only — a hidden window never
//   paints): a slow read scrolls on the compositor thread with ≤ 1% late
//   frames; each pull starts moving within a frame; a slow pull never fights
//   the reader; layout reads per moving frame (recorded); a 4,000 px/s fling
//   never shows rows the viewer has not drawn yet.
//
//   bun run build && KODI_E2E_VISIBLE=1 bun scripts/e2e/slow-read.e2e.mjs
//
// On a real review (a copy of a repository and of a profile, never the real one):
//   KODI_E2E_SLOWREAD_FOLDER=<copy of a repository>
//   KODI_E2E_SLOWREAD_PROFILE=<copy of ~/Library/Application Support/kodi without Cookies>
//   KODI_E2E_SLOWREAD_URL=<pull request URL>   optional, opened through a second launch
import { mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  blockingWheelListeners, counters, createRepository, git, launchApp, openInRunningApp, removeLater,
  runSuite, startCompositorTrace, startFrames, stopCompositorTrace, stopFrames, summarizeScrollFrames,
  takeLongTasks
} from './harness.mjs'

const VISIBLE = process.env.KODI_E2E_VISIBLE === '1'
const REAL_FOLDER = process.env.KODI_E2E_SLOWREAD_FOLDER ?? null
const REAL_PROFILE = process.env.KODI_E2E_SLOWREAD_PROFILE ?? null
const REAL_URL = process.env.KODI_E2E_SLOWREAD_URL ?? null
const USER_PROFILE = join(homedir(), 'Library/Application Support/kodi')

// The reader's display preferences: word wrap is what makes rows measure.
const PREFERENCES = { codeFontSize: 13, codeLineHeight: 20, showLineNumbers: true, wordWrap: true, foldUnchanged: true }

// Budgets.
const LATE_PERCENT = 1
const MIN_OVERFLOW_PX = 40_000
const SKIPPED = { ok: true, skipped: 'hidden window never paints' }

const FILES = 30
const longLine = (file, line) => `  const description${line} = '${`file ${file} line ${line} carries a long string that wraps in the review `.repeat(3).trim()}'\n`
const fileSource = (file, edited) => {
  const lines = 300 + ((file * 137) % 600)
  let text = `// read ${file}\n`
  for (let line = 0; line < lines; line += 1) {
    if (line % 7 === 3) text += longLine(file, line)
    else if (edited && line % 4 === 0) text += `export const value${line} = compute(${line}, 'edited ${file}')\n`
    else text += `export const value${line} = compute(${line}, 'original')\n`
  }
  return text
}
const fileName = (file) => `src/read${String(file).padStart(2, '0')}.ts`

// The review's scroller and the rendered line under a point, through shadow roots.
const REVIEW_ROOT = `(() => {
  const walk = (root) => {
    const found = root.querySelector('.multi-file-code-view')
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
const lineAt = (x, y) => `(() => {
  let root = document
  let element = null
  for (let depth = 0; depth < 12; depth += 1) {
    const next = root.elementFromPoint(${x}, ${y})
    if (next == null || next === element) break
    element = next
    if (element.shadowRoot == null) break
    root = element.shadowRoot
  }
  const line = element?.closest?.('[data-line]')
  if (line == null) return null
  return { line: Number(line.dataset.line), text: line.textContent.slice(0, 80), fontSize: getComputedStyle(line).fontSize }
})()`
const FIRST_LINE_FONT = `(() => {
  const walk = (root) => {
    const found = root.querySelector('[data-line]')
    if (found != null) return found
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot == null) continue
      const inner = walk(element.shadowRoot)
      if (inner != null) return inner
    }
    return null
  }
  const line = walk(document)
  return line == null ? null : parseFloat(getComputedStyle(line).fontSize)
})()`

// Instrumentation, armed per check and torn down after it. `root.scrollTop`
// only: the viewer's getScrollTop() consumes its pending scroll state.
const INSTALL_PROBE = `(() => {
  const root = ${REVIEW_ROOT}
  const instance = window.__INSTANCE ?? null
  if (root == null) return null
  const probe = window.__slowRead = { root, instance, running: false }
  const originalScrollTo = root.scrollTo
  const originalRect = Element.prototype.getBoundingClientRect
  const onWheel = (event) => { if (probe.running) probe.wheel.push(event.timeStamp) }
  let observer = null
  probe.arm = ({ sample = true } = {}) => {
    Object.assign(probe, { running: true, samples: [], wheel: [], scrollToCalls: 0, rects: 0, flips: 0 })
    root.scrollTo = function (...args) { probe.scrollToCalls += 1; return originalScrollTo.apply(this, args) }
    Element.prototype.getBoundingClientRect = function () { probe.rects += 1; return originalRect.call(this) }
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    const sticky = instance?.stickyContainer ?? null
    let last = sticky?.style.pointerEvents ?? ''
    if (sticky != null) {
      observer = new MutationObserver(() => {
        const value = sticky.style.pointerEvents
        if (value !== last) { last = value; probe.flips += 1 }
      })
      observer.observe(sticky, { attributes: true, attributeFilter: ['style'] })
    }
    if (!sample) return
    const tick = (time) => {
      if (!probe.running) return
      probe.samples.push([time, root.scrollTop])
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }
  probe.disarm = () => {
    probe.running = false
    delete root.scrollTo
    if (root.scrollTo !== originalScrollTo) root.scrollTo = originalScrollTo
    Element.prototype.getBoundingClientRect = originalRect
    window.removeEventListener('wheel', onWheel, { capture: true })
    observer?.disconnect()
    observer = null
    const samples = probe.samples
    const deltas = []
    for (let index = 1; index < samples.length; index += 1) deltas.push(samples[index][1] - samples[index - 1][1])
    const frameMs = samples.slice(1).map(([time], index) => time - samples[index][0]).sort((a, b) => a - b)
    const refreshMs = frameMs.length === 0 ? 16.7 : frameMs[Math.floor(frameMs.length / 2)]
    const frameP95Ms = frameMs.length === 0 ? 0 : frameMs[Math.min(frameMs.length - 1, Math.floor(frameMs.length * 0.95))]
    // Bursts: wheel events more than 150 ms apart start a new one. A burst's
    // latency is its first event to the first frame that moved.
    const bursts = []
    for (const time of probe.wheel) {
      const last = bursts.at(-1)
      if (last == null || time - last.last > 150) bursts.push({ first: time, last: time })
      else last.last = time
    }
    const latencies = []
    for (const burst of bursts) {
      let index = samples.findIndex(([time]) => time >= burst.first)
      if (index < 1) continue
      for (; index < samples.length; index += 1) {
        if (samples[index][1] !== samples[index - 1][1]) { latencies.push(Math.round((samples[index][0] - burst.first) * 10) / 10); break }
      }
    }
    latencies.sort((a, b) => a - b)
    const quantile = (values, q) => values.length === 0 ? null : values[Math.min(values.length - 1, Math.floor(values.length * q))]
    // A stall is a frame that did not move although input arrived within the
    // two frames before it. A synthetic gesture pauses its own input now and
    // then; a frame with no input behind it is not the app's.
    let stalls = 0
    let wheelIndex = 0
    for (let index = 1; index < samples.length; index += 1) {
      const [time] = samples[index]
      while (wheelIndex < probe.wheel.length && probe.wheel[wheelIndex] < time - 2 * refreshMs) wheelIndex += 1
      const inputBehind = wheelIndex < probe.wheel.length && probe.wheel[wheelIndex] <= time - refreshMs * 0.5
      if (inputBehind && deltas[index - 1] === 0) stalls += 1
    }
    const movingFrames = deltas.filter((delta) => delta !== 0).length
    return {
      frames: deltas.length, movingFrames, refreshMs: Math.round(refreshMs * 10) / 10, frameP95Ms: Math.round(frameP95Ms * 10) / 10,
      backwardsFrames: deltas.filter((delta) => delta < 0).length, stalls,
      bursts: bursts.length, burstP50Ms: quantile(latencies, 0.5), burstP95Ms: quantile(latencies, 0.95), burstMaxMs: latencies.at(-1) ?? null,
      wheelEvents: probe.wheel.length, scrollToCalls: probe.scrollToCalls, pointerEventsFlips: probe.flips,
      rectsPerMovingFrame: movingFrames === 0 ? null : Math.round((probe.rects / movingFrames) * 10) / 10,
      travelled: Math.round((samples.at(-1)?.[1] ?? 0) - (samples[0]?.[1] ?? 0))
    }
  }
  return { instanceIsReview: instance?.root === root, pointerEventsDisabledOnScroll: instance?.shouldDisablePointerEvents?.() ?? null }
})()`

await runSuite('slow-read', async (suite, cleanup) => {
  if (REAL_FOLDER != null && REAL_PROFILE == null) throw new Error('KODI_E2E_SLOWREAD_FOLDER needs KODI_E2E_SLOWREAD_PROFILE (a copy of a Kodi profile).')
  if (REAL_PROFILE != null && resolve(REAL_PROFILE) === resolve(USER_PROFILE)) throw new Error('KODI_E2E_SLOWREAD_PROFILE is the real profile; pass a copy.')

  let folder = REAL_FOLDER
  let profile = REAL_PROFILE
  if (folder == null) {
    folder = await createRepository('slow-read')
    cleanup(removeLater(folder))
    for (let file = 0; file < FILES; file += 1) await writeFile(join(folder, fileName(file)), fileSource(file, false))
    await git(folder, 'add', '-A')
    await git(folder, 'commit', '--quiet', '-m', 'Files to read')
    for (let file = 0; file < FILES; file += 1) await writeFile(join(folder, fileName(file)), fileSource(file, true))
    // Preferences are seeded through a first launch on the same profile.
    profile = await mkdtemp(join(tmpdir(), 'kodi-e2e-slowread-profile-'))
    cleanup(removeLater(profile))
    const seeding = await launchApp({ folder, profile })
    try {
      await seeding.cdp.waitFor(`document.querySelector('#repository-explorer') != null || document.querySelector('.multi-file-code-view') != null`, 30_000, 50)
      await seeding.cdp.eval(`(() => {
        const key = 'kodi:preferences:v1'
        const current = JSON.parse(localStorage.getItem(key) ?? '{}')
        localStorage.setItem(key, JSON.stringify({ ...current, ...${JSON.stringify(PREFERENCES)} }))
      })()`)
      await Bun.sleep(300)
    } finally {
      await seeding.stop()
    }
  }

  const app = await launchApp({ folder, profile, viewport: { width: 1600, height: 1000 } })
  cleanup(app.stop)
  const { cdp } = app

  // ── open the review ───────────────────────────────────────────────────────
  if (REAL_URL != null) {
    await cdp.waitFor(`document.querySelector('#repository-explorer, .multi-file-code-view, .workspace') != null`, 40_000, 50)
    await Bun.sleep(1_500)
    await openInRunningApp(profile, [`--kodi-url=${REAL_URL}`])
  } else if (REAL_FOLDER == null) {
    const row = `(() => {
      const walk = (root) => {
        const found = root.querySelector('[data-item-path="${fileName(0)}"][data-item-type="file"]')
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
    await cdp.waitFor(`${row} != null`, 30_000, 16)
    await cdp.eval(`${row}.click()`)
  }
  const opened = await cdp.waitFor(`(() => { const root = ${REVIEW_ROOT}; return root != null && root.scrollHeight - root.clientHeight > 2000 && window.__INSTANCE != null })()`, 90_000, 50)
  if (opened.timedOut) throw new Error('The review never opened with something to scroll.')
  // Let the review finish streaming in: the overflow stops growing.
  let lastOverflow = -1
  let stableSince = Date.now()
  const settleDeadline = Date.now() + 60_000
  while (Date.now() - stableSince < 2_500 && Date.now() < settleDeadline) {
    const overflow = await cdp.tryEval(`(() => { const root = ${REVIEW_ROOT}; return root == null ? -1 : root.scrollHeight - root.clientHeight })()`) ?? -1
    if (overflow !== lastOverflow) { lastOverflow = overflow; stableSince = Date.now() }
    await Bun.sleep(250)
  }
  const scroller = await cdp.eval(`(() => {
    const root = ${REVIEW_ROOT}
    const rect = root.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), overflow: root.scrollHeight - root.clientHeight, height: root.clientHeight }
  })()`)
  const probeInfo = await cdp.eval(INSTALL_PROBE)
  const mode = REAL_URL != null ? 'url' : REAL_FOLDER != null ? 'folder' : 'fixture'
  console.log('review', JSON.stringify({ mode, visible: VISIBLE, scroller, ...probeInfo }))
  if (mode === 'fixture' && VISIBLE) {
    suite.record('the fixture review is long enough to read', scroller.overflow >= MIN_OVERFLOW_PX, { overflow: scroller.overflow, minimum: MIN_OVERFLOW_PX })
  }

  const toTop = async () => {
    await cdp.eval('window.__slowRead.root.scrollTop = 0')
    await Bun.sleep(900)
  }
  const wheel = (deltaY, modifiers = 0) => cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: scroller.x, y: scroller.y, deltaX: 0, deltaY, modifiers, pointerType: 'mouse'
  })
  const pull = (distance, speed) => cdp.send('Input.synthesizeScrollGesture', {
    x: scroller.x, y: scroller.y, yDistance: -distance, speed, gestureSourceType: 'mouse', repeatCount: 1, preventFling: true
  }, 120_000)
  const stopAndGo = async (pulls) => {
    for (let index = 0; index < pulls; index += 1) {
      await pull(120, 400)
      await Bun.sleep(350)
    }
  }
  const measured = async (run, { sample = true } = {}) => {
    await takeLongTasks(cdp)
    const before = await counters(cdp)
    await cdp.eval(`window.__slowRead.arm({ sample: ${sample} })`)
    await startFrames(cdp)
    await run()
    await Bun.sleep(300)
    const frames = await stopFrames(cdp)
    const motion = await cdp.eval('window.__slowRead.disarm()')
    const longTasks = await takeLongTasks(cdp)
    const after = await counters(cdp)
    const autoHydrations = (after.autoHydrations ?? 0) - (before.autoHydrations ?? 0)
    return { frames, motion, longTasks, autoHydrations }
  }

  // ── 1. nothing over the review may block a wheel event ────────────────────
  const blocking = await blockingWheelListeners(cdp, REVIEW_ROOT)
  suite.record('no blocking wheel listener over the review', blocking != null && blocking.length === 0, { blocking })

  // ── 2. the viewer leaves pointer-events alone while scrolling ─────────────
  await toTop()
  const notches = await measured(async () => {
    for (let index = 0; index < 12; index += 1) {
      await wheel(100)
      await Bun.sleep(120)
    }
  }, { sample: false })
  suite.record('the viewer leaves pointer-events alone while scrolling',
    probeInfo.pointerEventsDisabledOnScroll === false && notches.motion.pointerEventsFlips === 0,
    { pointerEventsDisabledOnScroll: probeInfo.pointerEventsDisabledOnScroll, flips: notches.motion.pointerEventsFlips,
      styleRecalcs: notches.frames.styleRecalcs, taskMs: notches.frames.taskMs })

  // ── 2b. a swipe that starts a pixel sideways still scrolls ────────────────
  // A trackpad swipe often leans sideways in its first event (-2/3, -1/1).
  // Chromium latches the whole gesture to the first scroller on the path that
  // can take that event or stops chaining (overscroll-behavior), and the
  // library's code column is both an overflow-x scroller and
  // overscroll-behavior-x: none: the old build moved 0 px for the whole swipe,
  // and the reader's next, straighter swipe did — "stuck, needs a push".
  const diagonal = []
  for (const deltaX of [-2, -1, 2]) {
    await toTop()
    await cdp.eval('window.__slowRead.root.scrollTop = 400')
    await Bun.sleep(300)
    const before = await cdp.eval('window.__slowRead.root.scrollTop')
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: scroller.x, y: scroller.y, deltaX, deltaY: 3, pointerType: 'mouse' })
    for (let index = 0; index < 12; index += 1) {
      await Bun.sleep(16)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: scroller.x, y: scroller.y, deltaX: Math.sign(deltaX), deltaY: 10, pointerType: 'mouse' })
    }
    await Bun.sleep(400)
    diagonal.push({ firstDeltaX: deltaX, wheelPx: 123, movedPx: Math.round(await cdp.eval('window.__slowRead.root.scrollTop') - before) })
  }
  const codeColumn = await cdp.eval(`(() => {
    const walk = (root) => { const found = root.querySelector('[data-code]'); if (found != null) return found; for (const element of root.querySelectorAll('*')) { if (element.shadowRoot == null) continue; const inner = walk(element.shadowRoot); if (inner != null) return inner } return null }
    const code = walk(window.__slowRead.root)
    return code == null ? null : getComputedStyle(code).overscrollBehaviorX
  })()`)
  suite.record('a swipe that starts a pixel sideways still scrolls', diagonal.every((run) => run.movedPx >= 100), { codeOverscrollBehaviorX: codeColumn, diagonal })

  // ── 4. a slow read scrolls on the compositor thread ───────────────────────
  if (VISIBLE) {
    const traced = {}
    for (const [name, run] of [['pull 600 px at 150 px/s', () => pull(600, 150)], ['stop and go 10 × 120 px', () => stopAndGo(10)]]) {
      await toTop()
      await startCompositorTrace(cdp)
      await run()
      await Bun.sleep(300)
      traced[name] = summarizeScrollFrames(await stopCompositorTrace(cdp))
    }
    const runs = Object.values(traced)
    suite.record('a slow read scrolls on the compositor thread',
      runs.every((run) => run.scrollFrames > 100 && run.mainThreadPercent === 0 && run.latePercent <= LATE_PERCENT),
      { budget: { mainThreadPercent: 0, latePercent: LATE_PERCENT }, ...traced })
  } else {
    suite.record('a slow read scrolls on the compositor thread', SKIPPED.ok, SKIPPED)
  }

  // ── 5. every pull starts moving within a frame ────────────────────────────
  if (VISIBLE) {
    await toTop()
    const pulls = await measured(() => stopAndGo(12))
    const budgetMs = Math.max(9, pulls.motion.refreshMs + 1)
    suite.record('every pull starts moving within a frame',
      pulls.motion.bursts >= 10 && pulls.motion.burstP95Ms != null && pulls.motion.burstP95Ms <= budgetMs,
      { budgetMs, ...pulls.motion, taskMs: pulls.frames.taskMs, styleRecalcs: pulls.frames.styleRecalcs, layouts: pulls.frames.layouts })
  } else {
    suite.record('every pull starts moving within a frame', SKIPPED.ok, SKIPPED)
  }

  // ── 6. a slow pull never fights the reader; 7. layout reads (recorded) ────
  if (VISIBLE) {
    await toTop()
    const slow = await measured(() => pull(900, 150))
    const { motion } = slow
    // Stalls are sampled from requestAnimationFrame and only guard against a
    // gross regression; the compositor trace above is what judges smoothness.
    suite.record('a slow pull never fights the reader',
      motion.movingFrames > 200 && motion.backwardsFrames === 0 && motion.scrollToCalls === 0 && motion.stalls <= Math.max(2, motion.movingFrames * 0.01)
        && slow.longTasks.longestMs < 50 && slow.autoHydrations === 0 && motion.frameP95Ms <= motion.refreshMs * 1.5,
      { ...motion, longTasks: slow.longTasks, autoHydrations: slow.autoHydrations, frames: slow.frames })
    suite.record('layout reads per moving frame (recorded)', true, { rectsPerMovingFrame: motion.rectsPerMovingFrame, layouts: slow.frames.layouts })
  } else {
    suite.record('a slow pull never fights the reader', SKIPPED.ok, SKIPPED)
    suite.record('layout reads per moving frame (recorded)', SKIPPED.ok, SKIPPED)
  }

  // ── 8. a fast fling never shows rows that are not drawn yet ───────────────
  // The compositor scrolls ahead of the main thread, so the rows the viewer
  // draws past the viewport have to cover a fling's lead. With 200 px of them
  // a 4,000 px/s fling showed ~160-300 px of blank rows at the bottom.
  if (VISIBLE) {
    await toTop()
    await cdp.eval(`(() => {
      const root = window.__slowRead.root
      let roots = []
      let age = 0
      const lead = window.__slowReadLead = { running: true, min: Infinity, frames: 0 }
      const tick = () => {
        if (!lead.running) return
        if (age++ % 10 === 0) roots = [...root.querySelectorAll('*')].filter((element) => element.shadowRoot != null).map((element) => element.shadowRoot)
        const bottom = root.getBoundingClientRect().bottom
        let drawn = -Infinity
        for (const shadow of roots) {
          const lines = shadow.querySelectorAll('[data-content] [data-line]')
          const last = lines[lines.length - 1]
          if (last != null) drawn = Math.max(drawn, last.getBoundingClientRect().bottom)
        }
        if (age > 10 && Number.isFinite(drawn) && root.scrollTop + root.clientHeight < root.scrollHeight - 2) lead.min = Math.min(lead.min, drawn - bottom)
        lead.frames += 1
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })()`)
    await pull(Math.min(6_000, scroller.overflow - 100), 4_000)
    await Bun.sleep(300)
    const lead = await cdp.eval('(() => { const lead = window.__slowReadLead; lead.running = false; return { minLeadPx: Math.round(lead.min), frames: lead.frames } })()')
    suite.record('a fast fling never shows rows that are not drawn yet', lead.minLeadPx >= 0, lead)
  } else {
    suite.record('a fast fling never shows rows that are not drawn yet', SKIPPED.ok, SKIPPED)
  }

  // ── 3. ctrl+wheel and pinch still zoom the code, and only the code ────────
  // Last: it leaves the code zoomed.
  await cdp.eval(`window.__slowRead.root.scrollTop = Math.round(window.__slowRead.root.scrollHeight * 0.2)`)
  await Bun.sleep(1_200)
  const page = () => cdp.eval('({ devicePixelRatio: window.devicePixelRatio, visualScale: window.visualViewport?.scale ?? 1 })')
  const pageBefore = await page()
  const fontBefore = await cdp.eval(FIRST_LINE_FONT)
  const lineBefore = await cdp.eval(lineAt(scroller.x, scroller.y))
  for (let index = 0; index < 3; index += 1) {
    await wheel(-10, 2)
    await Bun.sleep(30)
  }
  await Bun.sleep(1_500)
  const fontAfterWheel = await cdp.eval(FIRST_LINE_FONT)
  const lineAfterWheel = await cdp.eval(lineAt(scroller.x, scroller.y))
  const pageAfterWheel = await page()
  await cdp.send('Input.synthesizePinchGesture', { x: scroller.x, y: scroller.y, scaleFactor: 0.8, relativeSpeed: 400, gestureSourceType: 'mouse' }, 30_000)
  await Bun.sleep(1_500)
  const fontAfterPinch = await cdp.eval(FIRST_LINE_FONT)
  const pageAfterPinch = await page()
  const samePage = (other) => other.devicePixelRatio === pageBefore.devicePixelRatio && other.visualScale === pageBefore.visualScale
  // Which line stays under the pointer is recorded, not gated: deep in a long
  // review the zoom's proportional anchor already missed before this suite.
  suite.record('ctrl+wheel and pinch still zoom the code, and only the code',
    fontAfterWheel > fontBefore && fontAfterPinch < fontAfterWheel && samePage(pageAfterWheel) && samePage(pageAfterPinch),
    { fontBefore, fontAfterWheel, fontAfterPinch, pageBefore, pageAfterWheel, pageAfterPinch, lineBefore, lineAfterWheel })

  suite.record('memory at end', true, await app.memory())
})
