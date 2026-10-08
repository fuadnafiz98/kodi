// Shared plumbing for the regression e2e suites in this folder. Unlike the probes
// in scripts/perf (which sample the installed app for statistics), these drive
// the local build (`out/`, via `bun run build`) and fail on a budget:
//
//   - a step that does not finish, or
//   - a renderer that stops answering longer than the step's stall budget
//     (a CDP round trip that does not come back is a frozen main thread, and
//     the action itself is timed, because a synchronous click handler freezes
//     the window before any polling can start), or
//   - memory that grows past its budget across repeated cycles.
//
// Every run uses a hidden window, a throwaway --user-data-dir and generated
// fixtures, so the installed app and the real session are never touched.
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, loadavg, tmpdir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CDP, connect, waitForPage } from '../perf/cdp.mjs'

export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const ELECTRON = join(REPO_ROOT, 'node_modules/.bin/electron')
const RESULTS_DIRECTORY = join(REPO_ROOT, 'scripts/e2e/results')
export const STEP_TIMEOUT_MS = Number(process.env.KODI_E2E_STEP_TIMEOUT_MS ?? 30_000)
// Longest the renderer may go without answering while a step runs. Healthy
// steps stay far below this; the explorer bug it was written for held 15 s.
export const DEFAULT_STALL_BUDGET_MS = Number(process.env.KODI_E2E_RESPONSIVE_MS ?? 1_500)

// ── fixtures ────────────────────────────────────────────────────────────────

export async function git(cwd, ...args) {
  const child = Bun.spawn(['git', '-C', cwd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${stderr}`)
  return stdout
}

/**
 * `top` folders × `sub` subfolders × `files` files under `prefix`. Folder
 * density matters more than file count for anything the tree does per folder.
 */
export async function writeTree(root, prefix, { top, sub, files, contents = (c) => `export const v = ${c}\n` }) {
  for (let a = 0; a < top; a += 1) {
    for (let b = 0; b < sub; b += 1) {
      const directory = join(root, prefix, `m${a}`, `s${b}`)
      await mkdir(directory, { recursive: true })
      await Promise.all(Array.from({ length: files }, (_unused, c) =>
        writeFile(join(directory, `f${c}.ts`), contents(c))))
    }
  }
  return top * sub * files
}

/** A committed repository with a pinned identity, no signing and no hooks. */
export async function createRepository(label = 'repo') {
  const root = await mkdtemp(join(tmpdir(), `kodi-e2e-${label}-`))
  await git(root, '-c', 'init.defaultBranch=main', 'init', '--quiet')
  await git(root, 'config', 'user.name', 'Kodi E2E')
  await git(root, 'config', 'user.email', 'e2e@example.invalid')
  await git(root, 'config', 'commit.gpgsign', 'false')
  await git(root, 'config', 'core.hooksPath', join(root, '.no-hooks'))
  await mkdir(join(root, 'src/lib'), { recursive: true })
  await writeFile(join(root, 'README.md'), '# fixture\n')
  await writeFile(join(root, 'src/app.ts'), 'export {}\n')
  await writeFile(join(root, 'src/lib/util.ts'), 'export {}\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '--quiet', '-m', 'Initial commit')
  return root
}

/**
 * `build(root)` once per `key`, reused across runs when KODI_E2E_FIXTURE_CACHE=1
 * (a 100k-file repository takes ~40 s to write). A reused fixture is reset to
 * its committed state and cleaned first, so every run starts from the same tree.
 * Returns the root and a cleanup that keeps a cached fixture.
 */
export async function fixture(key, build) {
  if (process.env.KODI_E2E_FIXTURE_CACHE !== '1') {
    const root = await build()
    return { root, cleanup: removeLater(root) }
  }
  const root = join(tmpdir(), `kodi-e2e-cache-${key}`)
  const marker = join(root, '.git', 'kodi-e2e-ready')
  if (await Bun.file(marker).exists()) {
    await git(root, 'reset', '--quiet', '--hard')
    await git(root, 'clean', '-fdxq')
    return { root, cleanup: async () => {}, reused: true }
  }
  await rm(root, { recursive: true, force: true })
  const built = await build()
  await rm(root, { recursive: true, force: true })
  await Bun.spawn(['mv', built, root]).exited
  await writeFile(marker, '')
  return { root, cleanup: async () => {} }
}

// ── app ─────────────────────────────────────────────────────────────────────

async function portIsFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })
    return false
  } catch {
    return true
  }
}

/**
 * Launches the local build hidden, on a scratch profile, opened on `folder`.
 * `stop()` kills the whole process tree: the `electron` shim is a Node wrapper
 * around the real binary, so killing the spawned process alone leaves the app
 * running, and the pkill pattern must not start with a dash or pkill reads it
 * as an option and kills nothing.
 */
export async function launchApp({ folder, port = Number(process.env.KODI_E2E_PORT ?? 9391), viewport = { width: 1440, height: 900 }, profile: reusedProfile = null, pathPrefix = null, cpuThrottle = null }) {
  // The main process is inspected on the next port, so a suite can time how
  // long it takes to answer: a blocked main process delays every IPC reply.
  const mainPort = port + 1
  // Attaching to a leftover app from an earlier run would test the wrong build.
  for (const busy of [port, mainPort]) {
    if (!(await portIsFree(busy))) {
      throw new Error(`Port ${busy} is already serving DevTools; quit that app or set KODI_E2E_PORT.`)
    }
  }
  // A suite that restarts the app passes the same profile back in (see
  // `createProfile`) and removes it itself.
  const profile = reusedProfile ?? await mkdtemp(join(tmpdir(), 'kodi-e2e-profile-'))
  const visible = process.env.KODI_E2E_VISIBLE === '1'
  const env = appEnvironment()
  // A directory of stand-in tools (a slow `git`) ahead of the real ones.
  if (pathPrefix != null) env.PATH = `${pathPrefix}:${env.PATH ?? ''}`
  const binary = appBinary()
  const child = Bun.spawn([
    ...binary, `--inspect=${mainPort}`, ...(process.env.KODI_E2E_APP == null ? ['.'] : []),
    `--remote-debugging-port=${port}`,
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    `--user-data-dir=${profile}`,
    ...(folder == null ? [] : ['--kodi-folder', folder])
  ], { cwd: process.env.KODI_E2E_APP_DIR ?? REPO_ROOT, env, stdout: 'ignore', stderr: 'ignore' })
  let stopped = false
  // The main process renames itself (`process.title`), so neither the profile
  // pattern below nor the spawned shim's pid always reaches it, and a survivor
  // kept the DevTools port: the next suite then refused to start. Whoever
  // listens on the port is the main process.
  let portOwners = []
  const stop = async () => {
    if (stopped) return
    stopped = true
    // The main process first: it quits on SIGTERM and flushes localStorage and
    // the session on the way out, which it cannot do once its helpers are dead.
    child.kill()
    await Promise.race([child.exited, Bun.sleep(4_000)])
    Bun.spawnSync(['pkill', '-f', profile])
    const exited = await Promise.race([child.exited.then(() => true, () => true), Bun.sleep(5_000).then(() => false)])
    // A packaged build's main process renames itself (argv reads just "Kodi"),
    // so the pattern misses it, and it can sit on SIGTERM behind its quit flow.
    if (!exited) {
      try { process.kill(child.pid, 'SIGKILL') } catch {}
      Bun.spawnSync(['pkill', '-9', '-f', profile])
    }
    // Only a pid that still holds the port: one recycled since launch — a long
    // soak is hours — is somebody else's.
    const stillListening = new Set(listeningPids(port))
    for (const pid of portOwners) {
      if (!stillListening.has(pid)) continue
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    if (reusedProfile == null && process.env.KODI_E2E_KEEP !== '1') await rm(profile, { recursive: true, force: true })
  }
  try {
    const page = await waitForPage(port, 30_000)
    portOwners = listeningPids(port).filter((pid) => pid !== process.pid)
    const cdp = new CDP(await connect(page.webSocketDebuggerUrl))
    // A slow renderer — what a cold disk does to the first launch after an
    // install — applied the moment the page exists, before the app mounts.
    if (cpuThrottle != null) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuThrottle })
    // Hidden windows have a zero-size viewport; virtualized lists render
    // nothing against it.
    if (!visible) await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false })
    await cdp.send('Performance.enable')
    await installLongTaskObserver(cdp)
    // A packaged build may have the inspector fused off; the suite then
    // measures the renderer only.
    const main = await connectMain(mainPort).catch(() => null)
    // The main process is whoever serves the page's DevTools port.
    const mainPid = () => listeningPids(port).find((pid) => pid !== process.pid) ?? null
    return { cdp, main, profile, stop, mainPid, memory: () => memory(cdp, profile) }
  } catch (error) {
    await stop()
    throw error
  }
}

// KODI_E2E_VISIBLE=1 shows a real window: a hidden one never paints, so paint
// and compositing cost — what a reader on a real display feels — only shows here.
function appEnvironment() {
  const env = process.env.KODI_E2E_VISIBLE === '1' ? { ...process.env } : { ...process.env, KODI_PROBE: '1' }
  if (process.env.KODI_E2E_VISIBLE === '1') delete env.KODI_PROBE
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ASAR
  return env
}

// KODI_E2E_APP runs an installed build instead of `out/` — the way to get a
// baseline from the app as it was before a fix (the last `update:mac`).
// KODI_E2E_APP_DIR runs another checkout's `out/` (a `git worktree` of an
// older commit, built there) the same way.
function appBinary() {
  return process.env.KODI_E2E_APP == null ? [ELECTRON] : [process.env.KODI_E2E_APP]
}

/**
 * What `kodi <folder>` does while the app is up: a second launch on the same
 * profile, which hands its arguments to the running app and exits. Resolves
 * with its exit code, or null when it was still up after `timeoutMs` — nothing
 * held the profile, so it became the app (and is killed).
 */
export async function launchSecondInstance(profile, folder, timeoutMs = 10_000) {
  const child = Bun.spawn([
    ...appBinary(), ...(process.env.KODI_E2E_APP == null ? ['.'] : []),
    `--user-data-dir=${profile}`,
    // One token, as the bundled `kodi` script passes it.
    `--kodi-folder=${folder}`
  ], { cwd: process.env.KODI_E2E_APP_DIR ?? REPO_ROOT, env: appEnvironment(), stdout: 'ignore', stderr: 'ignore' })
  const code = await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => null)])
  if (code == null) {
    child.kill('SIGKILL')
    Bun.spawnSync(['pkill', '-9', '-f', profile])
  }
  return code
}

function listeningPids(port) {
  const result = Bun.spawnSync(['lsof', '-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])
  return result.stdout.toString().split('\n').map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)
}

async function connectMain(mainPort) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${mainPort}/json/list`)).json()
      const target = targets.find((entry) => entry.webSocketDebuggerUrl != null)
      if (target != null) return new CDP(await connect(target.webSocketDebuggerUrl))
    } catch {
      // The inspector comes up with the main process.
    }
    await Bun.sleep(50)
  }
  throw new Error(`The main process inspector never answered on port ${mainPort}.`)
}

// Long tasks are the renderer's own account of every stretch it could not
// answer input, down to 50 ms — finer than any polling from outside.
async function installLongTaskObserver(cdp) {
  const source = `(() => {
    if (window.__e2eLongTasks != null) return
    window.__e2eLongTasks = []
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__e2eLongTasks.push(Math.round(entry.duration))
    }).observe({ type: 'longtask', buffered: true })
  })()`
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }).catch(() => {})
  await cdp.tryEval(source)
}

/** Long tasks since the last call: count, longest and total, in ms. */
export async function takeLongTasks(cdp) {
  const tasks = await cdp.tryEval('(window.__e2eLongTasks ?? []).splice(0)') ?? []
  return {
    count: tasks.length,
    longestMs: tasks.length === 0 ? 0 : Math.max(...tasks),
    totalMs: tasks.reduce((sum, value) => sum + value, 0)
  }
}

/**
 * Frame pacing as the page saw it: every requestAnimationFrame interval between
 * `startFrames` and `stopFrames`. Smooth scrolling is intervals near 16.7 ms;
 * a hitch is one interval past 50 ms, which the eye reads as a stutter.
 */
const WORK_METRICS = ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration', 'LayoutCount', 'RecalcStyleCount']

async function workMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics')
  return Object.fromEntries(WORK_METRICS.map((name) => [name, metrics.find((entry) => entry.name === name)?.value ?? 0]))
}

export async function startFrames(cdp) {
  cdp.__workBefore = await workMetrics(cdp)
  await cdp.eval(`(() => {
    const meter = { deltas: [], last: performance.now(), running: true }
    window.__e2eFrames = meter
    const tick = (time) => {
      if (!meter.running) return
      meter.deltas.push(time - meter.last)
      meter.last = time
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })()`)
}

export async function stopFrames(cdp) {
  const deltas = await cdp.eval(`(() => {
    const meter = window.__e2eFrames
    if (meter == null) return []
    meter.running = false
    return meter.deltas.slice(1)
  })()`) ?? []
  const before = cdp.__workBefore ?? null
  const after = await workMetrics(cdp)
  const work = before == null ? {} : {
    // Main-thread time the renderer spent while the frames ran, in ms: what a
    // hidden window's cheap compositing hides, and a real display pays.
    scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
    layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
    styleMs: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000),
    taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
    layouts: after.LayoutCount - before.LayoutCount,
    styleRecalcs: after.RecalcStyleCount - before.RecalcStyleCount
  }
  const sorted = [...deltas].sort((left, right) => left - right)
  const at = (quantile) => sorted.length === 0 ? 0 : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))] * 10) / 10
  return {
    frames: deltas.length,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: Math.round(sorted.at(-1) ?? 0),
    over33: deltas.filter((delta) => delta > 33.4).length,
    over50: deltas.filter((delta) => delta > 50).length,
    ...work
  }
}

/** The biggest scrollable element on the page, light or shadow DOM, with its centre. */
export function largestScroller(extraSelector = '*') {
  return `(() => {
    let best = null
    const walk = (root) => {
      for (const element of root.querySelectorAll(${JSON.stringify(extraSelector)})) {
        const overflow = element.scrollHeight - element.clientHeight
        if (overflow > 200 && element.clientHeight > 100 && (best == null || overflow > best.overflow)) {
          const style = getComputedStyle(element)
          if (/(auto|scroll)/.test(style.overflowY)) best = { element, overflow }
        }
      }
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot != null) walk(element.shadowRoot)
    }
    walk(document)
    if (best == null) return null
    const rect = best.element.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), overflow: best.overflow, height: best.element.clientHeight }
  })()`
}

/** A real wheel-driven scroll through the input pipeline, like a trackpad fling. */
export async function scrollGesture(cdp, { x, y }, distance, speed = 2_000) {
  await cdp.send('Input.synthesizeScrollGesture', {
    x, y, yDistance: -distance, speed, gestureSourceType: 'mouse', repeatCount: 1
  }, 60_000)
}

/**
 * Every `wheel` listener that can block a scroll over the element `expression`
 * evaluates to: the element, each ancestor across shadow hosts, the document
 * and the window. One non-passive listener anywhere on that path makes
 * Chromium run the main thread before it may scroll, and it then scrolled the
 * whole gesture there (`SCROLL_MAIN_THREAD`): every late main frame was a frame
 * in which the text did not move.
 */
export async function blockingWheelListeners(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    includeCommandLineAPI: true,
    returnByValue: true,
    expression: `(() => {
      const start = ${expression}
      if (start == null) return null
      const nodes = []
      for (let node = start; node != null; node = node.parentNode ?? node.host ?? null) nodes.push(node)
      nodes.push(window)
      const blocking = []
      for (const node of nodes) {
        let listeners = []
        try { listeners = getEventListeners(node).wheel ?? [] } catch {}
        for (const listener of listeners) {
          if (listener.passive) continue
          blocking.push({
            on: node === window ? 'window' : node === document ? 'document' : node.nodeName + (node.id ? '#' + node.id : '') + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().split(/\\s+/).join('.') : ''),
            capture: listener.useCapture
          })
        }
      }
      return blocking
    })()`
  })
  if (result.exceptionDetails != null) throw new Error(result.exceptionDetails.text ?? 'Listener probe failed.')
  return result.result.value
}

// What the compositor presented, frame by frame: the closest a trace gets to
// what the reader saw. Needs a visible window (a hidden one never paints).
const COMPOSITOR_CATEGORIES = ['cc', 'benchmark', 'input', 'disabled-by-default-devtools.timeline.frame']

export async function startCompositorTrace(cdp) {
  const events = []
  let complete = null
  const finished = new Promise((resolve) => { complete = resolve })
  const listener = (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Tracing.dataCollected') events.push(...message.params.value)
    if (message.method === 'Tracing.tracingComplete') complete()
  }
  cdp.socket.addEventListener('message', listener)
  cdp.__compositorTrace = { events, finished, listener }
  await cdp.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: COMPOSITOR_CATEGORIES } })
}

export async function stopCompositorTrace(cdp) {
  const trace = cdp.__compositorTrace
  if (trace == null) return []
  cdp.__compositorTrace = null
  await cdp.send('Tracing.end')
  await Promise.race([trace.finished, Bun.sleep(30_000)])
  cdp.socket.removeEventListener('message', trace.listener)
  return trace.events
}

/**
 * The frames of a trace that carried a scroll. A late one is a frame dropped,
 * or one shown without the main thread's update while the main thread was the
 * one scrolling: in both, the text stayed where it was. On a compositor
 * scroll a partial frame still moves the text, so it does not count.
 */
export function summarizeScrollFrames(events) {
  const byState = {}
  let scrollFrames = 0
  let mainThread = 0
  let late = 0
  let missingContent = 0
  for (const event of events) {
    if (event.name !== 'PipelineReporter' || event.ph !== 'b') continue
    const frame = event.args?.frame_reporter
    if (frame == null || frame.scroll_state == null || frame.scroll_state === 'SCROLL_NONE') continue
    if (frame.state === 'STATE_NO_UPDATE_DESIRED') continue
    scrollFrames += 1
    const key = `${frame.state}|${frame.scroll_state}`
    byState[key] = (byState[key] ?? 0) + 1
    const onMain = frame.scroll_state === 'SCROLL_MAIN_THREAD'
    if (onMain) mainThread += 1
    if (frame.state === 'STATE_DROPPED' || (onMain && frame.state === 'STATE_PRESENTED_PARTIAL')) late += 1
    if (frame.has_missing_content || frame.checkerboarded_needs_raster || frame.checkerboarded_needs_record) missingContent += 1
  }
  const share = (count) => scrollFrames === 0 ? 0 : Math.round((count / scrollFrames) * 10_000) / 100
  return { scrollFrames, mainThreadPercent: share(mainThread), latePercent: share(late), missingContent, byState }
}

/**
 * A second launch on `profile` with `args` (`--kodi-url=…`), the way the
 * bundled `kodi` script hands a running app something to open. Resolves with
 * its exit code, or null when it became the app itself (and was killed).
 */
export async function openInRunningApp(profile, args, timeoutMs = 10_000) {
  const child = Bun.spawn([
    ...appBinary(), ...(process.env.KODI_E2E_APP == null ? ['.'] : []),
    `--user-data-dir=${profile}`, ...args
  ], { cwd: process.env.KODI_E2E_APP_DIR ?? REPO_ROOT, env: appEnvironment(), stdout: 'ignore', stderr: 'ignore' })
  const code = await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => null)])
  if (code == null) child.kill('SIGKILL')
  return code
}

/** The app's own work counters (see src/renderer/src/perf/kodiCounters.ts). */
export async function counters(cdp) {
  return await cdp.tryEval('({ ...(window.__kodiMetrics ?? {}) })') ?? {}
}

/**
 * Samples how long the renderer and the main process take to answer a trivial
 * evaluate, back to back, for `durationMs`. The slowest answer is the longest
 * each was blocked while it ran.
 */
export async function sampleResponsiveness({ cdp, main }, durationMs, everyMs = 5) {
  const deadline = Date.now() + durationMs
  const sample = async (client) => {
    let slowest = 0
    while (Date.now() < deadline) {
      const started = performance.now()
      await client.send('Runtime.evaluate', { expression: '0', returnByValue: true }, 60_000).catch(() => {})
      slowest = Math.max(slowest, performance.now() - started)
      await Bun.sleep(everyMs)
    }
    return Math.round(slowest)
  }
  const [rendererMs, mainMs] = await Promise.all([sample(cdp), main == null ? 0 : sample(main)])
  return { rendererMs, mainMs }
}

/** A scratch profile that outlives one launch, for suites that restart the app. */
export async function createProfile() {
  const profile = await mkdtemp(join(tmpdir(), 'kodi-e2e-profile-'))
  return { profile, cleanup: removeLater(profile) }
}

/**
 * Renderer JS heap after a forced GC, plus the resident size of every process
 * in this app's tree (they all carry the scratch profile path in argv).
 */
export async function memory(cdp, profile) {
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {})
  const { metrics } = await cdp.send('Performance.getMetrics')
  const metric = (name) => metrics.find((entry) => entry.name === name)?.value ?? null
  const ps = Bun.spawnSync(['ps', '-axo', 'pid=,rss=,command='])
  let rssKb = 0
  let processes = 0
  for (const line of ps.stdout.toString().split('\n')) {
    if (!line.includes(profile)) continue
    const [, rss] = line.trim().split(/\s+/)
    rssKb += Number(rss) || 0
    processes += 1
  }
  return {
    jsHeapUsedMb: round1((metric('JSHeapUsedSize') ?? 0) / 1_048_576),
    domNodes: metric('Nodes'),
    listeners: metric('JSEventListeners'),
    rssMb: round1(rssKb / 1024),
    processes
  }
}

function round1(value) {
  return Math.round(value * 10) / 10
}

/** Evaluate with a long timeout, so a frozen click is measured rather than thrown. */
export function press(cdp, expression, timeoutMs = 180_000) {
  return cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs)
    .then((result) => result.result?.value)
}

/** Count elements matching `selector`, searching every open shadow root. */
export function deepCount(selector) {
  return `(() => {
    let count = 0
    const walk = (root) => {
      count += root.querySelectorAll(${JSON.stringify(selector)}).length
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot != null) walk(element.shadowRoot)
    }
    walk(document)
    return count
  })()`
}

// ── suites ──────────────────────────────────────────────────────────────────

/**
 * Collects step results for one suite, prints them as they land, appends one
 * JSONL record per run to scripts/e2e/results/<suite>.jsonl (so trends can be
 * compared across commits), and exits non-zero if anything failed.
 */
export function createSuite(name) {
  const results = []
  const started = Date.now()

  const record = (step, ok, detail = {}) => {
    results.push({ step, ok, ...detail })
    console.log(`${ok ? '✓' : '✗'} ${step}`, JSON.stringify(detail))
  }

  /**
   * Runs `action`, then polls `done` (an expression) while sampling how long
   * the renderer takes to answer. Passes only if it finishes and never stalls
   * past `stallBudgetMs`. `durationBudgetMs` additionally caps the whole step.
   */
  const step = async (cdp, stepName, action, done, options = {}) => {
    const stallBudgetMs = options.stallBudgetMs ?? DEFAULT_STALL_BUDGET_MS
    const stepStarted = Date.now()
    try {
      await action()
      const actionMs = Date.now() - stepStarted
      const result = await cdp.waitFor(done, options.timeoutMs ?? STEP_TIMEOUT_MS, 16)
      const elapsedMs = Date.now() - stepStarted
      const maxRendererStallMs = Math.max(actionMs, result.maxRoundTripMs)
      const ok = !result.timedOut
        && maxRendererStallMs <= stallBudgetMs
        && (options.durationBudgetMs == null || elapsedMs <= options.durationBudgetMs)
      record(stepName, ok, { elapsedMs, actionMs, maxRendererStallMs, stallBudgetMs, timedOut: result.timedOut })
      return ok
    } catch (error) {
      record(stepName, false, { elapsedMs: Date.now() - stepStarted, error: error.message })
      return false
    }
  }

  /**
   * Runs `action`, then keeps sampling both processes for `settleMs` (a watcher
   * tick lands a debounce after the write, so the cost arrives late) and, if
   * given, waits for `done`. Passes when neither process was blocked past its
   * budget, no renderer long task exceeded `longTaskMs`, and `check` (an
   * expression, evaluated at the end) is truthy. `counterBudgets` caps how far
   * named app counters may move while it ran.
   */
  const watch = async (app, stepName, action, options = {}) => {
    const {
      settleMs = 1_500,
      done = null,
      check = null,
      rendererMs = 250,
      mainMs = 100,
      longTaskMs = null,
      longTaskTotalMs = null,
      counterBudgets = {},
      // An action that paces itself (typing with pauses) is not a stall; it
      // reports its own slowest round trip by returning { slowestMs }.
      timedAction = true
    } = options
    const stepStarted = Date.now()
    try {
      await takeLongTasks(app.cdp)
      const countersBefore = await counters(app.cdp)
      const actionStarted = performance.now()
      const actionResult = await action()
      const actionMs = timedAction
        ? Math.round(performance.now() - actionStarted)
        : Math.round(actionResult?.slowestMs ?? 0)
      const [responsiveness, waited] = await Promise.all([
        sampleResponsiveness(app, settleMs),
        done == null ? null : app.cdp.waitFor(done, options.timeoutMs ?? STEP_TIMEOUT_MS, 16)
      ])
      const longTasks = await takeLongTasks(app.cdp)
      const countersAfter = await counters(app.cdp)
      const counterDeltas = Object.fromEntries(Object.keys(counterBudgets)
        .map((name) => [name, (countersAfter[name] ?? 0) - (countersBefore[name] ?? 0)]))
      const checked = check == null ? true : Boolean(await app.cdp.tryEval(check))
      const renderer = Math.max(actionMs, responsiveness.rendererMs, waited?.maxRoundTripMs ?? 0)
      const failures = []
      if (waited?.timedOut) failures.push('timed out')
      if (renderer > rendererMs) failures.push(`renderer blocked ${renderer} ms > ${rendererMs}`)
      if (responsiveness.mainMs > mainMs) failures.push(`main blocked ${responsiveness.mainMs} ms > ${mainMs}`)
      if (longTaskMs != null && longTasks.longestMs > longTaskMs) failures.push(`long task ${longTasks.longestMs} ms > ${longTaskMs}`)
      if (longTaskTotalMs != null && longTasks.totalMs > longTaskTotalMs) failures.push(`long tasks ${longTasks.totalMs} ms in total > ${longTaskTotalMs}`)
      for (const [name, budget] of Object.entries(counterBudgets)) {
        if (counterDeltas[name] > budget) failures.push(`${name} +${counterDeltas[name]} > ${budget}`)
      }
      if (!checked) failures.push('check failed')
      record(stepName, failures.length === 0, {
        elapsedMs: Date.now() - stepStarted,
        maxRendererStallMs: renderer,
        maxMainStallMs: responsiveness.mainMs,
        longTasks,
        counters: counterDeltas,
        ...(failures.length === 0 ? {} : { failures })
      })
      return failures.length === 0
    } catch (error) {
      record(stepName, false, { elapsedMs: Date.now() - stepStarted, error: error.message })
      return false
    }
  }

  /** Fails when `after` exceeds `before` by more than `budget` (same units). */
  const growth = (stepName, before, after, budget) => {
    const grew = after - before
    record(stepName, grew <= budget, { before, after, grew: round1(grew), budget })
  }

  const finish = async (extra = {}) => {
    const passed = results.filter((result) => result.ok).length
    console.log(`${passed}/${results.length} passed`)
    await mkdir(RESULTS_DIRECTORY, { recursive: true })
    const sha = Bun.spawnSync(['git', '-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD']).stdout.toString().trim()
    const dirty = Bun.spawnSync(['git', '-C', REPO_ROOT, 'status', '--porcelain']).stdout.toString().trim() !== ''
    await appendFile(join(RESULTS_DIRECTORY, `${name}.jsonl`), `${JSON.stringify({
      at: new Date().toISOString(),
      suite: name,
      commit: sha + (dirty ? '+dirty' : ''),
      // `out/` is the local build under test; anything else is a baseline.
      build: process.env.KODI_E2E_APP != null ? 'installed' : process.env.KODI_E2E_APP_DIR != null ? `dir:${process.env.KODI_E2E_APP_DIR}` : 'out',
      durationMs: Date.now() - started,
      machine: { hostname: hostname(), ramBytes: totalmem(), loadAverage1m: round1(loadavg()[0]) },
      passed,
      total: results.length,
      results,
      ...extra
    })}\n`)
    return passed === results.length
  }

  return { record, step, watch, growth, finish, results }
}

/** Runs a suite body with the app up, always tearing everything down. */
export async function runSuite(name, body) {
  const suite = createSuite(name)
  const cleanups = []
  const onExit = (code) => async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {})
    process.exit(code)
  }
  process.on('SIGINT', onExit(130))
  try {
    await body(suite, (cleanup) => cleanups.push(cleanup))
  } catch (error) {
    suite.record('harness', false, { error: error.message })
  }
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {})
  const ok = await suite.finish()
  process.exit(ok ? 0 : 1)
}

/** Removes a fixture unless KODI_E2E_KEEP=1. */
export function removeLater(path) {
  return async () => {
    if (process.env.KODI_E2E_KEEP === '1') {
      console.log('kept', path)
      return
    }
    await rm(path, { recursive: true, force: true })
  }
}

/**
 * Holds review progress events in main for `delayMs` before sending them, so
 * each invoke's reply reaches the renderer ahead of pages sent before it —
 * all of them, or with `passFirst` all but the first.
 * Electron does not order a reply against `webContents.send`, and on a busy
 * machine a reply regularly overtook its pages: the review kept the first file,
 * or none. Events keep their own order (timers fire first in, first out).
 * Needs the main-process inspector, so it cannot run against a packaged build
 * with the inspector fused off.
 */
export async function reorderReviewProgress({ main }, { delayMs = 150, passFirst = false } = {}) {
  if (main == null) throw new Error('Reordering IPC needs the main-process inspector.')
  const result = await main.send('Runtime.evaluate', {
    includeCommandLineAPI: true,
    returnByValue: true,
    expression: `(() => {
      const { webContents } = require('electron')
      const contents = webContents.getAllWebContents()[0]
      if (contents == null) return 'no web contents'
      const prototype = Object.getPrototypeOf(contents)
      if (prototype.__e2eOriginalSend == null) prototype.__e2eOriginalSend = prototype.send
      const send = prototype.__e2eOriginalSend
      const seen = new Set()
      prototype.send = function (channel, ...args) {
        if (!/review-progress$/.test(channel)) return send.call(this, channel, ...args)
        // passFirst lets each request's first event through on time, so the reply
        // lands between the first page and the rest.
        const requestId = args[0]?.requestId
        if (${passFirst ? 'true' : 'false'} && !seen.has(requestId)) {
          seen.add(requestId)
          return send.call(this, channel, ...args)
        }
        setTimeout(() => { if (!this.isDestroyed()) send.call(this, channel, ...args) }, ${Number(delayMs)})
      }
      return 'ok'
    })()`
  })
  if (result.result?.value !== 'ok') throw new Error(`Could not reorder review progress: ${JSON.stringify(result)}`)
}
