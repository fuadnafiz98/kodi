// Raycast handoff latency, warm and cold, with percentiles.
//
//   bun scripts/perf/raycast-handoff-probe.mjs <label> [pull-request-url]
//
// The extension command is three steps the user waits on: parse the fallback
// text (or read the clipboard), decide whether Kodi is already running, and
// hand the deep link to macOS. Those are plain Node calls, so this probe drives
// the extension's own `sendToKodi` rather than a mock — only `Clipboard.readText`
// is substituted, by `pbpaste`, because it is the one call that needs the
// Raycast host. That substitution is named in the output.
//
// Warm runs time through to main receipt: the app is already up with a
// debugging port, so the probe can watch `getPendingExternalPullRequest`
// resolve. Cold runs cannot attach to an app that is not running yet, so they
// stop at the first moment the process exists. Both are reported separately;
// neither number is presented as the other.
import { appendResult, guardExit, launch, quit, settle, statistics } from './cdp.mjs'

const LABEL = process.argv[2] ?? 'raycast'
const PULL_REQUEST_URL = process.argv[3]
  ?? process.env.KODI_HANDOFF_PR
  ?? 'https://github.com/microsoft/TypeScript/pull/64258'
const SAMPLES = Number(process.env.SAMPLES ?? '30')
const WARMUPS = Number(process.env.WARMUPS ?? '2')
const PORT = Number(process.env.KODI_HANDOFF_PORT ?? '9474')

const { firstPullRequestUrl } = await import('../../extensions/kodi/src/lib/open.ts')
  .catch(() => ({ firstPullRequestUrl: null }))
const { formatKodiReviewUrl } = await import('../../extensions/kodi/src/lib/github.ts')
const { isKodiRunning, kodiLaunchPlan } = await import('../../extensions/kodi/src/lib/kodi.ts')

guardExit()

function now() {
  return Number(Bun.nanoseconds()) / 1_000_000
}

function readClipboard() {
  const startedAt = now()
  Bun.spawnSync(['pbpaste'])
  return now() - startedAt
}

/** One handoff, timed in the same order the extension performs it. */
async function handoff(intent) {
  const startedAt = now()
  const startedWallMs = Date.now()
  const clipboardMs = readClipboard()
  const parseStartedAt = now()
  const url = firstPullRequestUrl == null ? PULL_REQUEST_URL : firstPullRequestUrl(PULL_REQUEST_URL)
  const deepLink = formatKodiReviewUrl(url, intent)
  const parseMs = now() - parseStartedAt
  if (deepLink == null) throw new Error('The fixture URL is not a GitHub pull request URL.')

  const detectStartedAt = now()
  const running = await isKodiRunning()
  const processDetectionMs = now() - detectStartedAt

  const plan = kodiLaunchPlan({ deepLink, intent, running })
  if (plan.kind === 'none') return null

  const openStartedAt = now()
  Bun.spawnSync(['open', ...plan.args])
  const openMs = now() - openStartedAt

  return {
    startedWallMs,
    clipboardMs,
    parseMs,
    processDetectionMs,
    openMs,
    deliveredMs: now() - startedAt,
    mode: plan.kind,
    running
  }
}

// The pushed `openExternalPullRequest` event is the receipt, not the polled
// getter: reading the getter consumes the pending URL, so the app's own
// subscriber and this probe would race for it and one of them would always
// lose. Subscribing records every delivery with the wall clock the handoff is
// measured against.
const INSTALL_RECEIPT_HOOK = `(() => {
  if (window.__handoffReceipts != null) return true
  window.__handoffReceipts = []
  window.repository.onOpenExternalPullRequest((url) => {
    window.__handoffReceipts.push({ url, atMs: Date.now() })
  })
  return true
})()`

async function warmSamples(cdp, count) {
  const rows = []
  await cdp.eval(INSTALL_RECEIPT_HOOK, false)
  for (let index = 0; index < count; index += 1) {
    const before = Number(await cdp.eval(`String(window.__handoffReceipts.length)`, false) ?? '0')
    const row = await handoff('open')
    if (row == null) continue
    const arrived = await cdp.waitFor(`window.__handoffReceipts.length > ${before}`, 10_000, 5)
    const atMs = arrived.timedOut
      ? null
      : Number(await cdp.eval(`String(window.__handoffReceipts[${before}].atMs)`, false))
    row.mainReceiptMs = atMs == null || Number.isNaN(atMs) ? null : atMs - row.startedWallMs
    row.receiptTimedOut = arrived.timedOut
    rows.push(row)
  }
  return rows
}

async function coldSamples(count) {
  const rows = []
  for (let index = 0; index < count; index += 1) {
    await quit()
    const row = await handoff('open')
    if (row == null) continue
    let visible = false
    const deadline = now() + 20_000
    while (now() < deadline) {
      if (Bun.spawnSync(['pgrep', '-x', 'Kodi']).exitCode === 0) { visible = true; break }
      await Bun.sleep(10)
    }
    row.processVisibleMs = visible ? Date.now() - row.startedWallMs : null
    rows.push(row)
  }
  await quit()
  return rows
}

function summarize(rows, keys) {
  const summary = {}
  for (const key of keys) summary[key] = statistics(rows.map((row) => row[key]))
  return summary
}

const HANDOFF_KEYS = ['clipboardMs', 'parseMs', 'processDetectionMs', 'openMs', 'deliveredMs']

const cold = await coldSamples(WARMUPS + SAMPLES)
const coldRecorded = cold.slice(WARMUPS)

const { cdp } = await launch(PORT, [])
let warmRecorded = []
try {
  await settle(cdp)
  const warm = await warmSamples(cdp, WARMUPS + SAMPLES)
  warmRecorded = warm.slice(WARMUPS)
} finally {
  await quit()
}

const record = {
  probe: 'raycast-handoff',
  pullRequestUrl: PULL_REQUEST_URL,
  clipboardSource: 'pbpaste (Raycast Clipboard.readText is host-only)',
  warm: {
    samples: warmRecorded.length,
    summary: summarize(warmRecorded, [...HANDOFF_KEYS, 'mainReceiptMs']),
    rows: warmRecorded
  },
  cold: {
    samples: coldRecorded.length,
    summary: summarize(coldRecorded, [...HANDOFF_KEYS, 'processVisibleMs']),
    rows: coldRecorded
  }
}

console.log(JSON.stringify({ warm: record.warm.summary, cold: record.cold.summary }, null, 2))
console.log(`Appended to ${await appendResult(LABEL, record)}`)
