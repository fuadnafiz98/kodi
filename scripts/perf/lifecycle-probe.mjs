// Hidden-idle behaviour, measured against the installed app.
//
//   KODI_PROBE_HIDDEN=1 KODI_PROBE_LIFECYCLE=1 bun scripts/perf/lifecycle-probe.mjs [folder]
//
// The plan's snooze budget is "zero watcher handles, zero pending paths, zero
// queued or running commands, and no periodic reads" after the hidden grace
// period, then exactly one authoritative refresh on resume. This probe reads
// those counters out of `getPerformanceMetrics`, which is the only place the
// main process publishes them.
//
// Resume launches the app binary a second time. The single-instance lock makes
// that process exit and hand its argv to the running one, which is exactly the
// second-instance reveal a user gets from Raycast or `kodi .` — and the only
// resume path available here, because an app whose window was never shown
// cannot be resumed by a claim from its own renderer: main ignores that.
import { APP_BINARY, guardExit, launch, quit, settle } from './cdp.mjs'

const FOLDER = process.argv[2] ?? process.cwd()
const PORT = Number(process.env.KODI_LIFECYCLE_PORT ?? '9472')
const GRACE_MS = Number(process.env.KODI_LIFECYCLE_GRACE_MS ?? '31000')

guardExit()

const METRICS = `window.repository.getPerformanceMetrics(true).then((m) => JSON.stringify({
  state: m.detail?.lifecycleState ?? null,
  watchers: m.detail?.watcherCount ?? null,
  pending: m.detail?.pendingWatcherPaths ?? null,
  running: m.detail?.commandRunning ?? null,
  waiting: m.detail?.commandWaiting ?? null,
  conversations: m.detail?.conversationCacheEntries ?? null,
  hibernated: m.detail?.hibernated ?? null,
  hibernationBlockedBy: m.detail?.hibernationBlockedBy ?? null,
  rendererPrivateMb: m.rendererPrivateMegabytes ?? null,
  workingSetMb: m.workingSetMegabytes ?? null,
  transitions: m.detail?.lifecycleTransitions ?? null
}))`

async function read(cdp) {
  const raw = await cdp.eval(METRICS, true)
  return raw == null ? { state: null, unavailable: true } : JSON.parse(raw)
}

const { cdp } = await launch(PORT, ['--kodi-folder', FOLDER])
const report = {}
try {
  await settle(cdp)
  report.visible = await read(cdp)

  await cdp.eval('window.repository.setVisibility(false)', true)
  await Bun.sleep(GRACE_MS)
  report.snoozed = await read(cdp)

  Bun.spawnSync([APP_BINARY], { stdout: 'ignore', stderr: 'ignore' })
  await Bun.sleep(4_000)
  report.resumed = await read(cdp)

  const snoozed = report.snoozed
  report.checks = {
    reachedSnooze: snoozed.state === 'snoozed',
    zeroWatchers: snoozed.watchers === 0,
    zeroPendingPaths: snoozed.pending === 0,
    idleCommandLanes: snoozed.running === 0 && snoozed.waiting === 0,
    resumedVisible: report.resumed.state === 'visible',
    resumedOneWatcher: report.resumed.watchers === 1,
    // Deep hibernation is reported, never asserted as a pass: an app with a
    // terminal open or unsaved edits is supposed to refuse.
    hibernationAttempted: snoozed.hibernated !== null
  }
  report.hibernation = {
    hibernated: snoozed.hibernated,
    blockedBy: snoozed.hibernationBlockedBy,
    rendererPrivateMbVisible: report.visible.rendererPrivateMb,
    rendererPrivateMbSnoozed: snoozed.rendererPrivateMb,
    workingSetMbVisible: report.visible.workingSetMb,
    workingSetMbSnoozed: snoozed.workingSetMb,
    rendererPrivateSavedMb: report.visible.rendererPrivateMb == null || snoozed.rendererPrivateMb == null
      ? null
      : Math.round((report.visible.rendererPrivateMb - snoozed.rendererPrivateMb) * 100) / 100
  }
  report.pass = Object.values(report.checks).every(Boolean)
} finally {
  await quit()
}

console.log(JSON.stringify(report, null, 2))
process.exit(report.pass === true ? 0 : 1)
