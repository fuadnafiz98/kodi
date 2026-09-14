// Resting memory of the installed app's own process tree, plus the memory it
// gives back when a review is closed.
//
//   bun scripts/perf/memory-probe.mjs <label> [folder]
//
// The sampler is `scripts/benchmark-memory.sh`, which is handed an explicit
// root PID so it never guesses between Kodi instances and refuses to sample
// until the tree is quiet. Two labels are comparable only when both runs say
// `quiesced=true`: a tree still spawning `git` measures the work, not the rest.
import { join } from 'node:path'

import { APP_BINARY, guardExit, launch, quit, settle } from './cdp.mjs'

const LABEL = process.argv[2] ?? 'memory'
const FOLDER = process.argv[3] ?? process.cwd()
const PORT = Number(process.env.KODI_MEMORY_PORT ?? '9471')
const PERF_DIRECTORY = new URL('.', import.meta.url).pathname

guardExit()

async function rootPid() {
  // `-x Kodi` is the root process only: the helpers are named "Kodi Helper".
  // Matching the binary path with `-f` does not work, because the root process
  // is exec'd with its own argv and pgrep sees the truncated command.
  const found = Bun.spawnSync(['pgrep', '-x', 'Kodi'])
  const pids = found.stdout.toString().trim().split('\n').filter(Boolean)
  if (pids.length !== 1) {
    throw new Error(`Expected exactly one Kodi root process, found ${pids.length}. Refusing to guess.`)
  }
  return pids[0]
}

async function rendererPrivateMegabytes(cdp) {
  const raw = await cdp.eval(
    'window.repository.getPerformanceMetrics(true).then((m) => JSON.stringify({' +
      'renderer: m.rendererPrivateMegabytes, working: m.workingSetMegabytes,' +
      'main: m.detail?.mainPrivateMegabytes ?? null, heap: m.detail?.rendererHeapUsedMegabytes ?? null,' +
      'dom: m.detail?.rendererDomNodes ?? null, conversations: m.detail?.conversationCacheEntries ?? null,' +
      'watchers: m.detail?.watcherCount ?? null }))',
    true
  )
  return raw == null ? null : JSON.parse(raw)
}

const { cdp } = await launch(PORT, ['--kodi-folder', FOLDER])
try {
  await settle(cdp)
  const pid = await rootPid()

  const afterOpen = await rendererPrivateMegabytes(cdp)

  const sampler = Bun.spawnSync(['bash', join(PERF_DIRECTORY, '..', 'benchmark-memory.sh'), `${LABEL}-memory`], {
    env: {
      ...process.env,
      KODI_ROOT_PID: pid,
      KODI_PERF_SAMPLES: process.env.KODI_PERF_SAMPLES ?? '30',
      KODI_PERF_INTERVAL: process.env.KODI_PERF_INTERVAL ?? '1'
    }
  })
  process.stdout.write(sampler.stdout.toString())
  if (sampler.exitCode !== 0) process.stderr.write(sampler.stderr.toString())

  // Retained memory: close every review world, let the renderer settle, and
  // read the same counters again. A world that is evicted on paper but still
  // reachable shows up here and nowhere else.
  await cdp.eval(
    `(() => { const c = document.querySelectorAll('.world-tab .world-close');` +
      ` c.forEach((b) => b.click()); return c.length })()`,
    false
  )
  await Bun.sleep(3_000)
  const afterClose = await rendererPrivateMegabytes(cdp)

  console.log('')
  console.log('retained,phase,renderer_private_mb,working_set_mb,main_private_mb,renderer_heap_mb,dom_nodes,conversation_entries,watchers')
  for (const [phase, value] of [['after-open', afterOpen], ['after-close', afterClose]]) {
    if (value == null) { console.log(`retained,${phase},null,null,null,null,null,null,null`); continue }
    console.log(
      `retained,${phase},${value.renderer},${value.working},${value.main},${value.heap},${value.dom},${value.conversations},${value.watchers}`
    )
  }
} finally {
  await quit()
}
