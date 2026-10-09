// The review's Guide view with a scripted guide: Diff | Guide asks the disk
// only (no model call) until Generate; a generated guide shows its header and
// first section, reorders the review into the guide's order with a pill on
// each section's first file, `}` moves by section and the column follows; ⌘⇧G
// goes back to the diff in path order and returns without a new request; a
// file changed under a working-tree guide marks it stale; a restart comes back
// on the Guide, served from the cache. Toggling costs no long task.
//
// The old build has no Guide: it fails at the switch.
//
//   bun run build && bun scripts/e2e/review-guide.e2e.mjs
//
// The guide is answered in main (the `review-guide:get` handler is replaced
// through the main inspector), so no CLI or sign-in is needed. The model-facing
// pipeline (digest, schema, normalisation, cache) is covered by its unit tests.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRepository, git, launchApp, openInRunningApp, press, removeLater, runSuite, takeLongTasks } from './harness.mjs'

const PATHS = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'test/a.test.ts']
// Path order is a, b, c, test; the guide reads c, b, a, test.
const GUIDE_ORDER = ['src/c.ts', 'src/b.ts', 'src/a.ts', 'test/a.test.ts']
const TITLE = 'Callers learn the new parser'

const source = (name, edited) => Array.from({ length: 40 }, (_unused, line) =>
  `export const ${name}${line} = ${edited && line % 9 === 4 ? line * 2 : line}\n`).join('')

// Answers guide requests: a cache-only ask is answered only once a guide was
// "stored" (`seeded`), a generate sends two phases and then the guide.
async function installFakeGuide({ main }, { seeded }) {
  const result = await main.send('Runtime.evaluate', {
    includeCommandLineAPI: true,
    returnByValue: true,
    expression: `(() => {
      const { ipcMain } = require('electron')
      globalThis.__e2eGuideRequests = []
      globalThis.__e2eGuideStored = ${seeded ? 'true' : 'false'}
      const file = (path, home) => ({ path, category: path.startsWith('test/') ? 'test' : 'implementation', generated: false, added: 4, deleted: 4, home, focus: [] })
      const section = (number, title, files) => ({
        id: 's' + (number ?? 'x'), number, title, body: title + ' body with \`code\`.', kind: number == null ? 'supporting' : 'core',
        automatic: number == null, files, added: 0, deleted: 0, implementationAdded: 0, implementationDeleted: 0
      })
      const guideFor = (subject) => ({
        version: 1, kind: 'review-guide', title: ${JSON.stringify(TITLE)}, overview: 'The parser changed; its callers follow.',
        sections: [
          section(1, 'Callers', [file('src/c.ts', true), file('src/b.ts', true)]),
          section(2, 'Parser', [file('src/a.ts', true), file('src/c.ts', false)]),
          section(null, 'Tests', [file('test/a.test.ts', true)])
        ],
        sectionCount: 2,
        totals: { added: 16, deleted: 16, implementationAdded: 12, implementationDeleted: 12, files: 4 },
        facts: { generatedAt: new Date().toISOString(), provider: 'codex', model: 'e2e-model', scope: 'wt', subject }
      })
      ipcMain.removeHandler('review-guide:get')
      ipcMain.handle('review-guide:get', async (event, request) => {
        globalThis.__e2eGuideRequests.push({ cachedOnly: request.cachedOnly === true, force: request.force === true, tabId: request.subject?.tabId ?? null })
        if (request.cachedOnly === true) {
          return globalThis.__e2eGuideStored
            ? { status: 'ready', guide: { ...guideFor(request.subject), facts: { ...guideFor(request.subject).facts, cached: true } }, cached: true }
            : { status: 'unavailable', reason: 'No guide has been written for this review yet.', code: 'not-cached' }
        }
        const send = (phase) => { if (!event.sender.isDestroyed()) event.sender.send('review-guide:progress', { tabId: request.subject.tabId, phase }) }
        await new Promise((resolve) => setTimeout(resolve, 150))
        send('thinking')
        await new Promise((resolve) => setTimeout(resolve, 300))
        send('writing')
        await new Promise((resolve) => setTimeout(resolve, 300))
        globalThis.__e2eGuideStored = true
        return { status: 'ready', guide: guideFor(request.subject), cached: false }
      })
      return 'ok'
    })()`
  })
  if (result.result?.value !== 'ok') throw new Error(`Could not install the fake guide: ${JSON.stringify(result)}`)
}

const deep = (selector) => `(() => {
  const out = []
  const walk = (root) => {
    out.push(...root.querySelectorAll(${JSON.stringify(selector)}))
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot != null) walk(element.shadowRoot)
  }
  walk(document)
  return out
})()`
const SWITCH = `document.querySelector('[data-review-guide-switch]')`
const GUIDE_ON = `document.querySelector('.multi-file-review[data-review-guide]') != null`
const COUNTER = `(document.querySelector('[data-guide-counter]')?.textContent ?? null)`
// The review's files top to bottom, as the viewer lays them out.
const LAYOUT = `(() => {
  const viewer = window.__INSTANCE
  if (viewer == null) return null
  return ${JSON.stringify(PATHS)}
    .map((path) => ({ path, top: viewer.getTopForItem('review:' + path) }))
    .filter((entry) => entry.top != null)
    .sort((left, right) => left.top - right.top)
    .map((entry) => entry.path)
})()`
const inOrder = (order) => `JSON.stringify(${LAYOUT}) === ${JSON.stringify(JSON.stringify(order))}`

const mainRequests = async ({ main }) => {
  const result = await main.send('Runtime.evaluate', { expression: 'JSON.stringify(globalThis.__e2eGuideRequests ?? [])', returnByValue: true })
  return JSON.parse(result.result?.value ?? '[]')
}

await runSuite('review-guide', async (suite, cleanup) => {
  const fixture = await createRepository('review-guide')
  cleanup(removeLater(fixture))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await mkdir(join(fixture, 'test'), { recursive: true })
  for (const path of PATHS) await writeFile(join(fixture, path), source(path.replace(/\W/g, '_'), false))
  await git(fixture, 'add', '-A')
  await git(fixture, 'commit', '--quiet', '-m', 'Base')
  for (const path of PATHS) await writeFile(join(fixture, path), source(path.replace(/\W/g, '_'), true))
  const profile = await mkdtemp(join(tmpdir(), 'kodi-e2e-guide-profile-'))
  cleanup(removeLater(profile))

  const first = await launchApp({ folder: fixture, profile })
  cleanup(first.stop)
  await installFakeGuide(first, { seeded: false })
  const { cdp } = first

  // ── open the review ───────────────────────────────────────────────────────
  const firstRow = `${deep(`[data-item-path="${PATHS[0]}"][data-item-type="file"]`)}[0]`
  await cdp.waitFor(`${firstRow} != null || document.querySelector('.multi-file-review') != null`, 30_000, 16)
  if (!await cdp.eval(`document.querySelector('.multi-file-review') != null`)) await press(cdp, `${firstRow}.click()`)
  await cdp.waitFor(`window.__INSTANCE != null && ${LAYOUT}?.length === ${PATHS.length}`, 30_000, 16)
  suite.record('the review opens in path order', await cdp.eval(inOrder(PATHS)), { layout: await cdp.eval(LAYOUT) })

  // ── Guide asks the disk only, and offers Generate ─────────────────────────
  const switchFound = await cdp.waitFor(`${SWITCH} != null`, 10_000, 16)
  if (switchFound.timedOut) {
    suite.record('the review has a Diff | Guide switch', false)
    return
  }
  await press(cdp, `${SWITCH}.click()`)
  const idle = await cdp.waitFor(`${GUIDE_ON} && document.querySelector('[data-guide-generate]') != null && !document.querySelector('[data-guide-generate]').disabled`, 10_000, 16)
  await Bun.sleep(300)
  const asked = await mainRequests(first)
  suite.record('Guide asks the disk once and offers Generate, calling no model', !idle.timedOut
    && asked.length === 1 && asked[0].cachedOnly === true, { requests: asked })

  // ── Generate: progress, then the guide in its own order ───────────────────
  await press(cdp, `document.querySelector('[data-guide-generate]').click()`)
  const loading = await cdp.waitFor(`document.querySelector('[data-guide-state="loading"]') != null && document.querySelector('.review-guide-dot[data-status="loading"]') != null`, 3_000, 16)
  const phase = await cdp.waitFor(`/Writing the guide|Reading the change/.test(document.querySelector('[data-guide-state="loading"]')?.textContent ?? '')`, 3_000, 16)
  suite.record('Generate shows the run and its phase', !loading.timedOut && !phase.timedOut)
  const ready = await cdp.waitFor(`document.querySelector('.guide-title')?.textContent === ${JSON.stringify(TITLE)}`, 10_000, 16)
  const reordered = await cdp.waitFor(inOrder(GUIDE_ORDER), 5_000, 16)
  suite.record('the guide shows its header and first section, and the review takes its order',
    !ready.timedOut && !reordered.timedOut,
    { counter: await cdp.eval(COUNTER), layout: await cdp.eval(LAYOUT) })
  const pills = await cdp.eval(`${deep('[data-review-guide-pill]')}.map((pill) => pill.textContent)`)
  const steps = await cdp.eval(`document.querySelectorAll('[data-guide-step]').length`)
  suite.record('each section\'s first file carries a pill and the walkthrough has a step per section',
    pills.includes('01 · Callers') && steps === 3, { pills, steps })

  // ── } moves by section; the column follows ────────────────────────────────
  const atStart = await cdp.waitFor(`${COUNTER} === '01 / 02'`, 3_000, 16)
  suite.record('the guide starts the reader at its first section', !atStart.timedOut, { counter: await cdp.eval(COUNTER) })
  await cdp.key('keyDown', '}', 'BracketRight', 221, 8, '}')
  await cdp.key('keyUp', '}', 'BracketRight', 221, 8)
  const followed = await cdp.waitFor(`${COUNTER} === '02 / 02' && Math.abs(window.__INSTANCE.getTopForItem('review:src/a.ts') - window.__INSTANCE.root.scrollTop) < 4`, 5_000, 16)
  suite.record('} goes to the next section and the column follows', !followed.timedOut,
    { counter: await cdp.eval(COUNTER), scrollTop: await cdp.eval(`window.__INSTANCE.root?.scrollTop ?? null`) })

  // ── ⌘⇧G back to the diff, in path order; again returns without a request ─
  const requestsBefore = (await mainRequests(first)).length
  await suite.watch(first, '⌘⇧G goes back to the diff in path order, without a long task', async () => {
    await cdp.combo('g', 'KeyG', 71, 12)
  }, { done: `!(${GUIDE_ON}) && ${inOrder(PATHS)}`, settleMs: 600, longTaskMs: 120, timeoutMs: 5_000 })
  await suite.watch(first, '⌘⇧G returns to the guide at once, asking nothing', async () => {
    await cdp.combo('g', 'KeyG', 71, 12)
  }, {
    done: `${GUIDE_ON} && document.querySelector('.guide-title') != null`,
    settleMs: 600,
    longTaskMs: 120,
    check: 'true'
  })
  const requestsAfter = (await mainRequests(first)).length
  suite.record('switching views sent no guide request', requestsAfter === requestsBefore, { requestsBefore, requestsAfter })

  // ── a file changed under the guide marks it stale ─────────────────────────
  await writeFile(join(fixture, 'src/b.ts'), `${source('src_b_ts', true)}export const late = 1\n`)
  const stale = await cdp.waitFor(`document.querySelector('[data-guide-stale]') != null`, 8_000, 16)
  suite.record('a file changed since the guide marks it stale', !stale.timedOut)

  await takeLongTasks(cdp)
  await first.stop()

  // ── a restart comes back on the Guide, from the cache ─────────────────────
  const second = await launchApp({ folder: fixture, profile })
  cleanup(second.stop)
  await installFakeGuide(second, { seeded: true })
  // The window may have asked before the fake was in place; a reload asks again
  // with it, the way a launch does.
  await second.cdp.send('Page.reload', {})
  await Bun.sleep(500)
  const secondRow = `${deep(`[data-item-path="${PATHS[0]}"][data-item-type="file"]`)}[0]`
  await second.cdp.waitFor(`${secondRow} != null || document.querySelector('.multi-file-review') != null`, 30_000, 16)
  if (!await second.cdp.eval(`document.querySelector('.multi-file-review') != null`)) await press(second.cdp, `${secondRow}.click()`)
  const restored = await second.cdp.waitFor(`${GUIDE_ON} && document.querySelector('.guide-title')?.textContent === ${JSON.stringify(TITLE)}`, 20_000, 16)
  const restoredRequests = await mainRequests(second)
  suite.record('a restart comes back on the Guide, served from the cache', !restored.timedOut
    && restoredRequests.length >= 1 && restoredRequests.every((request) => request.cachedOnly), { requests: restoredRequests })

  // ── kodi --guide-file: an agent's guide, checked against the live diff ────
  const handoff = join(profile, 'agent-guide.json')
  const section = (title, refs) => ({ id: title.toLowerCase(), title, kind: 'core', body: `${title}, from the agent.`, refs })
  await writeFile(handoff, JSON.stringify({
    version: 1, kind: 'review-guide', title: 'Written by the agent', overview: null, commit: null,
    sections: [section('Parser', ['src/a.ts']), section('Callers', ['src/c.ts', 'src/b.ts'])]
  }))
  const handed = await openInRunningApp(second.profile, [`--kodi-folder=${fixture}`, `--kodi-guide-file=${handoff}`])
  const handedShown = await second.cdp.waitFor(`${GUIDE_ON} && document.querySelector('.guide-title')?.textContent === 'Written by the agent'`, 15_000, 16)
  suite.record('kodi --guide-file shows the agent\'s guide on its review, normalised in main', handed === 0 && !handedShown.timedOut
    && await second.cdp.eval(`/the agent that wrote the change/.test(document.querySelector('.guide-meta-author')?.textContent ?? '')`),
  { exit: handed, counter: await second.cdp.eval(COUNTER) })
  await writeFile(handoff, JSON.stringify({
    version: 1, kind: 'review-guide', title: 'Out of date', overview: null, commit: null,
    sections: [section('Gone', ['src/gone.ts'])]
  }))
  await openInRunningApp(second.profile, [`--kodi-folder=${fixture}`, `--kodi-guide-file=${handoff}`])
  const mismatch = await second.cdp.waitFor(`/no longer matches the working tree/.test(document.querySelector('[data-guide-state="unavailable"]')?.textContent ?? '')`, 15_000, 16)
  suite.record('a guide file that names files the diff lacks says it no longer matches', !mismatch.timedOut)

  // ── kodi <commit> under "every review": its guide starts with no click ───
  await git(fixture, 'add', '-A')
  await git(fixture, 'commit', '--quiet', '-m', 'Teach callers the parser')
  const sha = (await git(fixture, 'rev-parse', 'HEAD')).trim()
  await second.cdp.eval(`(() => {
    const preferences = JSON.parse(localStorage.getItem('kodi:preferences:v1') ?? '{}')
    localStorage.setItem('kodi:preferences:v1', JSON.stringify({ ...preferences, guideAutoGenerate: 'all-reviews', defaultsVersion: 2 }))
    localStorage.setItem('kodi:guide-auto-hidden', '1')
    return true
  })()`)
  await second.main.send('Runtime.evaluate', { expression: 'globalThis.__e2eGuideStored = false; globalThis.__e2eGuideRequests = []' })
  await second.cdp.send('Page.reload', {})
  await second.cdp.waitFor(`document.querySelector('.multi-file-review, .welcome, .workspace') != null`, 30_000, 16)
  await Bun.sleep(1_500)
  // The working tree's own guide may have started on the reload; the commit's must be its own run.
  await second.main.send('Runtime.evaluate', { expression: 'globalThis.__e2eGuideStored = false; globalThis.__e2eGuideRequests = []' })
  const opened = await openInRunningApp(second.profile, [`--kodi-folder=${fixture}`, `--kodi-ref=${sha}`])
  // The review in front is that commit's: the agent dock's subject names it.
  const commitTab = await second.cdp.waitFor(`(() => {
    const subject = window.__kodiReviewGuide?.agent?.subject
    return subject?.source === 'patch' && subject.headOid === '${sha}' && document.querySelector('.multi-file-review') != null
  })()`, 20_000, 16)
  suite.record('kodi <commit> opens that commit\'s review', opened === 0 && !commitTab.timedOut, { exit: opened })
  const auto = await second.cdp.waitFor(`document.querySelector('.review-guide-dot[data-status="ready"]') != null`, 15_000, 16)
  const autoRequests = await mainRequests(second)
  suite.record('under "every review" the commit\'s guide is written with no click, and the switch says it is ready', !auto.timedOut
    && autoRequests.some((request) => !request.cachedOnly && request.tabId?.includes(sha) === true), {
    requests: autoRequests,
    status: await second.cdp.eval(`(() => { const host = window.__kodiReviewGuide; const id = host?.agent?.subject?.tabId; return id == null ? null : [id, host.status(id), host.view(id)] })()`),
    dot: await second.cdp.eval(`document.querySelector('.review-guide-dot')?.dataset.status ?? null`)
  })

  suite.record('memory at end', true, await second.memory())
})
