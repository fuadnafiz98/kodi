// Ten minutes of hidden-idle CPU, integrated rather than sampled once.
//
//   KODI_PROBE_HIDDEN=1 KODI_PROBE_LIFECYCLE=1 bun scripts/perf/idle-cpu-probe.mjs [folder]
//
// The plan's budget is "measure idle CPU-time deltas over ten minutes and
// require no increase against baseline". A point-in-time percentage cannot show
// that: a timer that wakes twice a minute reads 0.0% every time you look at it.
// This reads cumulative CPU *time* from `ps -o time=` across the whole process
// tree, so every tick between the two reads is counted whether or not a sample
// happened to land on it.
import { guardExit, launch, quit, settle } from './cdp.mjs'

const FOLDER = process.argv[2] ?? process.cwd()
const PORT = Number(process.env.KODI_IDLE_PORT ?? '9473')
const IDLE_MS = Number(process.env.KODI_IDLE_MS ?? '600000')
const SETTLE_AFTER_SNOOZE_MS = Number(process.env.KODI_IDLE_SETTLE_MS ?? '35000')

guardExit()

function treePids(rootPid) {
  const listing = Bun.spawnSync(['ps', '-axo', 'pid=,ppid=']).stdout.toString()
  const parents = new Map()
  for (const line of listing.trim().split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/)
    parents.set(pid, parent)
  }
  const included = new Set([String(rootPid)])
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, parent] of parents) {
      if (!included.has(pid) && included.has(parent)) {
        included.add(pid)
        changed = true
      }
    }
  }
  return [...included]
}

/** `ps -o time=` prints cumulative CPU as [[dd-]hh:]mm:ss. */
function cpuSeconds(pids) {
  if (pids.length === 0) return 0
  const output = Bun.spawnSync(['ps', '-p', pids.join(','), '-o', 'time=']).stdout.toString()
  let total = 0
  for (const line of output.trim().split('\n')) {
    const text = line.trim()
    if (text === '') continue
    const [clock, days] = text.split('-').reverse()
    const parts = clock.split(':').map(Number)
    while (parts.length < 3) parts.unshift(0)
    total += (Number(days ?? 0) * 86_400) + (parts[0] * 3_600) + (parts[1] * 60) + parts[2]
  }
  return total
}

function rootPid() {
  const found = Bun.spawnSync(['pgrep', '-x', 'Kodi']).stdout.toString().trim().split('\n').filter(Boolean)
  if (found.length !== 1) throw new Error(`Expected exactly one Kodi root process, found ${found.length}.`)
  return found[0]
}

const METRICS = `window.repository.getPerformanceMetrics(true).then((m) => JSON.stringify({
  state: m.detail?.lifecycleState ?? null,
  watchers: m.detail?.watcherCount ?? null,
  pending: m.detail?.pendingWatcherPaths ?? null
}))`

const { cdp } = await launch(PORT, ['--kodi-folder', FOLDER])
const report = { idleMs: IDLE_MS }
try {
  await settle(cdp)
  const pid = rootPid()

  await cdp.eval('window.repository.setVisibility(false)', true)
  // Let the grace period elapse and the snooze settle before the clock starts,
  // so the teardown work itself is not charged to the idle window.
  await Bun.sleep(SETTLE_AFTER_SNOOZE_MS)

  const before = await cdp.eval(METRICS, true)
  report.stateAtStart = before == null ? null : JSON.parse(before)
  const pidsBefore = treePids(pid)
  const cpuBefore = cpuSeconds(pidsBefore)
  const startedAt = Date.now()

  await Bun.sleep(IDLE_MS)

  const pidsAfter = treePids(pid)
  const cpuAfter = cpuSeconds(pidsAfter)
  const elapsedMs = Date.now() - startedAt
  const after = await cdp.eval(METRICS, true)

  report.stateAtEnd = after == null ? null : JSON.parse(after)
  report.processCountStart = pidsBefore.length
  report.processCountEnd = pidsAfter.length
  report.cpuSecondsConsumed = Math.round((cpuAfter - cpuBefore) * 100) / 100
  report.elapsedMs = elapsedMs
  report.cpuPercentOfOneCore = Math.round((report.cpuSecondsConsumed / (elapsedMs / 1_000)) * 10_000) / 100
  report.stayedSnoozed = report.stateAtStart?.state === 'snoozed' && report.stateAtEnd?.state === 'snoozed'
  report.noProcessGrowth = pidsAfter.length <= pidsBefore.length
} finally {
  await quit()
}

console.log(JSON.stringify(report, null, 2))
