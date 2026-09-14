// Cold-launch profile of the installed app: paint, renderer startup marks, main
// startup marks, long tasks at mount, then the first Cmd+P.
//
//   bun scripts/perf/startup-probe.mjs before
//   SAMPLES=5 QUERY=render bun scripts/perf/startup-probe.mjs after
//
// Each sample is appended to scripts/perf/results/<label>.jsonl.
import {
  appendResult,
  guardExit,
  launch,
  LONG_TASKS,
  median,
  quit,
  round,
  stableReading,
  startupMarks,
  summaryLine,
  TREE_ROW_COUNT
} from './cdp.mjs'

const SAMPLES = Number(process.env.SAMPLES ?? '3')
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? '20000')
const QUERY = process.env.QUERY ?? 'app'
const LABEL = process.argv[2] ?? 'run'
const LONG_TASK_MS = 50

const PAINTS = `Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, e.startTime]))`

const OBSERVATION = `({
  timeOrigin: performance.timeOrigin,
  paints: ${PAINTS},
  marks: Object.fromEntries(performance.getEntriesByType('mark')
    .filter((e) => e.name.startsWith('kodi:'))
    .map((e) => [e.name, e.startTime])),
  explorer: document.querySelector('#repository-explorer') != null,
  diff: document.querySelector('#repository-diff > *') != null,
  review: document.querySelector('.multi-file-review') != null,
  welcome: document.querySelector('.welcome') != null,
  rows: ${TREE_ROW_COUNT}
})`

// The paint timeline is written after the frame is presented, and the loop below
// stops the moment the startup marks are committed — a frame or two before the
// browser books `first-contentful-paint`. Every Wave 1 sample reported
// `fcpMs: null` for that reason alone, so keep asking for a second.
const PAINT_SETTLE_MS = 1_000

async function paintsWithContentfulPaint(cdp, paints) {
  if (paints?.['first-contentful-paint'] != null) return paints
  const settled = await cdp.waitFor(
    `(() => { const p = ${PAINTS}; return p['first-contentful-paint'] == null ? null : p })()`,
    PAINT_SETTLE_MS,
    10
  )
  return settled.value ?? paints ?? null
}

const PALETTE_FOCUSED = `(() => {
  const input = document.querySelector('#command-palette-input')
  return input != null && document.activeElement === input
})()`

const PALETTE_RESULTS = `(() => {
  const buttons = [...document.querySelectorAll('.command-palette-results button')]
  return {
    files: buttons.filter((b) => b.querySelector('small')?.textContent?.includes('/') === true).length,
    content: document.querySelectorAll('.palette-content').length,
    spinner: document.querySelector('.search-spinner') != null,
    total: buttons.length
  }
})()`

// P15 exposes the review metrics on the window for exactly this assertion; until
// it lands the probe reports null rather than a wrong zero.
const WORKSPACE_RENDERS = `window.__kodiMetrics?.workspaceRenders ?? null`

const PALETTE_ROW_COUNT = `document.querySelectorAll('.command-palette-results button').length`

// The app's own share of Cmd+P. `openMs` below carries four CDP input round
// trips and a poll on top of it, so a regression is read from this one.
const PALETTE_OPEN_APP_MS = `(() => {
  const entry = performance.getEntriesByName('kodi:palette-open-to-focus').at(-1)
  return entry == null ? null : entry.duration
})()`

async function measurePalette(cdp) {
  const palette = {}
  const openedAt = Date.now()
  await cdp.combo('p', 'KeyP', 80, 4)
  const focused = await cdp.waitFor(PALETTE_FOCUSED, 8_000, 3)
  if (focused.at == null) return palette
  palette.openMs = focused.at - openedAt
  palette.paletteOpenAppMs = round((await cdp.waitFor(PALETTE_OPEN_APP_MS, 500, 8)).value)
  // Staged rows: 12 land on the open frame and the rest a frame later, so the
  // first reading is not the row count the user sees.
  palette.emptyRows = await stableReading(() => cdp.tryEval(PALETTE_ROW_COUNT))

  const rendersBefore = await cdp.tryEval(WORKSPACE_RENDERS)
  const typingStartedAt = Date.now()
  await cdp.type(QUERY)
  const typedAt = Date.now()
  palette.typeMs = typedAt - typingStartedAt

  let fileResultsAt = null
  let contentResultsAt = null
  let spinnerSeen = false
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const results = await cdp.tryEval(PALETTE_RESULTS)
    if (results != null) {
      if (results.files > 0 && fileResultsAt == null) fileResultsAt = Date.now() - typedAt
      if (results.spinner) spinnerSeen = true
      if (results.content > 0 && contentResultsAt == null) contentResultsAt = Date.now() - typedAt
      if (fileResultsAt != null && (contentResultsAt != null || (spinnerSeen && !results.spinner))) {
        palette.finalRows = results.total
        break
      }
    }
    await Bun.sleep(3)
  }
  palette.fileResultsMs = fileResultsAt
  palette.contentResultsMs = contentResultsAt
  palette.spinnerSeen = spinnerSeen

  const rendersAfter = await cdp.tryEval(WORKSPACE_RENDERS)
  palette.workspaceRenders = rendersBefore == null || rendersAfter == null
    ? null
    : rendersAfter - rendersBefore
  palette.typedCharacters = QUERY.length

  await cdp.escape()
  return palette
}

async function sample(index) {
  const port = 9470 + index
  const { cdp, startedAt } = await launch(port)
  const pageTargetAt = Date.now()

  const firstSeen = {}
  let observation = null
  let maxRoundTripMs = 0
  let slowPolls = 0
  let polls = 0
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    const pollStartedAt = Date.now()
    const next = await cdp.tryEval(OBSERVATION)
    if (next == null) {
      await Bun.sleep(5)
      continue
    }
    observation = next
    const roundTripMs = Date.now() - pollStartedAt
    polls += 1
    if (roundTripMs > maxRoundTripMs) maxRoundTripMs = roundTripMs
    if (roundTripMs > 50) slowPolls += 1
    for (const key of ['explorer', 'diff', 'review', 'welcome']) {
      if (observation[key] && firstSeen[key] == null) firstSeen[key] = Date.now() - startedAt
    }
    const painted = observation.explorer && (observation.diff || observation.review)
    const committed = startupMarks(observation.marks)
    if (painted && committed.explorerCommitted != null && committed.viewerCommitted != null) break
    await Bun.sleep(5)
  }

  const originOffset = observation == null ? 0 : observation.timeOrigin - startedAt
  const marks = startupMarks(observation?.marks, originOffset)
  const paints = await paintsWithContentfulPaint(cdp, observation?.paints)

  const mainStartup = await cdp.tryEval(
    `window.repository.getPerformanceMetrics(true).then((m) => m.detail?.mainStartup ?? null)`,
    true
  )
  const longTasks = (await cdp.tryEval(LONG_TASKS)) ?? []
  const bootLongTasks = longTasks.filter((task) => task.duration >= LONG_TASK_MS)

  await Bun.sleep(400)
  const palette = await measurePalette(cdp)
  cdp.socket.close()

  return {
    sample: index,
    label: LABEL,
    pageTargetMs: pageTargetAt - startedAt,
    navigationMs: observation == null ? null : round(originOffset),
    firstPaintMs: round(originOffset + (paints?.['first-paint'] ?? NaN)),
    fcpMs: round(originOffset + (paints?.['first-contentful-paint'] ?? NaN)),
    fcpRendererMs: round(paints?.['first-contentful-paint'] ?? NaN),
    marks,
    mainStartup,
    domFirstSeen: firstSeen,
    rows: observation?.rows ?? null,
    welcomeShown: observation?.welcome ?? null,
    longTaskCount: bootLongTasks.length,
    longestTaskMs: bootLongTasks.length === 0 ? 0 : round(Math.max(...bootLongTasks.map((t) => t.duration))),
    longTasks: bootLongTasks.map((task) => ({ start: round(task.start), duration: round(task.duration) })),
    pollRoundTripMaxMs: maxRoundTripMs,
    pollsOver50ms: slowPolls,
    polls,
    palette
  }
}

guardExit()

const samples = []
try {
  for (let index = 1; index <= SAMPLES; index += 1) {
    const result = await sample(index)
    samples.push(result)
    console.log(JSON.stringify(result))
  }
} finally {
  await quit()
}

const summary = {
  label: LABEL,
  samples: samples.length,
  medians: {
    firstPaintMs: median(samples.map((s) => s.firstPaintMs)),
    fcpMs: median(samples.map((s) => s.fcpMs)),
    reactCommitted: median(samples.map((s) => s.marks.reactCommitted)),
    snapshotReady: median(samples.map((s) => s.marks.snapshotReady)),
    explorerCommitted: median(samples.map((s) => s.marks.explorerCommitted)),
    viewerCommitted: median(samples.map((s) => s.marks.viewerCommitted)),
    windowShown: median(samples.map((s) => s.mainStartup?.windowShown)),
    restoreSettled: median(samples.map((s) => s.mainStartup?.restoreSettled)),
    longestTaskMs: median(samples.map((s) => s.longestTaskMs)),
    paletteOpenMs: median(samples.map((s) => s.palette?.openMs)),
    paletteOpenAppMs: median(samples.map((s) => s.palette?.paletteOpenAppMs)),
    paletteEmptyRows: median(samples.map((s) => s.palette?.emptyRows)),
    paletteFileResultsMs: median(samples.map((s) => s.palette?.fileResultsMs)),
    paletteContentResultsMs: median(samples.map((s) => s.palette?.contentResultsMs)),
    paletteWorkspaceRenders: median(samples.map((s) => s.palette?.workspaceRenders)),
    pollRoundTripMaxMs: median(samples.map((s) => s.pollRoundTripMaxMs))
  }
}
console.log(JSON.stringify(summary))
console.log(summaryLine('startup', LABEL, {
  firstPaintMs: samples.map((s) => s.firstPaintMs),
  fcpMs: samples.map((s) => s.fcpMs),
  fcpRendererMs: samples.map((s) => s.fcpRendererMs),
  reactCommitted: samples.map((s) => s.marks.reactCommitted),
  explorerCommitted: samples.map((s) => s.marks.explorerCommitted),
  viewerCommitted: samples.map((s) => s.marks.viewerCommitted),
  windowShown: samples.map((s) => s.mainStartup?.windowShown),
  restoreSettled: samples.map((s) => s.mainStartup?.restoreSettled),
  longestTaskMs: samples.map((s) => s.longestTaskMs),
  treeRows: samples.map((s) => s.rows),
  paletteOpenMs: samples.map((s) => s.palette?.openMs),
  paletteOpenAppMs: samples.map((s) => s.palette?.paletteOpenAppMs),
  paletteEmptyRows: samples.map((s) => s.palette?.emptyRows),
  paletteContentResultsMs: samples.map((s) => s.palette?.contentResultsMs)
}))
console.log(`Appended to ${await appendResult(LABEL, { probe: 'startup', summary, samples })}`)
