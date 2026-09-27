// A long session must feel the same in its last hour as in its first minute.
// Cycles the things a reader does all day — ⌘K and open a file, click through
// changed files, scroll the review, open Source Control, let the watcher tick,
// sit idle — and fails when the late part of the run is worse than the start:
// more frame hitches, a freeze, a heap or DOM or listener count that keeps
// climbing after GC.
//
//   bun run build && bun run e2e soak                          # 3 minutes
//   KODI_E2E_SOAK_MINUTES=240 bun scripts/e2e/soak.e2e.mjs     # four hours
//
// Options:
//   KODI_E2E_SOAK_FOLDER   repository to use (a *copy* — the soak writes files
//                          into it); default a generated one with 80 changes.
//   KODI_E2E_SOAK_PROFILE  a profile directory to start from (copied first),
//                          e.g. a copy of the real one, for real tabs/settings.
//   KODI_E2E_SOAK_LOG      JSONL file each cycle is appended to as it lands,
//                          so a multi-hour run can be watched while it runs.
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  counters, createRepository, git, launchApp, press, removeLater, runSuite,
  scrollGesture, startFrames, stopFrames, takeLongTasks, writeTree
} from './harness.mjs'

const MINUTES = Number(process.env.KODI_E2E_SOAK_MINUTES ?? 3)
const LOG = process.env.KODI_E2E_SOAK_LOG ?? null
// Budgets for the verdict. A freeze is any single task this long; growth is
// measured after a forced GC, late window against early window.
const FREEZE_MS = 250
const HEAP_GROWTH_MB = 60
const LISTENER_GROWTH = 3_000
const DOM_GROWTH = 8_000
// Hitches per cycle may rise a little by chance; a real degradation is several.
const HITCH_RATE_SLACK = 1.0
const QUERIES = ['src', 'app', 'index', 'test', 'ts', 'main', 'util', 'view', 'git', 'swift', 'json', 'md']

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

const deepAll = (selector) => `(() => {
  const found = []
  const walk = (root) => {
    found.push(...root.querySelectorAll(${JSON.stringify(selector)}))
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot != null) walk(element.shadowRoot)
  }
  walk(document)
  return found
})()`

// Whether the review shows this file's section where a jump puts it: its header
// at the top, or — a short file at the end of the list, which cannot scroll that
// far — on screen with the list scrolled to its end.
const reviewShows = (path) => `(() => {
  const scroller = document.querySelector('.multi-file-code-view')
  if (scroller == null) return false
  const top = scroller.getBoundingClientRect().top
  const found = []
  const walk = (root) => {
    for (const title of root.querySelectorAll('[data-diffs-header] [data-title]')) found.push(title)
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot != null) walk(element.shadowRoot)
  }
  walk(document)
  const atEnd = scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 2
  return found.some((title) => {
    if (title.textContent !== ${JSON.stringify(path)}) return false
    const y = title.getBoundingClientRect().top - top
    return y > -8 && (y < 64 || (atEnd && y < scroller.clientHeight))
  })
})()`

// The review (or the file view) under the pointer: whichever scrolls most.
const mainScroller = `(() => {
  const review = document.querySelector('.multi-file-code-view')
  const candidates = review != null ? [review] : [...document.querySelectorAll('main *, .workspace *')]
  let best = null
  for (const element of candidates) {
    const overflow = element.scrollHeight - element.clientHeight
    if (overflow < 300 || element.clientHeight < 200) continue
    if (!/(auto|scroll)/.test(getComputedStyle(element).overflowY)) continue
    if (best == null || overflow > best.overflow) best = { element, overflow }
  }
  if (best == null) return null
  const rect = best.element.getBoundingClientRect()
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
})()`

async function buildFixture() {
  const root = await createRepository('soak')
  await writeTree(root, 'pkg', { top: 8, sub: 10, files: 4, contents: (c) => `export const v = ${c}\n`.repeat(120) })
  await git(root, 'add', '-A')
  await git(root, 'commit', '--quiet', '-m', 'Package')
  for (let a = 0; a < 8; a += 1) {
    for (let b = 0; b < 10; b += 1) {
      await writeFile(join(root, 'pkg', `m${a}`, `s${b}`, 'f0.ts'),
        Array.from({ length: 120 }, (_unused, line) => `export const v${line} = ${line % 5 === 0 ? 'edited' : 0}\n`).join(''))
    }
  }
  return root
}

function windowStats(rows) {
  const hitches = rows.reduce((sum, row) => sum + row.hitches, 0)
  return {
    cycles: rows.length,
    hitchesPerCycle: rows.length === 0 ? 0 : Math.round((hitches / rows.length) * 100) / 100,
    longestTaskMs: Math.max(0, ...rows.map((row) => row.longestTaskMs)),
    worstFrameMs: Math.max(0, ...rows.map((row) => row.maxFrameMs))
  }
}

await runSuite('soak', async (suite, cleanup) => {
  const folder = process.env.KODI_E2E_SOAK_FOLDER ?? await buildFixture()
  if (process.env.KODI_E2E_SOAK_FOLDER == null) cleanup(removeLater(folder))
  let profile = null
  if (process.env.KODI_E2E_SOAK_PROFILE != null) {
    profile = join(tmpdir(), `kodi-e2e-soak-profile-${process.pid}`)
    Bun.spawnSync(['rm', '-rf', profile])
    Bun.spawnSync(['cp', '-R', process.env.KODI_E2E_SOAK_PROFILE, profile])
    cleanup(removeLater(profile))
  }
  const scratchDirectory = join(folder, '.kodi-soak')
  await mkdir(scratchDirectory, { recursive: true })

  const app = await launchApp({ folder, profile })
  cleanup(app.stop)
  const { cdp } = app
  await cdp.waitFor(`document.querySelector('.sidebar-file-count') != null`, 60_000, 16)
  await Bun.sleep(3_000)

  const rows = []
  const memorySamples = []
  const picks = []
  const deadline = Date.now() + MINUTES * 60_000
  const log = async (entry) => {
    if (LOG != null) await appendFile(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  }

  const actions = {
    // ⌘K, a query, a result, and a read of what it opened.
    async palette(cycle) {
      await cdp.combo('k', 'KeyK', 75, 4)
      await cdp.waitFor(`document.activeElement === document.querySelector('#command-palette-input')`, 8_000, 4)
      for (const character of QUERIES[cycle % QUERIES.length]) {
        await cdp.send('Input.insertText', { text: character })
        await Bun.sleep(45)
      }
      await cdp.waitFor(`document.querySelectorAll('.command-palette-results button').length > 0`, 5_000, 16)
      for (let step = 0; step < cycle % 6; step += 1) {
        await cdp.key('keyDown', 'ArrowDown', 'ArrowDown', 40)
        await cdp.key('keyUp', 'ArrowDown', 'ArrowDown', 40)
        await Bun.sleep(30)
      }
      // What Enter should open. A file row's second line is its path; a command's
      // is a sentence, and a folder row keeps the palette up to drill into it.
      const picked = await cdp.tryEval(`document.querySelector('.command-palette-results button.primary-result small')?.textContent ?? null`)
      await cdp.enter()
      await Bun.sleep(150)
      const drilled = await cdp.tryEval(`document.querySelector('#command-palette-input') != null`)
      if (!drilled && typeof picked === 'string' && /^[^\s]+$/.test(picked)) {
        const opened = await cdp.waitFor(`document.querySelector('#command-palette-input') == null && (
          ${reviewShows(picked)}
          || document.querySelector('.diff-file-title')?.getAttribute('title') === ${JSON.stringify(picked)}
          || document.querySelector('.editor-breadcrumbs')?.textContent.replaceAll('›', '/') === ${JSON.stringify(picked)})`,
        3_000, 50).then((result) => !result.timedOut, () => false)
        picks.push({ cycle, path: picked, opened })
      }
      if (await cdp.tryEval(`document.querySelector('#command-palette-input') != null`)) await cdp.escape()
      await Bun.sleep(600)
      await actions.scroll(cycle)
    },
    // Click through the changed files the way a reviewer does.
    async tree(cycle) {
      const count = await cdp.tryEval(`${deepAll('[data-item-type="file"][data-item-git-status]')}.length`) ?? 0
      if (count > 0) {
        await press(cdp, `${deepAll('[data-item-type="file"][data-item-git-status]')}[${cycle % count}].click()`)
        await Bun.sleep(600)
      }
      await actions.scroll(cycle)
    },
    async scroll(cycle) {
      const box = await cdp.tryEval(mainScroller)
      if (box == null) return
      const distance = 2_500 + (cycle % 4) * 1_500
      await scrollGesture(cdp, box, distance, 3_500)
      await scrollGesture(cdp, box, -distance, 3_500)
    },
    // A save and a new file elsewhere: the watcher ticks while the reader reads.
    async watcher(cycle) {
      await writeFile(join(scratchDirectory, `note-${cycle % 7}.md`), `# soak ${cycle}\n`)
      await Bun.sleep(1_200)
      await actions.scroll(cycle)
    },
    async sourceControl() {
      const button = `document.querySelector('.source-control-titlebar-button')`
      if (!await cdp.tryEval(`${button} != null`)) return
      await press(cdp, `${button}.click()`)
      await Bun.sleep(700)
      await press(cdp, `${button}.click()`)
      await Bun.sleep(300)
    },
    // Nothing at all: a freeze here is the "freezes from time to time" kind.
    async idle() {
      await Bun.sleep(2_500)
    }
  }
  const schedule = ['palette', 'tree', 'watcher', 'palette', 'idle', 'tree', 'sourceControl', 'scroll']

  for (let cycle = 0; Date.now() < deadline; cycle += 1) {
    const action = schedule[cycle % schedule.length]
    await takeLongTasks(cdp)
    const countersBefore = await counters(cdp)
    await startFrames(cdp)
    let error = null
    try {
      await actions[action](cycle)
    } catch (caught) {
      error = caught.message
    }
    await cdp.escape().catch(() => {})
    const frames = await stopFrames(cdp).catch(() => ({ over50: 0, maxMs: 0, frames: 0, p95Ms: 0 }))
    const tasks = await takeLongTasks(cdp)
    const countersAfter = await counters(cdp)
    const moved = Object.fromEntries(Object.keys(countersAfter)
      .map((name) => [name, (countersAfter[name] ?? 0) - (countersBefore[name] ?? 0)])
      .filter(([, delta]) => delta !== 0))
    const row = {
      cycle,
      action,
      hitches: frames.over50,
      maxFrameMs: frames.maxMs,
      p95FrameMs: frames.p95Ms,
      longestTaskMs: tasks.longestMs,
      longTaskTotalMs: tasks.totalMs,
      scriptMs: frames.scriptMs ?? null,
      counters: moved,
      ...(moved.reviewPagedFallbacks == null ? {} : {
        fallbackReason: await cdp.tryEval('window.__kodiLastReason?.reviewPagedFallbacks ?? null')
      }),
      ...(error == null ? {} : { error })
    }
    rows.push(row)
    if (cycle % 10 === 0) {
      const memory = await app.memory()
      memorySamples.push({ cycle, ...memory })
      await log({ kind: 'memory', cycle, ...memory })
    }
    await log({ kind: 'cycle', ...row })
    if (!await cdp.tryEval('true')) {
      suite.record('renderer still answers', false, { cycle })
      break
    }
  }

  const slice = Math.max(1, Math.floor(rows.length / 5))
  const early = windowStats(rows.slice(0, slice))
  const late = windowStats(rows.slice(-slice))
  const freezes = rows.filter((row) => row.longestTaskMs >= FREEZE_MS)
  suite.record(`ran ${rows.length} cycles over ${MINUTES} min`, rows.length > 0, { early, late })
  suite.record('no freeze at any point', freezes.length === 0,
    { freezes: freezes.slice(0, 10).map(({ cycle, action, longestTaskMs }) => ({ cycle, action, longestTaskMs })) })
  suite.record('the end of the session is as smooth as its start',
    late.hitchesPerCycle <= early.hitchesPerCycle + HITCH_RATE_SLACK, { early, late })

  const firstMemory = memorySamples.slice(0, 3)
  const lastMemory = memorySamples.slice(-3)
  const average = (samples, key) => samples.reduce((sum, sample) => sum + (sample[key] ?? 0), 0) / Math.max(1, samples.length)
  if (memorySamples.length >= 4) {
    suite.growth('heap after GC does not keep climbing', average(firstMemory, 'jsHeapUsedMb'), average(lastMemory, 'jsHeapUsedMb'), HEAP_GROWTH_MB)
    suite.growth('listeners do not accumulate', average(firstMemory, 'listeners'), average(lastMemory, 'listeners'), LISTENER_GROWTH)
    suite.growth('DOM nodes do not accumulate', average(firstMemory, 'domNodes'), average(lastMemory, 'domNodes'), DOM_GROWTH)
  }
  // A git repository is always served by its working-tree patch. Falling back
  // to one comparison per file (fifty IPC round trips, parses and highlights)
  // is what a save during a review load used to cost.
  const fallbacks = rows.filter((row) => row.counters.reviewPagedFallbacks != null)
  suite.record('the review never falls back to fetching files one by one', fallbacks.length === 0, {
    fallbacks: fallbacks.slice(0, 5).map(({ cycle, action, fallbackReason }) => ({ cycle, action, fallbackReason }))
  })
  // The soak pressed Enter on ⌘K results for hours and never looked at what
  // opened; ⌘K to a file was broken the whole time.
  const failedPicks = picks.filter((pick) => !pick.opened)
  suite.record('every ⌘K file pick opened that file', picks.length > 0 && failedPicks.length === 0, {
    picks: picks.length, failed: failedPicks.length, examples: failedPicks.slice(0, 5)
  })
  suite.record('errors during the run', rows.every((row) => row.error == null),
    { errors: rows.filter((row) => row.error != null).slice(0, 5) })
  suite.record('memory at end', true, { ...(await app.memory()), counters: await counters(cdp) })
})
