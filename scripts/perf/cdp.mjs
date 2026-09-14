// Shared plumbing for the Kodi performance probes: launching the installed
// app with a remote-debugging port, a small Chrome DevTools Protocol client,
// and the result file the probes append to.
//
// Every probe is responsible for leaving no Kodi process behind. `guardExit()`
// covers the signal paths; the probes themselves quit in a `finally`.
import { appendFile, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir, hostname, loadavg, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PERF_DIRECTORY = dirname(fileURLToPath(import.meta.url))

export const APP_PATH = process.env.KODI_APP ?? join(homedir(), 'Applications/Kodi.app')
export const APP_BINARY = join(APP_PATH, 'Contents/MacOS/Kodi')
export const RESULTS_DIRECTORY = process.env.KODI_PERF_RESULTS_DIR ?? join(PERF_DIRECTORY, 'results')
export const RUN_ID = process.env.KODI_PERF_RUN_ID ?? randomUUID()
export const FIXTURE_ID = process.env.KODI_PERF_FIXTURE ?? 'restored-session'
export const CACHE_STATE = process.env.KODI_PERF_CACHE_STATE ?? 'os-page-cache-warm'

// KODI_PROBE_HIDDEN=1 runs the app with its window never shown: nothing
// flashes on screen, nothing steals focus, no dock bounce. The app binary is
// exec'd directly so LaunchServices never activates it, KODI_PROBE keeps the
// window hidden (while still restoring the session, unlike KODI_BACKGROUND),
// and the Chromium switches keep an occluded window from throttling rAF and
// timers — the palette's rAF handoff would stall otherwise. `windowShown`
// reports null in this mode; that is the honest answer.
const HIDDEN = process.env.KODI_PROBE_HIDDEN === '1'
const LIFECYCLE = process.env.KODI_PROBE_LIFECYCLE === '1'
const UNTHROTTLE_ARGS = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling'
]

// A renderer that is busy parsing a chunk answers late; 15 s is long enough that
// only a genuinely wedged page trips it, short enough that a probe still ends.
const CDP_TIMEOUT_MS = 15_000
const QUIT_TIMEOUT_MS = 8_000

export async function run(command) {
  const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' })
  return child.exited
}

export async function waitForExit(timeoutMs = QUIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await run(['pgrep', '-x', 'Kodi']) !== 0) return true
    await Bun.sleep(30)
  }
  return false
}

export async function quit() {
  await run(['osascript', '-e', 'tell application "Kodi" to quit'])
  if (await waitForExit()) return
  await run(['pkill', '-x', 'Kodi'])
  await Bun.sleep(600)
}

/** Quit the app on Ctrl+C or a kill so a probe never orphans a window. */
export function guardExit() {
  let quitting = false
  const stop = (signal) => {
    if (quitting) return
    quitting = true
    void quit().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143))
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
}

export async function waitForPage(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (response.ok) {
        const page = (await response.json()).find((target) => target.type === 'page')
        if (page != null) return page
      }
    } catch {
      // The debugging endpoint only exists once Chromium has started.
    }
    await Bun.sleep(5)
  }
  throw new Error(`No Kodi page target appeared on port ${port}.`)
}

export function connect(webSocketDebuggerUrl) {
  return new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl)
    socket.onopen = () => resolveSocket(socket)
    socket.onerror = () => reject(new Error('Could not connect to the Kodi renderer.'))
  })
}

export class CDP {
  constructor(socket) {
    this.socket = socket
    this.lastId = 0
    this.pending = new Map()
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const handlers = message.id == null ? null : this.pending.get(message.id)
      if (handlers == null) return
      this.pending.delete(message.id)
      if (message.error != null) handlers.reject(new Error(message.error.message))
      else handlers.resolve(message.result)
    })
  }

  send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    const id = ++this.lastId
    return new Promise((resolveResult, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error(`CDP socket closed before ${method}.`))
        return
      }
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        reject(new Error(`CDP timeout after ${timeoutMs} ms: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolveResult(value) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async eval(expression, awaitPromise = false) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (result.exceptionDetails != null) {
      throw new Error(result.exceptionDetails.text ?? 'Renderer probe failed.')
    }
    return result.result.value
  }

  /** Evaluate without caring why it failed; probes treat a miss as "not yet". */
  async tryEval(expression, awaitPromise = false) {
    try {
      return await this.eval(expression, awaitPromise)
    } catch {
      return null
    }
  }

  async key(type, key, code, virtualKeyCode, modifiers = 0, text) {
    const params = {
      type,
      key,
      code,
      windowsVirtualKeyCode: virtualKeyCode,
      nativeVirtualKeyCode: virtualKeyCode,
      modifiers
    }
    if (text != null) params.text = text
    return this.send('Input.dispatchKeyEvent', params)
  }

  async combo(key, code, virtualKeyCode, modifiers = 4) {
    await this.key('keyDown', 'Meta', 'MetaLeft', 91, 4)
    await this.key('keyDown', key, code, virtualKeyCode, modifiers)
    await this.key('keyUp', key, code, virtualKeyCode, modifiers)
    await this.key('keyUp', 'Meta', 'MetaLeft', 91, 0)
  }

  async type(text) {
    for (const character of text) {
      const upper = character.toUpperCase()
      const virtualKeyCode = upper.charCodeAt(0)
      await this.key('keyDown', character, `Key${upper}`, virtualKeyCode, 0, character)
      await this.key('keyUp', character, `Key${upper}`, virtualKeyCode, 0)
    }
  }

  async enter() {
    await this.key('keyDown', 'Enter', 'Enter', 13, 0, '\r')
    await this.key('keyUp', 'Enter', 'Enter', 13, 0)
  }

  async escape() {
    await this.key('keyDown', 'Escape', 'Escape', 27, 0)
    await this.key('keyUp', 'Escape', 'Escape', 27, 0)
  }

  /**
   * Poll an expression until it is truthy. Reports the round-trip cost as well
   * as the answer: a renderer blocked on a long task shows up as a slow poll,
   * which is often the measurement that matters.
   */
  async waitFor(expression, timeoutMs = 15_000, everyMs = 4) {
    const deadline = Date.now() + timeoutMs
    let maxRoundTripMs = 0
    let slowPolls = 0
    while (Date.now() < deadline) {
      if (this.socket.readyState !== WebSocket.OPEN) break
      const startedAt = Date.now()
      const value = await this.tryEval(expression)
      const roundTripMs = Date.now() - startedAt
      if (roundTripMs > maxRoundTripMs) maxRoundTripMs = roundTripMs
      if (roundTripMs > 50) slowPolls += 1
      if (value) return { value, at: Date.now(), maxRoundTripMs, slowPolls, timedOut: false }
      await Bun.sleep(everyMs)
    }
    return { value: null, at: null, maxRoundTripMs, slowPolls, timedOut: true }
  }
}

export async function launch(port, extraArgs = []) {
  await quit()
  const startedAt = Date.now()
  if (HIDDEN) {
    const env = { ...process.env, KODI_PROBE: '1' }
    if (LIFECYCLE) env.KODI_LIFECYCLE_PROBE = '1'
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_NO_ASAR
    const child = Bun.spawn([
      APP_BINARY,
      `--remote-debugging-port=${port}`,
      ...(LIFECYCLE ? [] : UNTHROTTLE_ARGS),
      ...extraArgs
    ], {
      env,
      stdout: 'ignore',
      stderr: 'ignore'
    })
    const page = await waitForPage(port)
    const cdp = new CDP(await connect(page.webSocketDebuggerUrl))
    if (LIFECYCLE) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1440,
        height: 920,
        deviceScaleFactor: 1,
        mobile: false
      })
    }
    return { cdp, startedAt, rootPid: child.pid }
  } else {
    // Same guard as `bun run open:mac`: a leaked ELECTRON_RUN_AS_NODE makes the
    // packaged binary run as bare Node and exit before the debug port exists.
    await run(['env', '-u', 'ELECTRON_RUN_AS_NODE', '-u', 'ELECTRON_NO_ASAR',
      'open', '-na', APP_PATH, '--args', `--remote-debugging-port=${port}`, ...extraArgs])
  }
  const page = await waitForPage(port)
  return { cdp: new CDP(await connect(page.webSocketDebuggerUrl)), startedAt, rootPid: null }
}

/** Resolves when main reports `restoreSettled` and the explorer is on screen. */
export async function settle(cdp, timeoutMs = 25_000) {
  const settled = await cdp.waitFor(
    `window.repository.getPerformanceMetrics(true).then(m =>
      m.detail?.mainStartup?.restoreSettled != null && document.querySelector('#repository-explorer') != null)`,
    timeoutMs,
    50
  )
  return settled.at
}

// Installed once per page. Renderer-side collection for things a poll cannot
// see after the fact: snapshot publishes, pull request progress events, and
// long tasks (buffered, so tasks from before this ran are included).
//
// `window.repository` is frozen and non-configurable (contextBridge), so the
// IPC methods themselves cannot be wrapped from here; an open whose refresh
// wins the deadline race answers over IPC and publishes nothing, and the probe
// has to read the rendered result instead. Every record carries its `source` so
// the two can be told apart.
export const HOOKS = `(() => {
  if (window.__probe != null) return true
  window.__probe = { changes: [], pr: [], longTasks: [] }
  window.repository.onDidChange((change) => window.__probe.changes.push({
    t: Date.now(),
    source: 'change',
    root: change.snapshot.root,
    branch: change.snapshot.branch ?? null,
    stage: change.snapshot.stage ?? null,
    paths: (change.snapshot.paths ?? []).length,
    statuses: (change.snapshot.statuses ?? []).length
  }))
  window.repository.onPullRequestReviewProgress((progress) => window.__probe.pr.push({
    t: Date.now(),
    kind: progress.kind,
    files: progress.files == null ? undefined : progress.files.length,
    fileCount: progress.fileCount
  }))
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__probe.longTasks.push({ start: entry.startTime, duration: entry.duration })
      }
    }).observe({ type: 'longtask', buffered: true })
  } catch {
    window.__probe.longTasks = null
  }
  return true
})()`

/**
 * The explorer's tree is a custom element that renders its rows into a shadow
 * root, so `document.querySelectorAll('#repository-explorer [role=treeitem]')`
 * answers 0 however many rows are on screen. Verified against the installed
 * build: 26 virtualised `[data-item-path]` rows on a 6,245-file repository.
 */
export const TREE_ROW_COUNT = `(() => {
  const container = document.querySelector('#repository-explorer .project-tree')
  const root = container == null ? null : container.shadowRoot
  return root == null ? 0 : root.querySelectorAll('[data-item-path]').length
})()`

/** Long tasks recorded so far, merged with whatever the timeline still holds. */
export const LONG_TASKS = `(() => {
  const timeline = (() => {
    try { return performance.getEntriesByType('longtask').map((e) => ({ start: e.startTime, duration: e.duration })) }
    catch { return [] }
  })()
  const observed = window.__probe?.longTasks ?? []
  const seen = new Set()
  return [...timeline, ...observed].filter((task) => {
    const key = task.start + ':' + task.duration
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((left, right) => left.start - right.start)
})()`

/**
 * `markRendererStartup` writes `kodi:explorer-committed`; every consumer here
 * reads `explorerCommitted`. Getting this wrong is silent — the medians simply
 * report null — so the conversion lives in one tested place.
 */
export function markKey(markName) {
  return markName.replace(/^kodi:/, '').replace(/-([a-z])/g, (_all, letter) => letter.toUpperCase())
}

/** `{ 'kodi:react-committed': 12 }` -> `{ reactCommitted: 12 }`, offset applied. */
export function startupMarks(rawMarks, originOffsetMs = 0) {
  const marks = {}
  for (const [name, value] of Object.entries(rawMarks ?? {})) {
    marks[markKey(name)] = round(originOffsetMs + value)
  }
  return marks
}

export function median(values) {
  const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right)
  return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)]
}

/**
 * Median and min in whole milliseconds. The min matters as much as the median
 * here: the first sample after an install pays a cold file cache, so a run's
 * best sample is the honest read of what the code can do.
 */
export function statistics(values) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right)
  const failures = values.length - numbers.length
  if (numbers.length === 0) {
    return { samples: 0, failures, p50: null, p95: null, median: null, min: null, max: null }
  }
  const percentile = (fraction) => numbers[Math.max(0, Math.ceil(numbers.length * fraction) - 1)]
  return {
    samples: numbers.length,
    failures,
    p50: round(percentile(0.5)),
    p95: round(percentile(0.95)),
    median: round(percentile(0.5)),
    min: round(numbers[0]),
    max: round(numbers[numbers.length - 1])
  }
}

/**
 * One greppable line per probe run, so a before/after comparison is a diff of
 * two lines rather than a JSON reduction:
 * `PERF {"probe":"startup","label":"after","metrics":{"fcpMs":{...}}}`.
 */
export function summaryLine(probe, label, samplesByMetric) {
  const metrics = {}
  for (const [name, values] of Object.entries(samplesByMetric)) metrics[name] = statistics(values)
  return `PERF ${JSON.stringify({ probe, label, metrics })}`
}

/**
 * A count that is still settling reads wrong. The palette paints its first rows
 * and fills the rest in on a later frame, so the number a probe reads the
 * instant the input takes focus is not the number the user ends up looking at.
 * Polls until two consecutive reads agree, or until the settle window is up,
 * and answers the last reading either way.
 */
export async function stableReading(read, options = {}) {
  const settleMs = options.settleMs ?? 100
  const everyMs = options.everyMs ?? 8
  const sleep = options.sleep ?? Bun.sleep
  let previous = await read()
  const deadline = Date.now() + settleMs
  while (Date.now() < deadline) {
    await sleep(everyMs)
    const next = await read()
    if (next != null && next === previous) return next
    previous = next
  }
  return previous
}

export function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

/** Append one JSON object per line to scripts/perf/results/<label>.jsonl. */
export async function appendResult(label, record) {
  await mkdir(RESULTS_DIRECTORY, { recursive: true })
  const file = resolve(RESULTS_DIRECTORY, `${label}.jsonl`)
  await appendFile(file, `${JSON.stringify({
    at: new Date().toISOString(),
    runId: RUN_ID,
    fixture: FIXTURE_ID,
    cacheState: CACHE_STATE,
    origins: { process: 'process-launch', interaction: 'input-dispatch', main: 'main-receipt' },
    // Load average is recorded with every run because two labels measured under
    // different machine load are not comparable, and nothing else in the record
    // would show it. `appPath` is here for the same reason: an A/B that points
    // KODI_APP at two builds has to say which one produced the samples.
    machine: {
      hostname: hostname(),
      ramBytes: totalmem(),
      platform: process.platform,
      arch: process.arch,
      loadAverage1m: Math.round(loadavg()[0] * 100) / 100,
      appPath: APP_PATH
    },
    ...record
  })}\n`)
  return file
}
