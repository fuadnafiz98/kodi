// What deep hibernation actually saves, and what waking costs.
//
//   KODI_PROBE_HIDDEN=1 KODI_PROBE_LIFECYCLE=1 \
//     bun scripts/perf/hibernation-probe.mjs <label> [pull-request-url]
//
// Measuring this wrong is easy, and the first attempt did: comparing memory at
// startup against memory 31 seconds later measures the session loading, not the
// release, and an app showing a folder has no review payload to release at all.
//
// So this probe:
//   1. opens a large pull request, so there is a payload worth releasing,
//   2. samples with the review loaded and the window visible,
//   3. hides, waits past the grace period, and lets main drive hibernation,
//   4. forces a collection before sampling again, because V8 does not return
//      anything on its own and an unforced sample reads as "no saving",
//   5. reveals the window and times how long until the review is usable again.
//
// The plan's bar is a 20% physical-footprint saving and a wake penalty inside
// 250 ms. Both numbers are reported whether or not they clear it.
import { APP_BINARY, appendResult, guardExit, launch, quit, settle } from './cdp.mjs'

const LABEL = process.argv[2] ?? 'hibernation'
const PULL_REQUEST_URL = process.argv[3]
  ?? process.env.KODI_HIBERNATION_PR
  ?? 'https://github.com/microsoft/TypeScript/pull/53463'
const PORT = Number(process.env.KODI_HIBERNATION_PORT ?? '9475')
const GRACE_MS = Number(process.env.KODI_HIBERNATION_GRACE_MS ?? '34000')
const SAMPLES = Number(process.env.SAMPLES ?? '5')

guardExit()

const METRICS = `window.repository.getPerformanceMetrics(true).then((m) => JSON.stringify({
  state: m.detail?.lifecycleState ?? null,
  hibernated: m.detail?.hibernated ?? null,
  blockedBy: m.detail?.hibernationBlockedBy ?? null,
  rendererPrivateMb: m.rendererPrivateMegabytes ?? null,
  workingSetMb: m.workingSetMegabytes ?? null,
  rendererHeapMb: m.detail?.rendererHeapUsedMegabytes ?? null,
  domNodes: m.detail?.rendererDomNodes ?? null
}))`

async function read(cdp) {
  const raw = await cdp.eval(METRICS, true)
  return raw == null ? null : JSON.parse(raw)
}

/**
 * V8 hands nothing back until it collects, so an unforced sample reports a
 * release that happened as no saving at all.
 */
async function collectGarbage(cdp) {
  await cdp.send('HeapProfiler.enable').catch(() => undefined)
  await cdp.send('HeapProfiler.collectGarbage').catch(() => undefined)
  await Bun.sleep(1_200)
}

const REVIEW_LOADED = `document.querySelectorAll('.multi-file-review .multi-file-code-view').length > 0`

async function runSample(index) {
  const { cdp } = await launch(PORT + index, [
    `--kodi-url=kodi://review?url=${encodeURIComponent(PULL_REQUEST_URL)}`
  ])
  const sample = { sample: index }
  try {
    await settle(cdp)
    const loaded = await cdp.waitFor(REVIEW_LOADED, 60_000, 20)
    sample.reviewLoaded = !loaded.timedOut
    if (loaded.timedOut) return sample
    await Bun.sleep(1_500)

    await collectGarbage(cdp)
    sample.visible = await read(cdp)

    await cdp.eval('window.repository.setVisibility(false)', true)
    await Bun.sleep(GRACE_MS)
    await collectGarbage(cdp)
    sample.snoozed = await read(cdp)

    // Wake through the same second-instance reveal a user gets from Raycast,
    // and time to the review being on screen again rather than to the event.
    const wokeAt = Date.now()
    Bun.spawnSync([APP_BINARY], { stdout: 'ignore', stderr: 'ignore' })
    const back = await cdp.waitFor(REVIEW_LOADED, 30_000, 10)
    sample.wakeToUsableMs = back.at == null ? null : back.at - wokeAt
    sample.wakeTimedOut = back.timedOut
    sample.resumed = await read(cdp)

    const visible = sample.visible
    const snoozed = sample.snoozed
    if (visible != null && snoozed != null) {
      sample.rendererPrivateSavedMb = round(visible.rendererPrivateMb - snoozed.rendererPrivateMb)
      sample.rendererPrivateSavedPercent = percent(visible.rendererPrivateMb, snoozed.rendererPrivateMb)
      sample.workingSetSavedMb = round(visible.workingSetMb - snoozed.workingSetMb)
      sample.workingSetSavedPercent = percent(visible.workingSetMb, snoozed.workingSetMb)
      sample.heapSavedMb = round(visible.rendererHeapMb - snoozed.rendererHeapMb)
      sample.heapSavedPercent = percent(visible.rendererHeapMb, snoozed.rendererHeapMb)
    }
  } finally {
    await quit()
  }
  return sample
}

function round(value) {
  return value == null || Number.isNaN(value) ? null : Math.round(value * 100) / 100
}

function percent(before, after) {
  if (before == null || after == null || before === 0) return null
  return Math.round(((before - after) / before) * 1_000) / 10
}

function median(values) {
  const numbers = values.filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right)
  if (numbers.length === 0) return null
  return numbers[Math.floor((numbers.length - 1) / 2)]
}

const samples = []
for (let index = 0; index < SAMPLES; index += 1) {
  samples.push(await runSample(index))
}

const summary = {
  pullRequestUrl: PULL_REQUEST_URL,
  samples: samples.length,
  reviewLoaded: samples.filter((sample) => sample.reviewLoaded).length,
  hibernated: samples.filter((sample) => sample.snoozed?.hibernated === true).length,
  blockedBy: [...new Set(samples.map((sample) => sample.snoozed?.blockedBy).filter(Boolean))],
  medianRendererPrivateSavedMb: median(samples.map((sample) => sample.rendererPrivateSavedMb)),
  medianRendererPrivateSavedPercent: median(samples.map((sample) => sample.rendererPrivateSavedPercent)),
  medianWorkingSetSavedPercent: median(samples.map((sample) => sample.workingSetSavedPercent)),
  medianHeapSavedPercent: median(samples.map((sample) => sample.heapSavedPercent)),
  medianWakeToUsableMs: median(samples.map((sample) => sample.wakeToUsableMs))
}

console.log(JSON.stringify(summary, null, 2))
console.log(`Appended to ${await appendResult(LABEL, { probe: 'hibernation', summary, samples })}`)
