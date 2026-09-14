// Repeatable cold-start numbers for the installed app.
//
//   KODI_STARTUP_SAMPLES=5 bun scripts/benchmark-startup.mjs
//
// It gates on the renderer's own startup marks and on `#repository-diff > *`,
// never on a review-specific class: a restore into the file view is a perfectly
// normal startup and used to make this script throw instead of report. A sample
// that runs out of time is reported with nulls rather than aborting the run.
import { launch, median, quit, round, startupMarks } from './perf/cdp.mjs'

const SAMPLE_COUNT = Number.parseInt(process.env.KODI_STARTUP_SAMPLES ?? '5', 10)
const TIMEOUT_MS = Number.parseInt(process.env.KODI_STARTUP_TIMEOUT_MS ?? '20000', 10)

if (!Number.isInteger(SAMPLE_COUNT) || SAMPLE_COUNT < 1) {
  throw new Error('KODI_STARTUP_SAMPLES must be a positive integer.')
}

const OBSERVATION = `({
  timeOrigin: performance.timeOrigin,
  paints: Object.fromEntries(performance.getEntriesByType('paint').map((e) => [e.name, e.startTime])),
  marks: Object.fromEntries(performance.getEntriesByType('mark')
    .filter((e) => e.name.startsWith('kodi:'))
    .map((e) => [e.name, e.startTime])),
  explorer: document.querySelector('#repository-explorer') != null,
  viewer: document.querySelector('#repository-diff > *') != null
})`

async function sampleStartup(index) {
  const { cdp, startedAt } = await launch(9460 + index)
  const deadline = Date.now() + TIMEOUT_MS
  let observation = null
  let explorerUsableAt = null
  let viewerUsableAt = null

  while (Date.now() < deadline) {
    const next = await cdp.tryEval(OBSERVATION)
    if (next != null) {
      observation = next
      const now = Date.now()
      if (observation.explorer && explorerUsableAt == null) explorerUsableAt = now
      const viewerReady = observation.viewer || startupMarks(observation.marks).viewerCommitted != null
      if (viewerReady && viewerUsableAt == null) viewerUsableAt = now
      if (explorerUsableAt != null && viewerUsableAt != null) break
    }
    await Bun.sleep(3)
  }

  const mainStartup = await cdp.tryEval(
    `window.repository.getPerformanceMetrics(true).then((m) => m.detail?.mainStartup ?? null)`,
    true
  )
  cdp.socket.close()

  const originOffset = observation == null ? 0 : observation.timeOrigin - startedAt
  const marks = startupMarks(observation?.marks, originOffset)

  return {
    sample: index,
    timedOut: explorerUsableAt == null || viewerUsableAt == null,
    navigationMs: observation == null ? null : round(originOffset),
    firstPaintMs: round(originOffset + (observation?.paints?.['first-paint'] ?? NaN)),
    firstContentfulPaintMs: round(originOffset + (observation?.paints?.['first-contentful-paint'] ?? NaN)),
    reactCommittedMs: marks.reactCommitted ?? null,
    snapshotReadyMs: marks.snapshotReady ?? null,
    explorerCommittedMs: marks.explorerCommitted ?? null,
    viewerCommittedMs: marks.viewerCommitted ?? null,
    explorerUsableMs: explorerUsableAt == null ? null : explorerUsableAt - startedAt,
    viewerUsableMs: viewerUsableAt == null ? null : viewerUsableAt - startedAt,
    windowShownMs: round(mainStartup?.windowShown),
    restoreSettledMs: round(mainStartup?.restoreSettled)
  }
}

const samples = []
try {
  for (let index = 1; index <= SAMPLE_COUNT; index += 1) {
    const result = await sampleStartup(index)
    samples.push(result)
    console.log(JSON.stringify(result))
  }
} finally {
  await quit()
}

const TIMINGS = [
  'navigationMs',
  'firstPaintMs',
  'firstContentfulPaintMs',
  'reactCommittedMs',
  'snapshotReadyMs',
  'explorerCommittedMs',
  'viewerCommittedMs',
  'explorerUsableMs',
  'viewerUsableMs',
  'windowShownMs',
  'restoreSettledMs'
]
const medians = Object.fromEntries(TIMINGS.map((name) => [name, median(samples.map((sample) => sample[name]))]))
console.log(JSON.stringify({
  samples: samples.length,
  timedOut: samples.filter((sample) => sample.timedOut).length,
  medians
}))
