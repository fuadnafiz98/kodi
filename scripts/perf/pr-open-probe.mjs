// `open kodi://review?url=<pr>` against a warm app, then against a cold one:
// how long until the review tab, the review surface, the first file page and
// the first code view.
//
//   PRS=https://github.com/owner/repo/pull/1 bun scripts/perf/pr-open-probe.mjs after
import {
  appendResult,
  guardExit,
  HOOKS,
  launch,
  quit,
  run,
  settle,
  summaryLine
} from './cdp.mjs'
import { createTimeline, summarizePullRequestProgress } from './timeline.mjs'

const LABEL = process.argv[2] ?? 'run'
const PRS = (process.env.PRS ?? '').split(',').map((value) => value.trim()).filter((value) => value !== '')

if (PRS.length === 0) {
  console.error('Set PRS to a comma-separated list of pull request URLs.')
  process.exit(2)
}

// One deadline for the whole open. Waiting for each condition in turn with its
// own 45-60 s timeout is how a missing `files` event turned a first code view
// that was on screen in a second into a reported 106,205 ms.
const OPEN_TIMEOUT_MS = Number(process.env.PR_TIMEOUT_MS ?? '20000')
const POLL_MS = 5

const OBSERVATION = `(() => ({
  tab: document.querySelectorAll('.world-tab').length >= 2
    || document.querySelector('.pr-loading-indicator') != null
    || document.querySelector('.multi-file-review') != null,
  surface: document.querySelector('.multi-file-review') != null,
  codeView: document.querySelectorAll('.multi-file-review .multi-file-code-view').length > 0,
  events: (window.__probe?.pr ?? []).map((event) => ({
    t: event.t,
    kind: event.kind,
    files: event.files,
    fileCount: event.fileCount
  }))
}))()`

/**
 * Polls one expression until the review is done and painted, recording the first
 * time every condition was true. Whatever has not happened by the deadline stays
 * null instead of delaying the conditions behind it.
 */
async function measure(cdp, pullRequest, mode, startedAt) {
  const record = { pullRequest, mode }
  const timeline = createTimeline(startedAt)
  let maxRoundTripMs = 0
  let slowPolls = 0
  let events = []
  const deadline = startedAt + OPEN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const pollStartedAt = Date.now()
    const next = await cdp.tryEval(OBSERVATION)
    const roundTripMs = Date.now() - pollStartedAt
    if (roundTripMs > maxRoundTripMs) maxRoundTripMs = roundTripMs
    if (roundTripMs > 50) slowPolls += 1
    if (next != null) {
      events = next.events
      timeline.markIf('tab', next.tab)
      timeline.markIf('surface', next.surface)
      timeline.markIf('codeView', next.codeView)
      if (events.some((event) => event.kind === 'done') && timeline.has('codeView')) break
    }
    await Bun.sleep(POLL_MS)
  }

  const progress = summarizePullRequestProgress(events, startedAt)
  record.tabOrLoadingMs = timeline.at('tab')
  record.reviewSurfaceMs = timeline.at('surface')
  record.metadataMs = progress.metadataMs
  record.firstPageMs = progress.firstPageMs
  record.doneMs = progress.doneMs
  record.fileCount = progress.fileCount
  record.firstCodeViewMs = timeline.at('codeView')
  // Every kind the renderer saw, including the ones later waves add
  // (`replace`, `checks`), so a new event never goes unmeasured.
  record.progressKinds = progress.progressKinds
  record.timedOut = record.doneMs == null || record.firstCodeViewMs == null
  record.rendererMaxRoundTripMs = maxRoundTripMs
  record.rendererSlowPolls = slowPolls
  return record
}

async function warmRuns() {
  const records = []
  const { cdp } = await launch(9495)
  try {
    await settle(cdp)
    await cdp.eval(HOOKS)
    await Bun.sleep(1_000)
    for (const pullRequest of PRS) {
      await cdp.eval(`window.__probe.pr.length = 0`)
      const startedAt = Date.now()
      await run(['open', `kodi://review?url=${encodeURIComponent(pullRequest)}`])
      const record = await measure(cdp, pullRequest, 'warm-app', startedAt)
      records.push(record)
      console.log(JSON.stringify(record))
      await Bun.sleep(1_500)
    }
  } finally {
    cdp.socket.close()
  }
  return records
}

// The app is not running, so the URL cannot go through the scheme handler; the
// argv form is the same path the Raycast fallback uses.
async function coldRun(pullRequest) {
  const port = 9497
  const { cdp, startedAt } = await launch(port, [
    `--kodi-url=kodi://review?url=${encodeURIComponent(pullRequest)}`
  ])
  try {
    // Progress events fired before the hook exists are lost, so install it as
    // early as the bridge allows and lean on the DOM gates for the rest.
    const hooked = await cdp.waitFor(`window.repository != null ? (${HOOKS}) : false`, 20_000, 2)
    const record = await measure(cdp, pullRequest, 'cold-app', startedAt)
    record.hooksInstalledMs = hooked.at == null ? null : hooked.at - startedAt
    record.windowShownMs = await cdp.tryEval(
      `window.repository.getPerformanceMetrics(true).then((m) => m.detail?.mainStartup?.windowShown ?? null)`,
      true
    )
    console.log(JSON.stringify(record))
    return record
  } finally {
    cdp.socket.close()
  }
}

guardExit()

// A warm reopen of a pull request that already has a tab is absorbed by that
// tab and emits no progress at all, so repeating one URL in a warm app measures
// a single open and then nothing. Each cold run is a fresh process, which is a
// genuine first open every time, so the samples come from there — and that is
// also the scenario the plan asks about (Cmd+H from a cold app).
const COLD_SAMPLES = Number(process.env.COLD_SAMPLES ?? process.env.SAMPLES ?? '1')

const records = []
try {
  records.push(...await warmRuns())
  for (const pullRequest of new Set(PRS)) {
    for (let sample = 0; sample < COLD_SAMPLES; sample += 1) {
      records.push(await coldRun(pullRequest))
    }
  }
} finally {
  await quit()
}

const summary = { label: LABEL, records }
console.log(JSON.stringify(summary))
const warm = records.filter((record) => record.mode === 'warm-app')
console.log(summaryLine('pr-open', LABEL, {
  warmSurfaceMs: warm.map((record) => record.reviewSurfaceMs),
  warmMetadataMs: warm.map((record) => record.metadataMs),
  warmFirstPageMs: warm.map((record) => record.firstPageMs),
  warmDoneMs: warm.map((record) => record.doneMs),
  warmCodeViewMs: warm.map((record) => record.firstCodeViewMs),
  coldSurfaceMs: records.filter((record) => record.mode === 'cold-app').map((record) => record.reviewSurfaceMs),
  coldMetadataMs: records.filter((record) => record.mode === 'cold-app').map((record) => record.metadataMs),
  coldFirstPageMs: records.filter((record) => record.mode === 'cold-app').map((record) => record.firstPageMs),
  coldDoneMs: records.filter((record) => record.mode === 'cold-app').map((record) => record.doneMs),
  coldCodeViewMs: records.filter((record) => record.mode === 'cold-app').map((record) => record.firstCodeViewMs)
}))
console.log(`Appended to ${await appendResult(LABEL, { probe: 'pr-open', summary })}`)
