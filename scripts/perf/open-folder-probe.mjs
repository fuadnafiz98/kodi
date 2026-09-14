// Cmd+O -> type a folder name -> Enter, measured to three moments: the explorer
// heading for the folder, its first tree rows, and the live snapshot (the first
// moment the folder is usable rather than a path skeleton).
//
//   FOLDERS=imux,materialsx-core-3 bun scripts/perf/open-folder-probe.mjs after
import { appendResult, guardExit, HOOKS, launch, LONG_TASKS, quit, round, summaryLine, TREE_ROW_COUNT } from './cdp.mjs'
import { createTimeline } from './timeline.mjs'

const LABEL = process.argv[2] ?? 'run'
const FOLDERS = (process.env.FOLDERS ?? 'imux,materialsx-core-3,imux,kodi').split(',')

// One deadline for the whole open, not one per condition: a condition that never
// arrives must not push the ones after it out by its own timeout.
const OPEN_TIMEOUT_MS = Number(process.env.OPEN_TIMEOUT_MS ?? '20000')
const POLL_MS = 5

/**
 * Everything the open is timed against, in one round trip.
 *
 * The explorer heading holds the sidebar toggle and the branch, never the folder
 * name, so the folder's own identity is the active world tab (its label is the
 * snapshot name). The branch is what separates a skeleton from a live snapshot:
 * `listRootSnapshot` has `branch: null`, which the heading renders as
 * "Detached HEAD", and a live git snapshot always names a branch. That matters
 * because an open whose refresh wins the 150 ms race answers over IPC and
 * publishes nothing at all, so `onDidChange` alone can never see it.
 */
function observation(folder) {
  const name = JSON.stringify(folder)
  return `(() => {
    const active = document.querySelector('.world-tab[data-active="true"] .world-label')
    const named = active != null && active.textContent.trim() === ${name}
    const branchNode = document.querySelector('#repository-explorer .chrome-branch-button span')
    const branch = branchNode == null ? null : branchNode.textContent.trim()
    const published = (window.__probe?.changes ?? []).find((change) =>
      change.root.endsWith('/' + ${name}) && (change.branch != null || change.stage === 'live')) ?? null
    return {
      heading: named && document.querySelector('#repository-explorer .sidebar-heading') != null,
      rows: named ? ${TREE_ROW_COUNT} : 0,
      branch: named && branch !== null && branch !== '' && branch !== 'Detached HEAD' ? branch : null,
      published,
      fileCount: document.querySelector('#repository-explorer .sidebar-file-count')?.textContent ?? null
    }
  })()`
}

async function openFolder(cdp, folder) {
  const record = { folder }
  const startedAt = Date.now()
  await cdp.combo('o', 'KeyO', 79, 4)

  const picker = await cdp.waitFor(
    `(() => { const i = document.querySelector('.folder-picker input'); return i != null && document.activeElement === i })()`,
    5_000
  )
  record.pickerOpenMs = picker.at == null ? null : picker.at - startedAt

  const rows = await cdp.waitFor(`document.querySelectorAll('.folder-picker-results button').length > 0`, 5_000)
  record.pickerRowsMs = rows.at == null ? null : rows.at - startedAt

  await cdp.type(folder)
  const match = await cdp.waitFor(
    `(() => {
      const button = document.querySelector('.folder-picker-results button.primary-result')
      return button != null && button.textContent.includes(${JSON.stringify(folder)}) ? button.textContent : null
    })()`,
    5_000
  )
  record.matchedRow = match.value

  await cdp.eval(`window.__probe.changes.length = 0`)
  const enteredAt = Date.now()
  await cdp.enter()

  const expression = observation(folder)
  const timeline = createTimeline(enteredAt)
  let maxRoundTripMs = 0
  let slowPolls = 0
  let last = null
  const deadline = enteredAt + OPEN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const pollStartedAt = Date.now()
    const next = await cdp.tryEval(expression)
    const roundTripMs = Date.now() - pollStartedAt
    if (roundTripMs > maxRoundTripMs) maxRoundTripMs = roundTripMs
    if (roundTripMs > 50) slowPolls += 1
    if (next != null) {
      last = next
      timeline.markIf('heading', next.heading)
      timeline.markIf('treeRows', next.rows > 0)
      timeline.markIf('branch', next.branch != null)
      if (next.published != null) timeline.mark('published', next.published.t)
      if (timeline.has('treeRows') && (timeline.has('branch') || timeline.has('published'))) break
    }
    await Bun.sleep(POLL_MS)
  }

  record.headingMs = timeline.at('heading')
  record.treeRowsMs = timeline.at('treeRows')
  record.branchMs = timeline.at('branch')
  record.publishedMs = timeline.at('published')
  // Either source proves the live snapshot reached the renderer; the earlier one
  // is when the folder actually became usable.
  const liveCandidates = [record.branchMs, record.publishedMs].filter((value) => value != null)
  record.liveSnapshotMs = liveCandidates.length === 0 ? null : Math.min(...liveCandidates)
  record.liveSource = record.liveSnapshotMs == null
    ? null
    : record.liveSnapshotMs === record.publishedMs ? 'change' : 'dom'
  record.branch = last?.branch ?? null
  record.fileCount = last?.fileCount ?? null
  record.live = last?.published ?? null
  record.timedOut = record.liveSnapshotMs == null || record.treeRowsMs == null

  record.rendererMaxRoundTripMs = Math.max(picker.maxRoundTripMs, rows.maxRoundTripMs, maxRoundTripMs)
  record.rendererSlowPolls = picker.slowPolls + rows.slowPolls + slowPolls
  record.pickerStillOpen = await cdp.tryEval(`document.querySelector('.folder-picker') != null`)
  if (record.pickerStillOpen === true) await cdp.escape()
  return record
}

guardExit()

const summary = { label: LABEL, opens: [] }
try {
  const { cdp, startedAt } = await launch(9490)
  const hooked = await cdp.waitFor(`window.repository != null ? (${HOOKS}) : false`, 25_000, 20)
  summary.hooksInstalledMs = hooked.at == null ? null : hooked.at - startedAt
  await Bun.sleep(800)

  try {
    for (const folder of FOLDERS) {
      const record = await openFolder(cdp, folder)
      summary.opens.push(record)
      console.log(JSON.stringify(record))
      await Bun.sleep(1_500)
    }
    const longTasks = (await cdp.tryEval(LONG_TASKS)) ?? []
    summary.longTasksOver50ms = longTasks
      .filter((task) => task.duration >= 50)
      .map((task) => ({ start: round(task.start), duration: round(task.duration) }))
  } finally {
    cdp.socket.close()
  }
} finally {
  await quit()
}

console.log(JSON.stringify(summary))
console.log(summaryLine('open-folder', LABEL, {
  pickerOpenMs: summary.opens.map((open) => open.pickerOpenMs),
  headingMs: summary.opens.map((open) => open.headingMs),
  treeRowsMs: summary.opens.map((open) => open.treeRowsMs),
  liveSnapshotMs: summary.opens.map((open) => open.liveSnapshotMs)
}))
console.log(`Appended to ${await appendResult(LABEL, { probe: 'open-folder', summary })}`)
