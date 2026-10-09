// Reading a folder review while an agent keeps writing the files in it must
// feel like reading a still page: the line under the reader's eyes stays where
// the reader's own scrolling puts it, frames keep coming, and a diff-style,
// word-wrap or folding toggle keeps the reader on the line they were reading.
//
//   bun run build && bun scripts/e2e/scroll-under-writes.e2e.mjs
//
// It wheel-scrolls the multi-file review up and down the way a trackpad does
// (small deltas at ~60 Hz, with the odd flick that decays like momentum) while
// files in the review are rewritten every 300-700 ms: the file on screen (above
// and below the line being read, with and without a line-count change), files
// above and below the viewport, and a 3,600-line lockfile with lines up to
// ~2,500 characters. Half the writes land in place, half through a temp file
// and a rename. Then it toggles split/unified, word wrap and context folding and
// does it again.
//
// Per frame (after layout, right before paint) it samples the scroller and one
// anchor line — the first fully visible new-side line at the top of the
// screen, picked again every frame and keyed by file and line number. Anchor
// drift is how far that line moved on screen beyond what the
// reader's own scroll explains: the change in its content position minus every
// programmatic scroll the page made (Element scrollTo/scrollTop/scrollBy/
// scrollIntoView/focus are hooked). A drift the reader did not cause is a
// layout shift or a scroll jump.
//
// Two ways to run it:
//   - a generated fixture (default): ~20 changed files like a web app's
//     working tree, the user's display preferences (word wrap and folding on,
//     a vibrant theme) written into a scratch profile;
//   - a copy of a real repository and a copy of a real profile:
//       KODI_E2E_SCROLL_FOLDER=<copy of a repository>
//       KODI_E2E_SCROLL_PROFILE=<copy of ~/Library/Application Support/kodi>
//     The profile is copied again for each run (the original copy stays
//     untouched) and must name no root but the folder. The folder's files are
//     written during the run and put back byte for byte when it ends.
//
// Switches:
//   KODI_E2E_VISIBLE=1                 a real window (paint and compositing only happen there)
//   KODI_E2E_PORT=96xx                 DevTools port (default 9640; main inspector is port + 1)
//   KODI_E2E_SCROLL_PHASE_MS=6000      length of each scroll phase
//   KODI_E2E_SCROLL_CPU_PROFILE=1      adds a 9 s sampled CPU profile of scroll + writes, summarised
//                                      through the bundle's source maps
//   KODI_E2E_SCROLL_OUT=<dir>          where per-run JSON (samples, events, profile) is written
//   KODI_E2E_SCROLL_PREFS='{"wordWrap":false}'  fixture preferences on top of the defaults
//   KODI_E2E_SCROLL_ONLY=<substring>   only the configurations whose name contains it
//   KODI_E2E_SCROLL_SEED=<n>           the scroll pattern and write schedule (default 7)
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import {
  REPO_ROOT, counters, createRepository, git, launchApp, press, removeLater, runSuite,
  startFrames, stopFrames, takeLongTasks
} from './harness.mjs'

const PORT = Number(process.env.KODI_E2E_PORT ?? 9640)
const PHASE_MS = Number(process.env.KODI_E2E_SCROLL_PHASE_MS ?? 6_000)
const REAL_FOLDER = process.env.KODI_E2E_SCROLL_FOLDER ?? null
const REAL_PROFILE = process.env.KODI_E2E_SCROLL_PROFILE ?? null
const CPU_PROFILE = process.env.KODI_E2E_SCROLL_CPU_PROFILE === '1'
const OUT_DIR = process.env.KODI_E2E_SCROLL_OUT ?? null
const ONLY = process.env.KODI_E2E_SCROLL_ONLY ?? ''
const SEED = Number(process.env.KODI_E2E_SCROLL_SEED ?? 7)
const VISIBLE = process.env.KODI_E2E_VISIBLE === '1'
const MODE = REAL_FOLDER == null ? 'fixture' : 'folder'

// The reader's display preferences on the machine this was written for.
const USER_PREFERENCES = {
  codeFont: 'fira-code', codeFontSize: 13, codeLineHeight: 20, editorTheme: 'pierre-dark-vibrant',
  showLineNumbers: true, wordWrap: true, foldUnchanged: true
}

// Budgets. A drift is anything past 2 px that the reader did not scroll.
const DRIFT_PX = 2
const FRAME_P95_MS = 20
const LONG_TASK_MS = 50
const TOGGLE_DRIFT_PX = 20

// ── deterministic randomness ────────────────────────────────────────────────

function random(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}
const pick = (rng, list) => list[Math.floor(rng() * list.length)]
const between = (rng, low, high) => Math.floor(low + rng() * (high - low + 1))

// ── fixture ─────────────────────────────────────────────────────────────────

const WORDS = ['notice', 'platform', 'release', 'dialog', 'banner', 'store', 'session', 'viewer', 'layout', 'content',
  'announcement', 'feature', 'message', 'locale', 'popup', 'install', 'update', 'dismiss', 'visible', 'handler']

function sourceLine(rng, index) {
  const word = () => pick(rng, WORDS)
  const roll = rng()
  if (roll < 0.08) return ''
  if (roll < 0.16) return `  // ${word()} ${word()} ${word()} ${index}`
  if (roll < 0.28) return `  const ${word()}${index} = use${word()}(${word()}, '${word()}')`
  // JSX with a long className: what makes a component wrap.
  if (roll < 0.36) return `      <div className="${Array.from({ length: between(rng, 8, 30) }, () => `${word()}-${between(rng, 1, 9)}`).join(' ')}">`
  if (roll < 0.5) return `    if (${word()}.${word()} !== ${word()}${index}) return ${word()}(${word()}, ${index})`
  if (roll < 0.6) return `      {t('${word()}.${word()}.${word()}')}`
  return `    ${word()}${index}.${word()} = ${word()}(${word()}.${word()}, { ${word()}: ${index}, ${word()}: '${word()}' })`
}

function sourceFile(seed, lineCount) {
  const rng = random(seed)
  return `${Array.from({ length: lineCount }, (_unused, index) => sourceLine(rng, index)).join('\n')}\n`
}

function jsonFile(seed, lineCount) {
  const rng = random(seed)
  const body = Array.from({ length: lineCount - 2 }, (_unused, index) =>
    `  "${pick(rng, WORDS)}.${pick(rng, WORDS)}.${index}": "${Array.from({ length: between(rng, 2, 18) }, () => pick(rng, WORDS)).join(' ')}"${index < lineCount - 3 ? ',' : ''}`)
  return `{\n${body.join('\n')}\n}\n`
}

function cssFile(seed, lineCount) {
  const rng = random(seed)
  return `${Array.from({ length: lineCount }, (_unused, index) => index % 6 === 0
    ? `.${pick(rng, WORDS)}-${index} {`
    : index % 6 === 5 ? '}' : `  --${pick(rng, WORDS)}-${pick(rng, WORDS)}: ${between(rng, 0, 999)}px;`).join('\n')}\n`
}

/** One lockfile package line, sized like a real bun.lock's (most short, a few thousands of characters). */
function lockLine(rng, index) {
  const name = `@${pick(rng, WORDS)}/${pick(rng, WORDS)}-${index}`
  const version = `${between(rng, 0, 12)}.${between(rng, 0, 40)}.${between(rng, 0, 20)}`
  const integrity = `sha512-${Array.from({ length: 86 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[between(rng, 0, 63)]).join('')}==`
  const roll = rng()
  const depCount = roll < 0.45 ? 0 : roll < 0.93 ? between(rng, 2, 14) : roll < 0.99 ? between(rng, 18, 36) : between(rng, 50, 90)
  const deps = Array.from({ length: depCount }, () => `"@${pick(rng, WORDS)}/${pick(rng, WORDS)}": "^${between(rng, 0, 9)}.${between(rng, 0, 30)}.${between(rng, 0, 9)}"`).join(', ')
  const meta = depCount === 0 ? `{ "os": "linux", "cpu": "${pick(rng, ['x64', 'arm64', 'ppc64'])}" }` : `{ "dependencies": { ${deps} } }`
  return `    "${name}": ["${name}@${version}", "", ${meta}, "${integrity}"],`
}

function lockFile(seed, lineCount) {
  const rng = random(seed)
  const header = ['{', '  "lockfileVersion": 1,', '  "workspaces": {', '    "": {', '      "name": "web",', '      "dependencies": {']
  const dependencies = Array.from({ length: 60 }, (_unused, index) => `        "@${pick(rng, WORDS)}/${pick(rng, WORDS)}-${index}": "^${between(rng, 0, 9)}.${between(rng, 0, 30)}.0",`)
  const lines = [...header, ...dependencies, '      },', '    },', '  },', '  "packages": {']
  let index = 0
  while (lines.length < lineCount - 2) {
    lines.push(lockLine(rng, index))
    lines.push('')
    index += 1
  }
  lines.push('  }', '}')
  return `${lines.join('\n')}\n`
}

/** Edits spread through a file: changed lines, inserted runs, deleted runs. */
function modify(text, seed) {
  const rng = random(seed)
  const lines = text.split('\n')
  const out = []
  for (let index = 0; index < lines.length; index += 1) {
    const roll = rng()
    if (roll < 0.012) continue
    if (roll < 0.03) out.push(`${lines[index]} // edited ${index}`)
    else out.push(lines[index])
    if (roll > 0.99) for (let added = 0; added < between(rng, 1, 4); added += 1) out.push(sourceLine(rng, index * 10 + added))
  }
  return out.join('\n')
}

const FIXTURE_FILES = [
  ['web/src/components/auth/terms-notice.tsx', (seed) => sourceFile(seed, 110)],
  ['web/src/components/changelog/release-announcement.tsx', (seed) => sourceFile(seed, 90)],
  ['web/src/components/changelog/whats-new-dialog.tsx', (seed) => sourceFile(seed, 210)],
  ['web/src/components/dashboard/activity-feed.tsx', (seed) => sourceFile(seed, 320)],
  ['web/src/components/dashboard/project-card.tsx', (seed) => sourceFile(seed, 180)],
  ['web/src/components/dashboard/quota-meter.tsx', (seed) => sourceFile(seed, 140)],
  ['web/src/components/dashboard/team-list.tsx', (seed) => sourceFile(seed, 260)],
  ['web/src/components/dashboard/usage-chart.tsx', (seed) => sourceFile(seed, 400)],
  ['web/src/components/dashboard/welcome-panel.tsx', (seed) => sourceFile(seed, 150)],
  ['web/src/components/pwa/pwa-popup.tsx', (seed) => sourceFile(seed, 80)],
  ['web/src/i18n/messages/de.json', (seed) => jsonFile(seed, 2_600)],
  ['web/src/i18n/messages/en.json', (seed) => jsonFile(seed, 2_600)],
  ['web/src/lib/api/client.ts', (seed) => sourceFile(seed, 230)],
  ['web/src/lib/api/notices.ts', (seed) => sourceFile(seed, 120)],
  ['web/src/lib/api/session.ts', (seed) => sourceFile(seed, 170)],
  ['web/src/store/platform-notices-store.ts', (seed) => sourceFile(seed, 40)],
  ['web/src/styles/globals.css', (seed) => cssFile(seed, 740)]
]
const UNTRACKED_FILES = [
  ['web/src/components/common/platform-notices.tsx', (seed) => sourceFile(seed, 325)],
  ['web/bun.lock', (seed) => lockFile(seed, 3_642)]
]

async function writeFixture() {
  const root = await createRepository('scroll')
  for (const [index, [path, make]] of FIXTURE_FILES.entries()) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), make(100 + index))
  }
  await git(root, 'add', '-A')
  await git(root, 'commit', '--quiet', '-m', 'Web app')
  for (const [index, [path, make]] of FIXTURE_FILES.entries()) {
    await writeFile(join(root, path), modify(make(100 + index), 900 + index))
  }
  await writeFile(join(root, 'src/app.ts'), 'export const app = true\n')
  for (const [index, [path, make]] of UNTRACKED_FILES.entries()) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), make(500 + index))
  }
  return root
}

// ── profiles ────────────────────────────────────────────────────────────────

/** A per-run copy of a real profile that can open nothing but `folder`. */
async function copyProfile(source, folder) {
  const profile = await mkdtemp(join(tmpdir(), 'kodi-e2e-scroll-profile-'))
  await cp(source, profile, { recursive: true })
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) {
    await rm(join(profile, name), { force: true })
  }
  const session = join(profile, 'last-session.json')
  if (existsSync(session)) {
    const value = JSON.parse(await readFile(session, 'utf8'))
    await writeFile(session, JSON.stringify({ ...value, lastRoot: folder, approvedRoots: [folder], pullRequestFolders: {} }, null, 2))
  }
  const roots = join(profile, 'approved-roots.json')
  if (existsSync(roots)) await writeFile(roots, JSON.stringify([folder], null, 2))
  const workspace = join(profile, 'last-workspace.json')
  if (existsSync(workspace)) {
    const value = JSON.parse(await readFile(workspace, 'utf8'))
    const entries = (value.entries ?? []).filter((entry) => entry.lastRoot === folder || entry.snapshot?.root === folder)
    await writeFile(workspace, JSON.stringify({ ...value, lastRoot: folder, entries }))
  }
  // Nothing in the state files may point at another repository.
  for (const name of ['last-session.json', 'approved-roots.json', 'last-workspace.json']) {
    const path = join(profile, name)
    if (!existsSync(path)) continue
    const text = await readFile(path, 'utf8')
    const others = [...text.matchAll(/"((?:\/Users|\/private|\/tmp|\/Volumes)\/[^"]+)"/g)]
      .map((match) => match[1]).filter((path) => path !== folder && !path.startsWith(`${folder}/`))
    if (others.length > 0) throw new Error(`${name} in the profile copy still names ${others[0]}`)
  }
  return profile
}

// ── in-page instrumentation ─────────────────────────────────────────────────

// Installed once per document. Samples once per frame from a ResizeObserver
// callback, which runs after the frame's animation callbacks and layout and
// before paint: what is sampled is what gets painted.
const INSTRUMENT = String.raw`(() => {
  if (window.__suw != null) return 'present'
  const S = window.__suw = {
    running: false, samples: [], events: [], shifts: [], loafs: [], tasks: [],
    prog: 0, wheel: 0, anchor: null, anchors: [], lastSt: null, pin: null, scroller: null,
    hooks: null
  }
  const freshHooks = () => ({
    viewRenders: 0, viewRenderMs: 0, viewRenderMaxMs: 0, recomputeLayouts: 0, recomputeMs: 0, setItems: 0,
    setOptions: 0, scrollFixes: 0, heightChecks: 0, heightChanges: 0, heightCheckMs: 0, heightCheckMaxMs: 0,
    layoutResets: 0, resetsWithEstimates: 0, measuredLinesDropped: 0, measuredPxDropped: 0,
    itemRenders: 0, itemRenderMs: 0, itemRenderMaxMs: 0, instances: 0
  })
  S.hooks = freshHooks()
  const round = (value) => Math.round(value * 10) / 10

  S.activeScroller = () => {
    const root = window.__INSTANCE?.root
    if (root?.isConnected && root.clientHeight > 0) return root
    return [...document.querySelectorAll('.multi-file-code-view')].find((element) => element.clientHeight > 0) ?? null
  }

  // ── programmatic scrolls: who moved the scroller that was not the reader ──
  const stackTag = () => {
    const limit = Error.stackTraceLimit
    Error.stackTraceLimit = 16
    const stack = new Error().stack ?? ''
    Error.stackTraceLimit = limit
    return stack.split('\n').slice(4, 13).map((line) => line.trim().replace(/^at /, '')).join(' | ')
  }
  const track = (element, run, how) => {
    const scroller = S.scroller
    if (scroller == null || (element !== scroller && !scroller.contains?.(element) && how !== 'focus')) return run()
    const before = scroller.scrollTop
    const result = run()
    const delta = scroller.scrollTop - before
    if (delta !== 0) {
      S.prog += delta
      if (S.running) S.events.push({ type: 'prog', t: Date.now(), delta: round(delta), how, stack: stackTag() })
    }
    return result
  }
  const proto = Element.prototype
  const scrollTop = Object.getOwnPropertyDescriptor(proto, 'scrollTop')
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true, get: scrollTop.get,
    set(value) { return track(this, () => scrollTop.set.call(this, value), 'scrollTop') }
  })
  for (const name of ['scrollTo', 'scroll', 'scrollBy']) {
    const original = proto[name]
    proto[name] = function (...args) { return this === S.scroller ? track(this, () => original.apply(this, args), name) : original.apply(this, args) }
  }
  const scrollIntoView = proto.scrollIntoView
  proto.scrollIntoView = function (...args) { return track(this, () => scrollIntoView.apply(this, args), 'scrollIntoView') }
  const focus = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function (...args) { return track(this, () => focus.apply(this, args), 'focus') }

  addEventListener('wheel', (event) => { S.wheel += event.deltaY }, { capture: true, passive: true })

  // ── what the viewer did: renders, height checks, layout resets ────────────
  const wrap = (target, name, after) => {
    const original = target[name]
    if (typeof original !== 'function') return
    target[name] = function (...args) {
      const started = performance.now()
      const result = original.apply(this, args)
      after(performance.now() - started, args, result, this)
      return result
    }
  }
  S.hookInstance = (instance) => {
    if (instance == null || instance.__suwHooked) return
    instance.__suwHooked = true
    S.observe?.()
    const H = () => S.hooks
    H().instances += 1
    S.events.push({ type: 'instance', t: Date.now() })
    wrap(instance, 'computeRenderRangeAndEmit', (ms) => { const h = H(); h.viewRenders += 1; h.viewRenderMs += ms; h.viewRenderMaxMs = Math.max(h.viewRenderMaxMs, ms) })
    wrap(instance, 'recomputeLayout', (ms) => { const h = H(); h.recomputeLayouts += 1; h.recomputeMs += ms })
    wrap(instance, 'setItems', () => { H().setItems += 1 })
    wrap(instance, 'setOptions', () => { H().setOptions += 1 })
    wrap(instance, 'applyScrollFix', () => { H().scrollFixes += 1 })
    for (const record of instance.items ?? []) S.hookItemPrototype(record.instance)
  }
  S.hookItemPrototype = (item) => {
    const prototype = item == null ? null : Object.getPrototypeOf(item)
    if (prototype == null || prototype === Object.prototype || Object.prototype.hasOwnProperty.call(prototype, '__suwHooked')) return
    prototype.__suwHooked = true
    wrap(prototype, 'reconcileHeights', (ms, _args, changed) => {
      const h = S.hooks; h.heightChecks += 1; h.heightCheckMs += ms; h.heightCheckMaxMs = Math.max(h.heightCheckMaxMs, ms)
      if (changed) h.heightChanges += 1
    })
    const reset = prototype.resetLayoutCache
    if (typeof reset === 'function') {
      prototype.resetLayoutCache = function (options) {
        const lines = this.cache?.heightDeltas?.size ?? 0
        const px = this.cache?.measuredHeightDeltaTotal ?? 0
        const h = S.hooks
        h.layoutResets += 1
        if (options?.includeEstimatedHeights) h.resetsWithEstimates += 1
        h.measuredLinesDropped += lines
        h.measuredPxDropped += px
        if (lines > 0 && S.running) S.events.push({ type: 'reset', t: Date.now(), file: this.fileDiff?.name ?? null, lines, px: Math.round(px), estimates: options?.includeEstimatedHeights === true })
        return reset.call(this, options)
      }
    }
    wrap(prototype, 'render', (ms) => { const h = S.hooks; h.itemRenders += 1; h.itemRenderMs += ms; h.itemRenderMaxMs = Math.max(h.itemRenderMaxMs, ms) })
  }

  // ── the anchor line ───────────────────────────────────────────────────────
  // An anchor is a row the reader can see, known by its file and its text: a
  // write above it renumbers it, and what the reader follows is the text, not
  // the number. Rows are re-created on a re-render and file containers are
  // pooled between files, so the element is looked up again whenever it is gone.
  const renderedRecords = (instance) => (instance?.items ?? []).filter((record) => record.element?.shadowRoot != null)
  const isNewSide = (line) => line.dataset.lineType !== 'change-deletion' && !line.closest('code')?.hasAttribute('data-deletions')
  const recordFor = (instance, id) => instance?.items?.find((candidate) => candidate.item.id === id) ?? null
  const textOf = (element) => element.textContent.slice(0, 200)
  const bandTop = (scroller, instance) => scroller.getBoundingClientRect().top + (instance?.getStickyHeaderOffset?.() ?? 44) + 2
  S.findAnchor = (instance, scroller, fromY = null) => {
    const top = fromY == null ? bandTop(scroller, instance) : scroller.getBoundingClientRect().top + fromY
    const bottom = scroller.getBoundingClientRect().top + scroller.clientHeight - 20
    for (const record of renderedRecords(instance).sort((left, right) => left.top - right.top)) {
      const hostRect = record.element.getBoundingClientRect()
      if (hostRect.bottom < top || hostRect.top > bottom) continue
      const lines = [...record.element.shadowRoot.querySelectorAll('[data-content] [data-line]')].filter(isNewSide)
      // Lines of one column are in document order, top to bottom.
      let low = 0
      let high = lines.length - 1
      let found = -1
      while (low <= high) {
        const middle = (low + high) >> 1
        if (lines[middle].getBoundingClientRect().top >= top) { found = middle; high = middle - 1 } else low = middle + 1
      }
      if (found < 0) continue
      // A row with distinctive text, so it can be found again after a write.
      for (let index = found; index < Math.min(lines.length, found + 12); index += 1) {
        const element = lines[index]
        const rect = element.getBoundingClientRect()
        if (rect.top >= bottom) break
        const text = textOf(element)
        if (text.trim().length < 10 && index < found + 11) continue
        return { id: record.item.id, line: Number(element.dataset.line), element, text }
      }
    }
    return null
  }
  const measure = (instance, scroller, key) => {
    const record = recordFor(instance, key.id)
    if (record?.element == null) return null
    let element = key.element
    if (element == null || !element.isConnected || element.getRootNode().host !== record.element || textOf(element) !== key.text) {
      // The same text, nearest the number it had (new-side rows first).
      let best = null
      let bestScore = Infinity
      for (const candidate of record.element.shadowRoot.querySelectorAll('[data-content] [data-line]')) {
        if (textOf(candidate) !== key.text) continue
        const score = Math.abs(Number(candidate.dataset.line) - key.line) + (isNewSide(candidate) ? 0 : 0.5)
        if (score < bestScore) { best = candidate; bestScore = score }
      }
      if (best == null) { key.lost = true; key.element = null; return null }
      element = key.element = best
      key.line = Number(best.dataset.line)
    }
    return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }

  S.sample = () => {
    const instance = window.__INSTANCE
    S.hookInstance(instance)
    const scroller = S.scroller = S.activeScroller()
    if (scroller == null || instance == null) return
    const st = scroller.scrollTop
    const sh = scroller.scrollHeight
    const max = sh - scroller.clientHeight
    const height = scroller.clientHeight
    const limitTop = (instance.getStickyHeaderOffset?.() ?? 44) + 2
    // Two anchors: the line being read (the first fully visible one) and one
    // in the middle of the viewport, for shifts below a re-measured row.
    const bands = [
      { from: null, low: limitTop, high: height - 40 },
      { from: Math.round(height * 0.5), low: height * 0.25, high: height * 0.8 }
    ]
    const out = []
    for (const [index, band] of bands.entries()) {
      const slot = S.anchors[index] ??= { key: null, lastY: null }
      let key = slot.key
      let y = key == null ? null : measure(instance, scroller, key)
      let drift = null
      let textChanged = false
      if (y != null && slot.lastY != null && S.lastSt != null) drift = round((y - slot.lastY) + (st - S.lastSt - S.prog))
      // The text being read is gone (rewritten by the agent): nothing to follow.
      if (key != null && key.lost) textChanged = true
      if (y == null || y < band.low || y > band.high) {
        key = slot.key = S.findAnchor(instance, scroller, band.from)
        y = key == null ? null : measure(instance, scroller, key)
        drift = null
      }
      slot.lastY = y
      out.push({ key, y, drift, textChanged })
      // The line being read is the one at the top of the screen: once scrolling
      // carries the tracked one down, the next frame follows the new top line.
      if (index === 0 && y != null) {
        const top = S.findAnchor(instance, scroller, band.from)
        if (top != null && (top.id !== key?.id || top.text !== key?.text)) {
          slot.key = top
          slot.lastY = measure(instance, scroller, top)
        }
      }
    }
    S.anchor = S.anchors[0]?.key ?? out[0].key
    let pinY = null
    if (S.pin != null) pinY = measure(instance, scroller, S.pin)
    const [top, middle] = out
    S.samples.push({
      t: Date.now(), p: round(performance.now()), st: round(st), sh, max, prog: round(S.prog), wheel: round(S.wheel),
      id: top.key?.id ?? null, line: top.key?.line ?? null, y: top.y == null ? null : round(top.y), drift: top.drift, textChanged: top.textChanged,
      midId: middle.key?.id ?? null, midLine: middle.key?.line ?? null, midDrift: middle.drift,
      pinY: pinY == null ? null : round(pinY)
    })
    S.lastSt = st
    S.prog = 0
    S.wheel = 0
  }


  const probe = document.createElement('div')
  probe.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;contain:strict;z-index:-1'
  document.documentElement.appendChild(probe)
  let flip = false
  // Created again for every new viewer, so it is always the last observer to
  // run in a frame: the viewer's own resize handling (and the scroll it may
  // correct) lands before the sample, as it lands before paint.
  let sampler = null
  S.observe = () => {
    sampler?.disconnect()
    sampler = new ResizeObserver(() => { if (S.running) S.sample() })
    sampler.observe(probe)
  }
  S.observe()
  const tick = () => {
    if (!S.running) return
    flip = !flip
    probe.style.width = flip ? '2px' : '1px'
    requestAnimationFrame(tick)
  }

  const describe = (node) => {
    if (node == null) return null
    const element = node.nodeType === 1 ? node : node.parentElement
    if (element == null) return node.nodeName
    const host = element.getRootNode()?.host
    const attrs = ['data-line', 'data-line-type', 'data-diffs-header', 'data-content', 'data-hunk-separator']
      .filter((name) => element.hasAttribute?.(name)).map((name) => name + '=' + element.getAttribute(name)).join(' ')
    return (host != null ? host.tagName.toLowerCase() + '>' : '') + element.tagName.toLowerCase() + (element.className && typeof element.className === 'string' ? '.' + element.className.split(' ')[0] : '') + (attrs ? '[' + attrs + ']' : '')
  }
  try {
    new PerformanceObserver((list) => {
      if (!S.running) return
      for (const entry of list.getEntries()) {
        S.shifts.push({
          t: Math.round(performance.timeOrigin + entry.startTime), value: entry.value, recentInput: entry.hadRecentInput,
          sources: (entry.sources ?? []).slice(0, 3).map((source) => ({
            node: describe(source.node), dy: Math.round(source.currentRect.y - source.previousRect.y),
            dh: Math.round(source.currentRect.height - source.previousRect.height)
          }))
        })
      }
    }).observe({ type: 'layout-shift', buffered: false })
  } catch {}
  try {
    new PerformanceObserver((list) => {
      if (!S.running) return
      for (const entry of list.getEntries()) {
        S.loafs.push({
          t: Math.round(performance.timeOrigin + entry.startTime), duration: Math.round(entry.duration),
          blocking: Math.round(entry.blockingDuration ?? 0),
          renderMs: entry.renderStart > 0 ? Math.round(entry.startTime + entry.duration - entry.renderStart) : 0,
          styleLayoutMs: entry.styleAndLayoutStart > 0 ? Math.round(entry.startTime + entry.duration - entry.styleAndLayoutStart) : 0,
          scripts: (entry.scripts ?? []).map((script) => ({
            duration: Math.round(script.duration), forcedLayoutMs: Math.round(script.forcedStyleAndLayoutDuration ?? 0),
            invoker: script.invoker, type: script.invokerType, url: script.sourceURL, fn: script.sourceFunctionName,
            char: script.sourceCharPosition
          }))
        })
      }
    }).observe({ type: 'long-animation-frame', buffered: false })
  } catch {}
  try {
    new PerformanceObserver((list) => {
      if (!S.running) return
      for (const entry of list.getEntries()) S.tasks.push({ t: Math.round(performance.timeOrigin + entry.startTime), duration: Math.round(entry.duration) })
    }).observe({ type: 'longtask', buffered: false })
  } catch {}

  S.start = ({ pin = null } = {}) => {
    S.samples = []; S.events = []; S.shifts = []; S.loafs = []; S.tasks = []
    S.hooks = freshHooks()
    S.prog = 0; S.wheel = 0; S.anchor = null; S.anchors = []; S.lastSt = null
    S.scroller = S.activeScroller()
    S.pin = pin
    S.running = true
    requestAnimationFrame(tick)
    return true
  }
  S.stop = () => {
    S.running = false
    const { samples, events, shifts, loafs, tasks, hooks } = S
    return { samples, events, shifts, loafs, tasks, hooks }
  }
  // Where the reader is: the anchor line and the files above, on and below the viewport.
  S.view = () => {
    const instance = window.__INSTANCE
    const scroller = S.activeScroller()
    if (instance == null || scroller == null) return null
    S.scroller = scroller
    const st = instance.getScrollTop()
    const height = scroller.clientHeight
    const items = instance.items.map((record) => ({ id: record.item.id, top: instance.getTopForItem(record.item.id) ?? record.top, height: record.height }))
    const key = S.anchor ?? S.findAnchor(instance, scroller)
    return {
      st, height, max: scroller.scrollHeight - height,
      above: items.filter((item) => item.top + item.height < st).map((item) => item.id),
      visible: items.filter((item) => item.top + item.height >= st && item.top <= st + height).map((item) => item.id),
      below: items.filter((item) => item.top > st + height).map((item) => item.id),
      anchor: key == null ? null : { id: key.id, line: key.line }
    }
  }
  S.pinCurrent = () => {
    const instance = window.__INSTANCE
    const scroller = S.activeScroller()
    const key = S.findAnchor(instance, scroller)
    if (key == null) return null
    const y = measure(instance, scroller, key)
    return { id: key.id, line: key.line, y, st: scroller.scrollTop, text: key.text }
  }
  return 'installed'
})()`

// ── source maps (a minimal VLQ decoder: no dependency) ──────────────────────

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const sourceMaps = new Map()

function decodeMappings(mappings) {
  const lines = []
  let source = 0
  let originalLine = 0
  let originalColumn = 0
  let name = 0
  for (const lineText of mappings.split(';')) {
    const segments = []
    let column = 0
    for (const segmentText of lineText.split(',')) {
      if (segmentText === '') continue
      const values = []
      let value = 0
      let shift = 0
      for (const character of segmentText) {
        const digit = BASE64.indexOf(character)
        value += (digit & 31) << shift
        if (digit & 32) shift += 5
        else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1)
          value = 0
          shift = 0
        }
      }
      column += values[0]
      if (values.length >= 4) {
        source += values[1]
        originalLine += values[2]
        originalColumn += values[3]
        if (values.length >= 5) name += values[4]
        segments.push([column, source, originalLine, originalColumn, values.length >= 5 ? name : -1])
      }
    }
    lines.push(segments)
  }
  return lines
}

function loadSourceMap(url) {
  if (sourceMaps.has(url)) return sourceMaps.get(url)
  let entry = null
  try {
    const match = /\/(out\/renderer\/assets\/[^/?#]+\.js)/.exec(url) ?? /\/assets\/([^/?#]+\.js)/.exec(url)
    const base = process.env.KODI_E2E_APP_DIR ?? REPO_ROOT
    const file = match == null ? null : match[1].startsWith('out/') ? join(base, match[1]) : join(base, 'out/renderer/assets', match[1])
    if (file != null && existsSync(`${file}.map`)) {
      const map = JSON.parse(readFileSync(`${file}.map`, 'utf8'))
      const code = readFileSync(file, 'utf8')
      const lineStarts = [0]
      for (let index = 0; index < code.length; index += 1) if (code.charCodeAt(index) === 10) lineStarts.push(index + 1)
      entry = { map, lines: decodeMappings(map.mappings), lineStarts }
    }
  } catch {}
  sourceMaps.set(url, entry)
  return entry
}

/** `url` + zero-based line/column in the bundle → "src/…/file.ts:line fn". */
function originalPosition(url, line, column) {
  const entry = loadSourceMap(url)
  if (entry == null) return null
  const segments = entry.lines[line]
  if (segments == null || segments.length === 0) return null
  let low = 0
  let high = segments.length - 1
  let found = 0
  while (low <= high) {
    const middle = (low + high) >> 1
    if (segments[middle][0] <= column) { found = middle; low = middle + 1 } else high = middle - 1
  }
  const [, source, originalLine, , name] = segments[found]
  const path = (entry.map.sources[source] ?? '?').replace(/^(\.\.\/)+/, '').replace(/^.*node_modules\//, 'node_modules/')
  return { path, line: originalLine + 1, name: name >= 0 ? entry.map.names[name] : null }
}

function charToLineColumn(url, char) {
  const entry = loadSourceMap(url)
  if (entry == null || char == null || char < 0) return null
  let low = 0
  let high = entry.lineStarts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (entry.lineStarts[middle] <= char) low = middle
    else high = middle - 1
  }
  return { line: low, column: char - entry.lineStarts[low] }
}

function describeFrame(url, line, column, functionName) {
  const original = originalPosition(url, line, column)
  if (original == null) return `${functionName || '(anonymous)'} ${url.split('/').at(-1) || url}:${line + 1}`
  return `${original.name ?? functionName ?? '(anonymous)'} ${original.path}:${original.line}`
}

/** "fn (file:///…/index-abc.js:1:2345)" frames from Error.stack, mapped back to source. */
function mapStack(stack) {
  return stack.split(' | ').slice(0, 4).map((frame) => {
    const match = /(.*?)\s*\(?((?:file|app|http)[^()\s]*?):(\d+):(\d+)\)?$/.exec(frame)
    if (match == null) return frame
    return describeFrame(match[2], Number(match[3]) - 1, Number(match[4]) - 1, match[1])
  }).join(' < ')
}

function summariseProfile(profile, top = 18) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const self = new Map()
  const total = new Map()
  const keyOf = (node) => {
    const frame = node.callFrame
    if (frame.url === '') return frame.functionName.startsWith('(') ? frame.functionName : `(${frame.functionName || 'native'})`
    return describeFrame(frame.url, frame.lineNumber, frame.columnNumber, frame.functionName)
  }
  const keys = new Map()
  const key = (id) => {
    if (!keys.has(id)) keys.set(id, keyOf(nodes.get(id)))
    return keys.get(id)
  }
  let sampledMs = 0
  for (let index = 0; index < profile.samples.length; index += 1) {
    const ms = (profile.timeDeltas[index + 1] ?? profile.timeDeltas[index] ?? 0) / 1000
    sampledMs += ms
    let id = profile.samples[index]
    self.set(key(id), (self.get(key(id)) ?? 0) + ms)
    const seen = new Set()
    while (id != null) {
      const name = key(id)
      if (!seen.has(name)) {
        seen.add(name)
        total.set(name, (total.get(name) ?? 0) + ms)
      }
      id = parent.get(id)
    }
  }
  const ranked = (map) => [...map.entries()].sort((left, right) => right[1] - left[1])
    .filter(([name]) => !/^\((root|idle)\)$/.test(name)).slice(0, top)
    .map(([name, ms]) => `${Math.round(ms)} ms ${name}`)
  const idleMs = self.get('(idle)') ?? 0
  return { sampledMs: Math.round(sampledMs), idleMs: Math.round(idleMs), busyMs: Math.round(sampledMs - idleMs), self: ranked(self), total: ranked(total) }
}

// ── statistics ──────────────────────────────────────────────────────────────

const median = (values) => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right)
  if (sorted.length === 0) return null
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const quantile = (values, q) => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted.length === 0 ? 0 : Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] * 10) / 10
}

function analyse(data, writes) {
  const samples = data.samples
  const drifts = samples.filter((sample) => sample.drift != null && Math.abs(sample.drift) > DRIFT_PX)
  const middleDrifts = samples.filter((sample) => sample.midDrift != null && Math.abs(sample.midDrift) > DRIFT_PX)
  const attributed = drifts.map((sample) => {
    const cause = [...writes].reverse().find((write) => write.t <= sample.t && sample.t - write.t <= 2_000)
    return {
      atMs: sample.t - (samples[0]?.t ?? sample.t), drift: sample.drift, file: sample.id?.replace(/^review:/, ''), line: sample.line,
      write: cause == null ? null : `${cause.kind}/${cause.mode} ${cause.path.split('/').at(-1)} ${cause.lines >= 0 ? '+' : ''}${cause.lines} @${cause.at} (${sample.t - cause.t} ms before)`
    }
  })
  const byCause = {}
  for (const drift of attributed) {
    const cause = drift.write == null ? 'no write (reader scrolling only)' : drift.write.split(' ')[0]
    const bucket = byCause[cause] ??= { count: 0, maxPx: 0, sumPx: 0 }
    bucket.count += 1
    bucket.maxPx = Math.max(bucket.maxPx, Math.abs(drift.drift))
    bucket.sumPx = Math.round(bucket.sumPx + Math.abs(drift.drift))
  }
  // A stall: a wheel event the list took 50 ms or more to answer (it stood
  // still, away from either end). A reversal: the list moving against a
  // steady wheel.
  const responseMs = []
  let reversals = 0
  let heightChanges = 0
  let heightChurnPx = 0
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const sample = samples[index]
    const moved = sample.st - previous.st - sample.prog
    if (sample.wheel !== 0 && !(previous.st <= 0 || previous.st >= previous.max - 1)) {
      let answered = null
      for (let next = index; next < samples.length && samples[next].t - sample.t < 1_000; next += 1) {
        if (Math.abs(samples[next].st - samples[next - 1].st) >= 0.5) { answered = samples[next].t - sample.t; break }
        if (next > index && samples[next].wheel !== 0 && Math.sign(samples[next].wheel) !== Math.sign(sample.wheel)) break
      }
      if (answered != null) responseMs.push(answered)
    }
    const steady = index >= 3 && sample.wheel !== 0 && [1, 2, 3].every((back) => Math.sign(samples[index - back].wheel) === Math.sign(sample.wheel))
    if (steady && Math.sign(moved) === -Math.sign(sample.wheel) && Math.abs(moved) > 3) reversals += 1
    if (sample.sh !== previous.sh) {
      heightChanges += 1
      heightChurnPx += Math.abs(sample.sh - previous.sh)
    }
  }
  const stalls = responseMs.filter((ms) => ms >= 50).length
  const longestStallMs = Math.max(0, ...responseMs)
  const progEvents = data.events.filter((event) => event.type === 'prog')
  const stacks = {}
  for (const event of progEvents) {
    const name = `${event.how} ${mapStack(event.stack)}`
    const bucket = stacks[name] ??= { count: 0, sumPx: 0 }
    bucket.count += 1
    bucket.sumPx = Math.round(bucket.sumPx + Math.abs(event.delta))
  }
  const resets = data.events.filter((event) => event.type === 'reset')
  const loafScripts = {}
  for (const loaf of data.loafs) {
    for (const script of loaf.scripts) {
      const position = script.url ? charToLineColumn(script.url, script.char) : null
      const where = position == null ? `${script.fn || script.invoker} ${script.url?.split('/').at(-1) ?? ''}` : describeFrame(script.url, position.line, position.column, script.fn)
      const name = `${script.type}:${script.invoker} → ${where}`
      const bucket = loafScripts[name] ??= { count: 0, ms: 0, forcedLayoutMs: 0 }
      bucket.count += 1
      bucket.ms += script.duration
      bucket.forcedLayoutMs += script.forcedLayoutMs
    }
  }
  const round1 = (value) => Math.round(value * 10) / 10
  return {
    samples: samples.length,
    anchorDrifts: drifts.length,
    maxDriftPx: drifts.length === 0 ? 0 : Math.max(...drifts.map((sample) => Math.abs(sample.drift))),
    sumDriftPx: Math.round(drifts.reduce((sum, sample) => sum + Math.abs(sample.drift), 0)),
    driftByCause: byCause,
    driftExamples: attributed.sort((left, right) => Math.abs(right.drift) - Math.abs(left.drift)).slice(0, 8),
    anchorTextChanges: samples.filter((sample) => sample.textChanged).length,
    middleLineDrifts: middleDrifts.length,
    middleLineMaxDriftPx: middleDrifts.length === 0 ? 0 : Math.max(...middleDrifts.map((sample) => Math.abs(sample.midDrift))),
    stalls,
    longestStallMs,
    wheelResponseP95Ms: quantile(responseMs, 0.95),
    reversedFrames: reversals,
    programmaticScrolls: progEvents.length,
    programmaticScrollPx: Math.round(progEvents.reduce((sum, event) => sum + Math.abs(event.delta), 0)),
    programmaticScrollers: Object.entries(stacks).sort((left, right) => right[1].count - left[1].count).slice(0, 5).map(([name, value]) => `${value.count}× ${value.sumPx}px ${name}`),
    scrollHeightChanges: heightChanges,
    scrollHeightChurnPx: Math.round(heightChurnPx),
    measuredHeightResets: resets.length,
    measuredLinesDropped: resets.reduce((sum, event) => sum + event.lines, 0),
    measuredPxDropped: resets.reduce((sum, event) => sum + event.px, 0),
    layoutShifts: data.shifts.length,
    layoutShiftScore: round1(data.shifts.reduce((sum, shift) => sum + shift.value, 0) * 1000) / 1000,
    layoutShiftSources: data.shifts.flatMap((shift) => shift.sources.map((source) => `${source.node} dy=${source.dy} dh=${source.dh}`)).slice(0, 4),
    longTasks: { count: data.tasks.length, longestMs: Math.max(0, ...data.tasks.map((task) => task.duration)), totalMs: data.tasks.reduce((sum, task) => sum + task.duration, 0) },
    longFrames: data.loafs.length,
    longFrameScripts: Object.entries(loafScripts).sort((left, right) => right[1].ms - left[1].ms).slice(0, 5)
      .map(([name, value]) => `${value.count}× ${value.ms} ms (forced layout ${value.forcedLayoutMs} ms) ${name}`),
    viewer: {
      ...Object.fromEntries(Object.entries(data.hooks).map(([name, value]) => [name, Math.round(value)])),
      viewRenderMsPerFrame: samples.length === 0 ? 0 : round1(data.hooks.viewRenderMs / samples.length)
    }
  }
}

// ── the reader ──────────────────────────────────────────────────────────────

/** Trackpad-like wheel input at ~60 Hz until `until`, turning around at `bounds`. */
async function scrollLoop(app, point, bounds, until, rng) {
  const acks = []
  let pending = 0
  let skipped = 0
  let direction = 1
  let segmentEnds = 0
  let cruise = 6
  let flick = 0
  let top = null
  let lastPoll = 0
  let sent = 0
  let sentPx = 0
  while (performance.now() < until) {
    const now = performance.now()
    if (now - lastPoll > 250) {
      lastPoll = now
      app.cdp.tryEval('window.__suw?.scroller?.scrollTop ?? null').then((value) => { top = value })
    }
    if (now >= segmentEnds || (top != null && ((direction > 0 && top > bounds.high) || (direction < 0 && top < bounds.low)))) {
      if (top != null && top > bounds.high) direction = -1
      else if (top != null && top < bounds.low) direction = 1
      else direction = -direction
      segmentEnds = now + 900 + rng() * 1_300
      cruise = 3 + rng() * 9
      flick = rng() < 0.4 ? 25 + rng() * 45 : 0
    }
    const delta = Math.max(1, Math.round(cruise + flick + (rng() - 0.5) * 2))
    flick *= 0.93
    if (pending > 6) skipped += 1
    else {
      pending += 1
      sent += 1
      sentPx += delta
      const started = performance.now()
      app.cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: direction * delta })
        .then(() => acks.push(performance.now() - started), () => {})
        .finally(() => { pending -= 1 })
    }
    await Bun.sleep(16)
  }
  return { sent, sentPx, skipped, ackP50Ms: quantile(acks, 0.5), ackP95Ms: quantile(acks, 0.95), ackMaxMs: Math.round(Math.max(0, ...acks)) }
}

// ── the agent ───────────────────────────────────────────────────────────────

const WRITE_KINDS = [
  'onscreen-above-insert', 'above-insert', 'onscreen-same', 'lockfile-insert', 'below-insert',
  'onscreen-below-delete', 'above-same', 'lockfile-same', 'onscreen-above-delete', 'below-delete',
  'lockfile-delete', 'above-delete', 'onscreen-below-insert', 'below-same'
]

function mutation(kind, text, anchorLine, rng, isLockfile, serial) {
  const lines = text.split('\n')
  const count = lines.length - 1
  const extra = (index) => isLockfile ? [lockLine(rng, 90_000 + serial * 10 + index), ''] : [`  // agent ${serial}.${index}: ${pick(rng, WORDS)} ${pick(rng, WORDS)} ${pick(rng, WORDS)}`]
  let at
  if (kind.startsWith('onscreen-above')) at = Math.max(1, anchorLine - between(rng, 3, 18))
  else if (kind.startsWith('onscreen-below')) at = Math.min(count, anchorLine + between(rng, 6, 30))
  else if (kind === 'onscreen-same') at = Math.max(1, Math.min(count, anchorLine + between(rng, -4, 8)))
  else at = between(rng, 1, Math.max(1, count - 1))
  const index = Math.max(0, Math.min(count - 1, at - 1))
  if (kind.endsWith('insert')) {
    const added = between(rng, 1, isLockfile ? 2 : 4)
    lines.splice(index, 0, ...Array.from({ length: added }, (_unused, i) => extra(i)).flat())
    return { text: lines.join('\n'), lines: added * (isLockfile ? 2 : 1), at }
  }
  if (kind.endsWith('delete')) {
    const removed = Math.min(between(rng, 1, 3) * (isLockfile ? 2 : 1), Math.max(0, count - index - 1))
    lines.splice(index, removed)
    return { text: lines.join('\n'), lines: -removed, at }
  }
  const bumped = lines[index].replace(/@(\d+)\.(\d+)\.(\d+)/, (_all, major, minor, patch) => `@${major}.${minor}.${Number(patch) + 1}`)
  lines[index] = isLockfile
    ? bumped !== lines[index] ? bumped : `${lines[index]} `
    : `${lines[index]} /* agent ${serial} */`
  return { text: lines.join('\n'), lines: 0, at }
}

async function writeFileAs(path, text, mode, serial) {
  if (mode === 'inplace') {
    await writeFile(path, text)
    return
  }
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}-${serial}.tmp`)
  await writeFile(temporary, text)
  await rename(temporary, path)
}

async function writeLoop(app, context, until, rng, log) {
  let serial = 0
  while (true) {
    await Bun.sleep(300 + rng() * 400)
    if (performance.now() >= until) break
    const view = await app.cdp.tryEval('window.__suw.view()')
    if (view == null) continue
    const kind = WRITE_KINDS[context.writeCursor++ % WRITE_KINDS.length]
    const mode = context.writeCursor % 2 === 0 ? 'rename' : 'inplace'
    const known = (ids) => ids.map((id) => id.replace(/^review:/, '')).filter((path) => context.texts.has(path))
    let candidates
    if (kind.startsWith('onscreen')) candidates = view.anchor == null ? known(view.visible) : known([view.anchor.id])
    else if (kind.startsWith('above')) candidates = known(view.above).filter((path) => path !== context.lockfile)
    else if (kind.startsWith('below')) candidates = known(view.below).filter((path) => path !== context.lockfile)
    else candidates = context.lockfile == null ? [] : [context.lockfile]
    // Nothing above (the top of the review) or below (the lockfile is last): the file on screen.
    if (candidates.length === 0) candidates = known(view.visible)
    if (candidates.length === 0) continue
    const path = kind.startsWith('above') ? candidates.at(-1) : kind.startsWith('below') ? candidates[0] : pick(rng, candidates)
    const anchorLine = view.anchor != null && view.anchor.id === `review:${path}` ? view.anchor.line : 1
    serial += 1
    const change = mutation(kind, context.texts.get(path), anchorLine, rng, path === context.lockfile, serial + context.writeCursor * 100)
    context.texts.set(path, change.text)
    await writeFileAs(join(context.root, path), change.text, mode, serial)
    log.push({ t: Date.now(), kind, mode, path, lines: change.lines, at: change.at })
  }
}

// ── the suite ───────────────────────────────────────────────────────────────

const deepQuery = (selector) => `(() => {
  const walk = (root) => {
    const found = root.querySelector(${JSON.stringify(selector)})
    if (found != null) return found
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot == null) continue
      const inner = walk(element.shadowRoot)
      if (inner != null) return inner
    }
    return null
  }
  return walk(document)
})()`
const visibleButton = (selector) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((button) => button.offsetParent != null && button.getBoundingClientRect().width > 0)`
const TOGGLES = {
  style: '.editor-option-controls button[aria-label="Split view"]',
  wrap: '.editor-option-controls button[aria-label="Toggle word wrap"]',
  fold: '.editor-option-controls button[aria-label="Toggle unchanged context folding"]'
}

await runSuite('scroll-under-writes', async (suite, cleanup) => {
  const runLog = { mode: MODE, visible: VISIBLE, seed: SEED, phaseMs: PHASE_MS, phases: [], toggles: [], profiles: [] }
  let root
  let profile = null
  if (MODE === 'fixture') {
    root = await writeFixture()
    cleanup(removeLater(root))
  } else {
    root = REAL_FOLDER.replace(/\/$/, '')
    if (REAL_PROFILE == null) throw new Error('KODI_E2E_SCROLL_FOLDER needs KODI_E2E_SCROLL_PROFILE (a copy of a Kodi profile).')
    profile = await copyProfile(REAL_PROFILE, root)
    cleanup(removeLater(profile))
  }

  // Every file in the review, as it was, so the folder is put back when the run ends.
  const statusOutput = await git(root, 'status', '--porcelain=v1', '-uall', '-z')
  const changed = statusOutput.split('\0').filter(Boolean).map((entry) => entry.slice(3))
    .filter((path) => existsSync(join(root, path)))
  const originals = new Map()
  for (const path of changed) originals.set(path, await readFile(join(root, path)))
  cleanup(async () => {
    for (const [path, bytes] of originals) await writeFile(join(root, path), bytes)
    for (const path of new Set(changed.map((path) => dirname(path)))) {
      for (const name of await readdir(join(root, path)).catch(() => [])) {
        if (name.endsWith('.tmp') && name.includes(`.${process.pid}-`)) await rm(join(root, path, name), { force: true })
      }
    }
  })
  const texts = new Map([...originals].map(([path, bytes]) => [path, bytes.toString('utf8')]))
  const lockfile = changed.find((path) => /(^|\/)(bun\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(path)) ?? null
  const context = { root, texts, lockfile, writeCursor: 0 }

  if (MODE === 'fixture') {
    // The preferences go in on a first launch that quits (flushing localStorage),
    // not through a reload: a reload's unmount tells main the window went away,
    // and a window that is never shown (hidden runs) then snoozes the watcher
    // for good 30 s later — every write after that never reaches the review.
    profile = await mkdtemp(join(tmpdir(), 'kodi-e2e-scroll-profile-'))
    cleanup(removeLater(profile))
    const preferences = { ...USER_PREFERENCES, ...JSON.parse(process.env.KODI_E2E_SCROLL_PREFS ?? '{}') }
    const seeding = await launchApp({ folder: root, port: PORT, profile })
    try {
      await seeding.cdp.waitFor(`document.querySelector('#repository-explorer') != null || document.querySelector('.multi-file-code-view') != null`, 30_000, 50)
      await seeding.cdp.eval(`(() => {
        const key = 'kodi:preferences:v1'
        const current = JSON.parse(localStorage.getItem(key) ?? '{}')
        localStorage.setItem(key, JSON.stringify({ ...current, ...${JSON.stringify(preferences)} }))
      })()`)
      await Bun.sleep(300)
    } finally {
      await seeding.stop()
    }
  }
  const app = await launchApp({ folder: root, port: PORT, profile })
  cleanup(app.stop)
  const { cdp, main } = app
  // The review opens with the folder; a fresh profile may land on the explorer first.
  const reviewReady = `window.__INSTANCE != null && document.querySelector('.multi-file-code-view')?.clientHeight > 0 && window.__INSTANCE.items?.length >= ${Math.min(changed.length, 5)}`
  let ready = await cdp.waitFor(reviewReady, 20_000, 50)
  if (ready.timedOut) {
    const first = changed.find((path) => path !== lockfile) ?? changed[0]
    await press(cdp, `${deepQuery(`[data-item-path="${first}"][data-item-type="file"]`)}?.click()`)
    ready = await cdp.waitFor(reviewReady, 30_000, 50)
  }
  suite.record('the folder review opens', !ready.timedOut, { files: changed.length, lockfile })
  if (ready.timedOut) return
  await Bun.sleep(2_500)
  // A lockfile starts collapsed as generated (WS-G); this suite reads inside
  // one, so the reader opens it first, as they would, and it stays open.
  if (lockfile != null && await cdp.eval(`window.__INSTANCE.getItem(${JSON.stringify(`review:${lockfile}`)})?.collapsed === true`)) {
    await cdp.eval(`window.__INSTANCE.scrollTo({ type: 'item', id: ${JSON.stringify(`review:${lockfile}`)}, align: 'start', behavior: 'instant' })`)
    const expand = deepQuery(`[data-review-collapse-button][aria-label="Expand ${lockfile}"]`)
    const found = await cdp.waitFor(`${expand} != null`, 5_000, 16)
    if (!found.timedOut) await press(cdp, `${expand}.click()`)
    const opened = await cdp.waitFor(`window.__INSTANCE.getItem(${JSON.stringify(`review:${lockfile}`)})?.collapsed !== true`, 5_000, 16)
    suite.record('the generated lockfile opens with a click', !found.timedOut && !opened.timedOut)
    await cdp.eval(`window.__INSTANCE.scrollTo({ type: 'item', id: window.__INSTANCE.items[0].id, align: 'start', behavior: 'instant' })`)
    await Bun.sleep(1_000)
  }
  await cdp.eval(INSTRUMENT)

  // Main: every invoke the renderer makes while the reader scrolls, by channel.
  if (main != null) {
    await main.send('Runtime.evaluate', {
      includeCommandLineAPI: true, returnByValue: true,
      expression: `(() => {
        const { ipcMain, webContents } = require('electron')
        if (globalThis.__suwIpc != null) return 'present'
        const log = globalThis.__suwIpc = { calls: {}, patchPaths: [], changes: [] }
        for (const [channel, handler] of ipcMain._invokeHandlers) {
          ipcMain._invokeHandlers.set(channel, (event, ...args) => {
            log.calls[channel] = (log.calls[channel] ?? 0) + 1
            if (channel === 'repository:get-working-tree-patch') log.patchPaths.push(Array.isArray(args[0]) ? args[0].length : -1)
            return handler(event, ...args)
          })
        }
        // What the watcher told the renderer changed.
        const contents = webContents.getAllWebContents()[0]
        const prototype = contents == null ? null : Object.getPrototypeOf(contents)
        if (prototype != null && prototype.__suwSend == null) {
          prototype.__suwSend = prototype.send
          prototype.send = function (channel, ...args) {
            if (channel === 'repository:did-change') {
              const change = args[0] ?? {}
              log.changes.push({ t: Date.now(), paths: (change.changedPaths ?? []).length, sample: (change.changedPaths ?? []).slice(0, 3), invalidateAll: change.invalidateAll === true })
            }
            return prototype.__suwSend.call(this, channel, ...args)
          }
        }
        return 'installed'
      })()`
    })
  }
  const ipcSnapshot = async () => main == null ? null
    : (await main.send('Runtime.evaluate', { returnByValue: true, expression: 'JSON.parse(JSON.stringify(globalThis.__suwIpc ?? null))' })).result.value

  const state = async () => await cdp.eval(`(() => {
    const instance = window.__INSTANCE
    const scroller = window.__suw.activeScroller()
    const prefs = JSON.parse(localStorage.getItem('kodi:preferences:v1') ?? '{}')
    const style = document.querySelector(${JSON.stringify(TOGGLES.style)})?.getAttribute('aria-label') ?? ''
    return {
      items: instance.items.map((record) => ({ id: record.item.id.replace(/^review:/, ''), top: Math.round(instance.getTopForItem(record.item.id) ?? record.top), height: Math.round(record.height) })),
      scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, rect: scroller.getBoundingClientRect().toJSON(),
      diffStyle: /split/.test(style) ? 'unified' : 'split', wordWrap: prefs.wordWrap, foldUnchanged: prefs.foldUnchanged, theme: prefs.editorTheme
    }
  })()`)

  const initial = await state()
  runLog.initial = initial
  console.log('review', JSON.stringify({ diffStyle: initial.diffStyle, wordWrap: initial.wordWrap, foldUnchanged: initial.foldUnchanged, theme: initial.theme, scrollHeight: initial.scrollHeight, files: initial.items.length }))
  const point = { x: Math.round(initial.rect.left + initial.rect.width * 0.62), y: Math.round(initial.rect.top + initial.rect.height * 0.55) }
  const middleItem = (items) => {
    const candidates = items.filter((item) => item.id !== lockfile)
    return candidates[Math.floor(candidates.length / 2)] ?? items[0]
  }

  const region = async (name) => {
    const current = await state()
    if (name === 'here') {
      // Right where the reader is (just after a toggle): no repositioning.
      const top = await cdp.eval('window.__suw.activeScroller().scrollTop')
      const maxScroll = current.scrollHeight - current.clientHeight
      return { name, target: 'current position', start: top, bounds: { low: Math.max(0, top - 900), high: Math.min(maxScroll, top + 1_800) } }
    }
    const maxScroll = current.scrollHeight - current.clientHeight
    const target = name === 'lockfile' && lockfile != null
      ? current.items.find((item) => item.id === lockfile)
      : middleItem(current.items)
    const start = Math.min(maxScroll, Math.max(0, target.top + (name === 'lockfile' ? 2_400 : 120)))
    const span = name === 'lockfile' ? 2_600 : 1_800
    await cdp.eval(`window.__suw.activeScroller().scrollTop = ${start}`)
    await Bun.sleep(900)
    return { name, target: target.id, start, bounds: { low: Math.max(0, start - span / 2), high: Math.min(maxScroll, start + span) } }
  }

  // `writeKey` fixes the write schedule (kinds and timing): the scrolling and
  // the idle phase of one configuration and region get the same agent.
  const phase = async (config, regionName, writes, { profileCpu = false, durationMs = PHASE_MS, idle = false, writeKey = runLog.phases.length } = {}) => {
    const where = await region(regionName)
    const rng = random(SEED * 1_000 + runLog.phases.length)
    const place = regionName === 'here' ? 'right after the toggle' : regionName
    const label = `${config}: ${idle ? `idle reader in ${place}` : `scroll ${place}`}${writes ? ' + agent writes' : ''}${profileCpu ? ' (CPU profile)' : ''}`
    context.writeCursor = writeKey * 5
    await takeLongTasks(cdp)
    const countersBefore = await counters(cdp)
    const ipcBefore = await ipcSnapshot()
    await cdp.eval('window.__suw.start()')
    await startFrames(cdp)
    if (profileCpu) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
      await cdp.send('Profiler.start')
    }
    const until = performance.now() + durationMs
    const writeLog = []
    const [scroll] = await Promise.all([
      idle ? Bun.sleep(Math.max(0, until - performance.now())).then(() => null) : scrollLoop(app, point, where.bounds, until, rng),
      writes ? writeLoop(app, context, until - 1_200, random(SEED * 7_919 + writeKey), writeLog) : null
    ])
    let cpu = null
    if (profileCpu) {
      const { profile } = await cdp.send('Profiler.stop', {}, 60_000)
      cpu = summariseProfile(profile)
      if (OUT_DIR != null) {
        await mkdir(OUT_DIR, { recursive: true })
        await writeFile(join(OUT_DIR, `${MODE}-${VISIBLE ? 'visible' : 'hidden'}-${Date.now()}.cpuprofile`), JSON.stringify(profile))
      }
    }
    const frames = await stopFrames(cdp)
    const data = await cdp.eval('window.__suw.stop()')
    const harnessTasks = await takeLongTasks(cdp)
    const countersAfter = await counters(cdp)
    const ipcAfter = await ipcSnapshot()
    const analysis = analyse(data, writeLog)
    const delta = (name) => (countersAfter[name] ?? 0) - (countersBefore[name] ?? 0)
    const patchRequests = ipcAfter == null ? null : ipcAfter.patchPaths.slice(ipcBefore?.patchPaths.length ?? 0)
    const ipcCalls = ipcAfter == null ? null : Object.fromEntries(Object.entries(ipcAfter.calls)
      .map(([channel, count]) => [channel.replace(/^repository:/, ''), count - (ipcBefore?.calls[channel] ?? 0)]).filter(([, count]) => count > 0))
    const reviewSize = initial.items.length
    const wholeReviewRefetches = (patchRequests ?? []).filter((paths) => paths >= Math.max(3, reviewSize - 1)).length
    const changes = ipcAfter == null ? null : ipcAfter.changes.slice(ipcBefore?.changes.length ?? 0)
    const result = {
      label, region: where.target, frames, longTasks: harnessTasks, scroll, writes: writeLog.length,
      writeKinds: writeLog.map((write) => `${write.kind}/${write.mode}`),
      counters: { comparisonRequests: delta('comparisonRequests'), reviewPagedFallbacks: delta('reviewPagedFallbacks'), autoHydrations: delta('autoHydrations'), workspaceRenders: delta('workspaceRenders') },
      ipc: ipcCalls, patchRequestSizes: patchRequests, wholeReviewRefetches,
      watcherChanges: changes == null ? null : changes.map((change) => `${change.paths}${change.invalidateAll ? '*' : ''}:${change.sample.map((path) => path.split('/').at(-1)).join(',')}`),
      ...analysis, cpu
    }
    const failures = []
    if (result.anchorDrifts > 0) failures.push(`${result.anchorDrifts} anchor drifts > ${DRIFT_PX}px (max ${result.maxDriftPx}px)`)
    if (frames.p95Ms > FRAME_P95_MS && !profileCpu) failures.push(`frame p95 ${frames.p95Ms} ms > ${FRAME_P95_MS}`)
    if (harnessTasks.longestMs > LONG_TASK_MS && !profileCpu) failures.push(`long task ${harnessTasks.longestMs} ms > ${LONG_TASK_MS}`)
    if (!idle && result.stalls > 0) failures.push(`${result.stalls} wheel events took ≥ 50 ms to move the list (longest ${result.longestStallMs} ms)`)
    if (result.reversedFrames > 0) failures.push(`${result.reversedFrames} frames moved against the wheel`)
    // Nothing changed but the scroll position: any scroll the page made itself was
    // a re-measured row correcting the position against the reader's wheel.
    if (!idle && writeLog.length === 0 && result.programmaticScrolls > 0) {
      failures.push(`${result.programmaticScrolls} scroll corrections (${result.programmaticScrollPx}px) while only the reader scrolled`)
    }
    if (writes && (changes?.length ?? 1) === 0) failures.push('no write reached the review (the watcher reported nothing)')
    if (writes && (result.counters.comparisonRequests > 0 || result.counters.reviewPagedFallbacks > 0 || wholeReviewRefetches > 0)) {
      failures.push(`whole-review refetch (comparisons +${result.counters.comparisonRequests}, fallbacks +${result.counters.reviewPagedFallbacks}, full patches ${wholeReviewRefetches})`)
    }
    // A profiled window pays the sampler's own cost: it is evidence, not a gate.
    suite.record(label, profileCpu || failures.length === 0, { ...result, ...(failures.length === 0 ? {} : { [profileCpu ? 'observed' : 'failures']: failures }) })
    runLog.phases.push({ ...result, samples: data.samples, events: data.events.slice(0, 400), shifts: data.shifts, loafs: data.loafs, writeLog })
    return result
  }

  // A toggle must keep the reader's line where it was, settle, and hand the
  // scroll back to the reader.
  const toggle = async (config, name, where = 'middle') => {
    await region(where)
    await cdp.eval(`window.__suw.activeScroller().scrollTop += 37`)
    await Bun.sleep(700)
    const before = await cdp.eval('window.__suw.pinCurrent()')
    const stateBefore = await state()
    await takeLongTasks(cdp)
    await cdp.eval(`window.__suw.start({ pin: ${JSON.stringify(before == null ? null : { id: before.id, line: before.line, text: before.text })} })`)
    const started = performance.now()
    const clicked = await press(cdp, `(() => { const button = ${visibleButton(TOGGLES[name])}; if (button == null) return false; button.click(); return true })()`)
    const clickMs = Math.round(performance.now() - started)
    await Bun.sleep(1_800)
    const data = await cdp.eval('window.__suw.stop()')
    const tasks = await takeLongTasks(cdp)
    const after = await cdp.eval('window.__suw.pinCurrent()')
    const stateAfter = await state()
    const pinned = data.samples.filter((sample) => sample.pinY != null)
    const last = pinned.at(-1) ?? null
    let settledAtMs = 0
    for (let index = 1; index < pinned.length; index += 1) {
      if (Math.abs(pinned[index].pinY - pinned[index - 1].pinY) > 1) settledAtMs = pinned[index].t - data.samples[0].t
    }
    const excursions = pinned.map((sample) => Math.abs(sample.pinY - (before?.y ?? 0)))
    const result = {
      label: `${config}: toggle ${name}${where === 'lockfile' ? ' in the lockfile' : ''}`, clicked, clickMs, longTasks: tasks,
      from: `${stateBefore.diffStyle}/wrap ${stateBefore.wordWrap}/fold ${stateBefore.foldUnchanged}`,
      to: `${stateAfter.diffStyle}/wrap ${stateAfter.wordWrap}/fold ${stateAfter.foldUnchanged}`,
      anchor: before == null ? null : `${before.id.replace(/^review:/, '')}:${before.line} at y=${Math.round(before.y)}`,
      anchorEndY: last?.pinY ?? null,
      anchorMovedPx: last == null || before == null ? null : Math.round(last.pinY - before.y),
      anchorMaxExcursionPx: excursions.length === 0 ? null : Math.round(Math.max(...excursions)),
      anchorOnScreenAtEnd: last != null && data.samples.at(-1)?.pinY != null,
      settledAfterMs: settledAtMs,
      scrollTopBefore: Math.round(before?.st ?? 0), scrollTopAfter: Math.round(after?.st ?? 0),
      lineAtTopAfter: after == null ? null : `${after.id.replace(/^review:/, '')}:${after.line}`,
      scrollHeightBefore: stateBefore.scrollHeight, scrollHeightAfter: stateAfter.scrollHeight,
      programmaticScrolls: data.events.filter((event) => event.type === 'prog').length,
      viewerInstances: data.hooks.instances,
      measuredLinesDropped: data.hooks.measuredLinesDropped,
      viewRenders: data.hooks.viewRenders
    }
    const failures = []
    if (!clicked) failures.push('no toggle button')
    if (result.anchorMovedPx == null || !result.anchorOnScreenAtEnd) failures.push('the line being read left the screen')
    else if (Math.abs(result.anchorMovedPx) > TOGGLE_DRIFT_PX) failures.push(`the line being read moved ${result.anchorMovedPx}px`)
    if (tasks.longestMs > 200) failures.push(`long task ${tasks.longestMs} ms`)
    suite.record(result.label, failures.length === 0, { ...result, ...(failures.length === 0 ? {} : { failures }) })
    runLog.toggles.push({ ...result, samples: data.samples, events: data.events.slice(0, 200) })
    return result
  }

  const configurations = [
    { name: `${initial.diffStyle}+wrap${initial.wordWrap ? 'On' : 'Off'}+fold${initial.foldUnchanged ? 'On' : 'Off'}`, toggle: null },
    { toggle: 'style' },
    { toggle: 'wrap' },
    { toggle: 'fold' },
    { toggle: 'style' }
  ]
  let currentName = configurations[0].name
  for (const [index, configuration] of configurations.entries()) {
    if (configuration.toggle != null) {
      const toggled = await toggle(currentName, configuration.toggle)
      const now = await state()
      currentName = `${now.diffStyle}+wrap${now.wordWrap ? 'On' : 'Off'}+fold${now.foldUnchanged ? 'On' : 'Off'}`
      if (!toggled.clicked) break
      if (currentName.includes(ONLY)) await phase(currentName, 'here', false, { durationMs: Math.round(PHASE_MS / 2) })
      await Bun.sleep(600)
    }
    if (!currentName.includes(ONLY)) continue
    await phase(currentName, 'middle', false)
    await phase(currentName, 'middle', true, { writeKey: index * 2 })
    await phase(currentName, 'middle', true, { writeKey: index * 2, idle: true })
    if (lockfile != null) {
      await phase(currentName, 'lockfile', false)
      await phase(currentName, 'lockfile', true, { writeKey: index * 2 + 1 })
      await phase(currentName, 'lockfile', true, { writeKey: index * 2 + 1, idle: true })
    }
    if (CPU_PROFILE && index === 0) {
      await phase(currentName, lockfile != null ? 'lockfile' : 'middle', true, { profileCpu: true, durationMs: 9_000, writeKey: 1 })
      await phase(currentName, 'middle', true, { profileCpu: true, durationMs: 9_000, writeKey: 0 })
    }
  }

  // Inside the lockfile — thousands of long lines, most never measured — every
  // toggle once each way, wrap first so the others run with wrapping on.
  if (lockfile != null && process.env.KODI_E2E_SCROLL_LOCKFILE_TOGGLES !== '0') {
    for (const name of ['wrap', 'style', 'style', 'fold', 'fold', 'wrap']) {
      const toggled = await toggle(currentName, name, 'lockfile')
      const now = await state()
      currentName = `${now.diffStyle}+wrap${now.wordWrap ? 'On' : 'Off'}+fold${now.foldUnchanged ? 'On' : 'Off'}`
      if (!toggled.clicked) break
      await Bun.sleep(400)
    }
  }

  suite.record('memory at end', true, await app.memory())
  if (OUT_DIR != null) {
    await mkdir(OUT_DIR, { recursive: true })
    const file = join(OUT_DIR, `${MODE}-${VISIBLE ? 'visible' : 'hidden'}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    await writeFile(file, JSON.stringify(runLog))
    console.log('run log', file)
  }
})
