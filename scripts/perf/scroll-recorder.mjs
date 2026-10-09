// Records a reader's own trackpad scrolling in the installed app and reports,
// gesture by gesture, whether the review moved when the fingers did.
//
//   bun scripts/perf/scroll-recorder.mjs            # 120 s
//   KODI_SCROLL_RECORD_SECONDS=180 bun scripts/perf/scroll-recorder.mjs
//
// Synthetic input (CDP gestures, posted CGEvents) skips what a real trackpad
// sends — touch-down with no motion, gesture phases, momentum — so a stall that
// only those trigger never shows in a probe. This launches the app visibly on a
// scratch copy of the real profile (cookies left out), traces the renderer,
// compositor and browser threads, and logs every wheel event and every frame
// in which the review's scroll offset changed. Read it, pause, scroll again.
//
// A gesture is wheel events with no gap over 300 ms. Per gesture it prints the
// idle time before it, its first event's deltas (a sideways lean once latched
// the whole swipe to a code column), the wheel distance asked for and the
// distance moved, how long the first wheel event took to reach the page, how
// long until the review first moved, the compositor's latency for the
// gesture's first scroll update, and any task over 16 ms on the browser or
// renderer main thread around its start. A gesture that took over 100 ms to move, or moved under a third of its
// wheel distance, is marked STUCK.
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { APP_PATH, CDP, connect, quit, RESULTS_DIRECTORY, run } from './cdp.mjs'

const SECONDS = Number(process.env.KODI_SCROLL_RECORD_SECONDS ?? 120)
const PORT = Number(process.env.KODI_SCROLL_RECORD_PORT ?? 9750)
const PROFILE = join(tmpdir(), 'kodi-scroll-recorder-profile')
const REAL_PROFILE = join(process.env.HOME, 'Library/Application Support/kodi')
const GESTURE_GAP_MS = 300
const STUCK_LATENCY_MS = 100
const LONG_TASK_US = 16_000

const REVIEW_ROOT = `(() => {
  const walk = (root) => {
    const found = root.querySelector('.multi-file-code-view, .diff-scroll')
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

async function main() {
  await quit()
  await run(['bash', '-c', `rm -rf "${PROFILE}" && rsync -a --exclude Cookies --exclude Cookies-journal --exclude DevToolsActivePort "${REAL_PROFILE}/" "${PROFILE}/"`])
  Bun.spawn(['env', '-u', 'ELECTRON_RUN_AS_NODE', 'open', '-na', APP_PATH, '--args', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`])
  let page = null
  for (let attempt = 0; attempt < 400 && page == null; attempt += 1) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((entry) => entry.type === 'page') ?? null
    } catch {
      // Not listening yet.
    }
    if (page == null) await Bun.sleep(50)
  }
  if (page == null) throw new Error('Kodi never opened a page.')
  const cdp = new CDP(await connect(page.webSocketDebuggerUrl))
  await Bun.sleep(3_000)
  await run(['osascript', '-e', 'tell application "Kodi" to activate'])
  await cdp.eval(`(() => {
    window.__rec = { wheel: [], frames: [], longTasks: [] }
    window.addEventListener('wheel', (event) => {
      window.__rec.wheel.push([event.timeStamp, performance.now(), event.deltaX, event.deltaY, event.deltaMode, event.ctrlKey])
    }, { capture: true, passive: true })
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__rec.longTasks.push([entry.startTime, entry.duration])
    }).observe({ type: 'longtask' })
    let root = null
    let last = null
    const tick = (time) => {
      if (root == null || !root.isConnected) root = ${REVIEW_ROOT}
      const top = root == null ? null : root.scrollTop
      if (top !== last) { window.__rec.frames.push([time, top]); last = top }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })()`)

  const events = []
  let complete = null
  const finished = new Promise((resolve) => { complete = resolve })
  cdp.socket.addEventListener('message', (message) => {
    const data = JSON.parse(message.data)
    if (data.method === 'Tracing.dataCollected') events.push(...data.params.value)
    if (data.method === 'Tracing.tracingComplete') complete()
  })
  await cdp.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { includedCategories: ['input', 'cc', 'benchmark', 'toplevel', 'latencyInfo', 'blink.user_timing', 'disabled-by-default-devtools.timeline.frame'] }
  })
  // A mark lands in the trace with its trace timestamp, which ties the trace's
  // clock to the page's.
  const traceStart = await cdp.eval("performance.mark('kodi:scroll-recorder').startTime")
  console.log(`Recording ${SECONDS} s. Read the review in the Kodi window: scroll a little, stop for 10–15 s, scroll again.`)
  for (let left = SECONDS; left > 0; left -= 10) {
    await Bun.sleep(Math.min(10, left) * 1_000)
    const count = await cdp.tryEval('window.__rec.wheel.length')
    console.log(`  ${Math.max(0, left - 10)} s left — ${count ?? '?'} wheel events so far`)
  }
  // The page's own record first: a Ctrl+C while the trace drains (it can take
  // a minute) still reports from it, without the trace's columns.
  const page_ = JSON.parse(await cdp.eval('JSON.stringify(window.__rec)'))
  let interrupted = false
  process.once('SIGINT', () => { interrupted = true; complete() })
  console.log('Done recording. Collecting the trace (up to a minute; Ctrl+C reports without it)…')
  await cdp.send('Tracing.end')
  await Promise.race([finished, Bun.sleep(60_000)])
  cdp.socket.close()
  await quit()

  const trace = interrupted ? [] : events
  await mkdir(RESULTS_DIRECTORY, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-')
  const file = join(RESULTS_DIRECTORY, `scroll-recording-${stamp}.json`)
  await writeFile(file, JSON.stringify({ page: page_, trace }))
  report(page_, trace, traceStart)
  console.log(`\nRaw recording: ${file}`)
}

function report(page, events, traceStart) {
  const { wheel, frames, longTasks } = page
  if (wheel.length === 0) {
    console.log('\nNo wheel events reached the page.')
    return
  }
  // Trace timestamps (µs) onto the page clock (ms), through the mark made as
  // tracing started.
  const names = new Map()
  for (const event of events) {
    if (event.ph === 'M' && event.name === 'thread_name') names.set(`${event.pid}:${event.tid}`, event.args.name)
  }
  const mark = events.find((event) => event.name === 'kodi:scroll-recorder')
  const traceOrigin = mark?.ts ?? Math.min(...events.filter((event) => event.ts > 0).map((event) => event.ts))
  const toPage = (ts) => traceStart + (ts - traceOrigin) / 1_000
  const latencies = []
  const open = new Map()
  for (const event of events) {
    if (event.name !== 'EventLatency') continue
    const key = event.id2?.local ?? event.id
    if (event.ph === 'b') open.set(key, event)
    else if (event.ph === 'e' && open.has(key)) {
      const begin = open.get(key)
      open.delete(key)
      const type = begin.args?.event_latency?.event_type ?? ''
      if (type.includes('SCROLL')) latencies.push({ at: toPage(begin.ts), ms: (event.ts - begin.ts) / 1_000, first: type.includes('FIRST') })
    }
  }
  const mainTasks = events
    .filter((event) => event.ph === 'X' && event.name === 'ThreadControllerImpl::RunTask' && event.dur >= LONG_TASK_US)
    .map((event) => ({ thread: names.get(`${event.pid}:${event.tid}`) ?? '?', at: toPage(event.ts), ms: event.dur / 1_000 }))
    .filter((task) => task.thread === 'CrBrowserMain' || task.thread === 'CrRendererMain')

  const gestures = []
  for (const [timeStamp, dispatchedAt, deltaX, deltaY] of wheel) {
    const current = gestures.at(-1)
    if (current == null || timeStamp - current.last > GESTURE_GAP_MS) {
      gestures.push({ first: timeStamp, last: timeStamp, events: 0, deltaY: 0, deltaX: 0, delivery: dispatchedAt - timeStamp, firstDelta: `${Math.round(deltaX)}/${Math.round(deltaY)}` })
    }
    const gesture = gestures.at(-1)
    gesture.last = timeStamp
    gesture.events += 1
    gesture.deltaY += deltaY
    gesture.deltaX += deltaX
  }
  console.log('\n idle before | events | first dx/dy | wheel px | moved px | to page | to move | first update | busy at start')
  let previous = null
  let stuck = 0
  for (const gesture of gestures) {
    const before = frames.filter(([time]) => time <= gesture.first).at(-1)?.[1] ?? null
    const after = frames.filter(([time]) => time <= gesture.last + 500).at(-1)?.[1] ?? null
    const moved = before == null || after == null ? 0 : after - before
    const firstMove = frames.find(([time, top]) => time >= gesture.first && top !== before)
    const toMove = firstMove == null ? null : firstMove[0] - gesture.first
    const update = latencies.find((latency) => latency.first && latency.at >= gesture.first - 50 && latency.at <= gesture.last)
    const busy = [
      ...mainTasks.filter((task) => task.at + task.ms >= gesture.first - 200 && task.at <= gesture.first + 150)
        .map((task) => `${task.thread === 'CrBrowserMain' ? 'browser' : 'renderer'} ${Math.round(task.ms)} ms`),
      ...longTasks.filter(([start, duration]) => start + duration >= gesture.first - 200 && start <= gesture.first + 150)
        .map(([, duration]) => `long task ${Math.round(duration)} ms`)
    ]
    const isStuck = toMove == null || toMove > STUCK_LATENCY_MS || Math.abs(moved) < Math.abs(gesture.deltaY) / 3
    if (isStuck) stuck += 1
    const idle = previous == null ? '—' : `${((gesture.first - previous) / 1_000).toFixed(1)} s`
    console.log([
      idle.padStart(12), String(gesture.events).padStart(6), gesture.firstDelta.padStart(11), String(Math.round(gesture.deltaY)).padStart(8),
      String(Math.round(moved)).padStart(8), `${Math.round(gesture.delivery)} ms`.padStart(7),
      (toMove == null ? 'never' : `${Math.round(toMove)} ms`).padStart(7),
      (update == null ? '—' : `${Math.round(update.ms)} ms`).padStart(12),
      busy.join(', ') || '—', isStuck ? '  STUCK' : ''
    ].join(' | '))
    previous = gesture.last
  }
  console.log(`\n${gestures.length} gestures, ${stuck} stuck.`)
}

await main().catch(async (error) => {
  console.error(error)
  await quit()
  process.exit(1)
})
