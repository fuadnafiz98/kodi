// `kodi <folder>` from a terminal, and the quit that must leave nothing behind
// for the next one:
//
//   - with the app up, `kodi <folder>` shows that folder. Main opened it and
//     brought the window forward, but the window drops change events for every
//     root but its own, so it stayed on the folder it was showing;
//   - `kodi <folder>` for a folder open in another tab goes back to that tab,
//     also from a commit review of that folder in front (the working tree is
//     what it names);
//   - `kodi <folder>` straight after a launch on another folder ends on the one
//     it named;
//   - a SIGTERM quit with nothing left to write ends the process. The quit ran
//     its second app.quit() inside the first, Electron marked the first one
//     cancelled after the second had closed the window, and the app stayed up
//     without one, holding the single-instance lock. Every launch and `kodi .`
//     after that was handed to it; an install left the old build running that
//     way for hours;
//   - so the next launch on the profile opens its folder;
//   - a SIGTERM quit with an unsaved draft ends too. Electron replaced the app's
//     SIGTERM handler with its own, so the unsaved-changes prompt (which the
//     app's handler skips: nobody is there to answer it) held the quit for good;
//   - and that draft, typed a moment before the signal, is back on the next
//     launch: the drafts were written 400 ms after the last keystroke, and a
//     page that unloaded first took them with it.
//
//   bun run e2e kodi-cli
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { createProfile, createRepository, git, launchApp, launchSecondInstance, press, removeLater, runSuite } from './harness.mjs'

// The app's own failsafe exits at 3 s; a healthy quit takes a fraction of that.
const QUIT_BUDGET_MS = 3_500
const notes = Array.from({ length: 200 }, (_unused, line) => `export const n${line} = ${line}\n`).join('')

const treeRow = (path) => `(() => {
  const walk = (root) => root.querySelector('[data-item-path="${path}"][data-item-type="file"]')
    ?? [...root.querySelectorAll('*')].reduce((found, element) => found ?? (element.shadowRoot == null ? null : walk(element.shadowRoot)), null)
  return walk(document)
})()`
const showing = (shown, hidden) => `${treeRow(shown)} != null && ${treeRow(hidden)} == null`
const activeTab = `document.querySelector('.world-tab[data-active="true"]')`
const deskInFront = (folder) => `(${activeTab}?.querySelector('.world-source-icon[data-source="desk"]') != null
  && ${activeTab}.textContent.includes(${JSON.stringify(basename(folder))}))`
const PORT = Number(process.env.KODI_E2E_PORT ?? 9391)

// The single-file surface's shadow root and a point on one of its lines.
const singleRoot = `((() => {
  const host = document.querySelector('.diff-stale-host')
  if (host == null) return null
  const walk = (root) => {
    const line = root.querySelector('[data-content] [data-line]')
    if (line != null) return line.getRootNode()
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot == null) continue
      const found = walk(element.shadowRoot)
      if (found != null) return found
    }
    return null
  }
  return walk(host)
})())`
const lineText = (line) => `(${singleRoot}?.querySelector('[data-content] [data-line="${line}"]')?.textContent ?? null)`
const pointOnLine = (line, character) => `(() => {
  const element = ${singleRoot}?.querySelector('[data-content] [data-line="${line}"]')
  if (element == null) return null
  const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let remaining = ${character}
  for (let node = text.nextNode(); node != null; node = text.nextNode()) {
    if (remaining < node.textContent.length) {
      const range = document.createRange()
      range.setStart(node, remaining)
      range.setEnd(node, remaining + 1)
      const rect = range.getBoundingClientRect()
      return { x: Math.round(rect.left + 1), y: Math.round(rect.top + rect.height / 2) }
    }
    remaining -= node.textContent.length
  }
  return null
})()`
const editorFocused = `(() => {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement != null) active = active.shadowRoot.activeElement
  return active?.isContentEditable === true
})()`

async function devToolsUp() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(200) })
    return true
  } catch {
    return false
  }
}

/** ⌘K to `path`, then a Backspace in line 10, which leaves an unsaved draft. */
async function typeDraft(cdp, path) {
  await cdp.combo('k', 'KeyK', 75, 4)
  await cdp.waitFor(`document.activeElement === document.querySelector('#command-palette-input')`, 8_000, 4)
  await cdp.send('Input.insertText', { text: path })
  await cdp.waitFor(`[...document.querySelectorAll('.command-palette-results button')].some((row) => row.textContent.includes(${JSON.stringify(path)}))`, 8_000, 8)
  await cdp.enter()
  await cdp.waitFor(`${lineText(10)} === 'export const n9 = 9'`, 10_000, 16)
  await cdp.waitFor(`${pointOnLine(10, 14)} != null`, 5_000, 16)
  const point = await cdp.eval(pointOnLine(10, 14))
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
  await cdp.waitFor(editorFocused, 5_000, 16)
  await cdp.key('keyDown', 'Backspace', 'Backspace', 8, 0)
  await cdp.key('keyUp', 'Backspace', 'Backspace', 8, 0)
  return !(await cdp.waitFor(`document.querySelector('.file-edit-actions .file-edit-state')?.textContent === 'Unsaved'`, 5_000, 16)).timedOut
}

async function repository(name, files) {
  const root = await createRepository(`cli-${name}`)
  for (const [path, contents] of Object.entries(files)) await writeFile(join(root, path), contents)
  await git(root, 'add', '-A')
  await git(root, 'commit', '--quiet', '-m', name)
  return root
}

/** SIGTERM to the main process alone, as an install sends it. */
async function quitBySignal(app) {
  const pid = app.mainPid()
  if (pid == null) return { exited: false, error: 'no main process' }
  const started = Date.now()
  process.kill(pid, 'SIGTERM')
  while (Date.now() - started < QUIT_BUDGET_MS + 2_000) {
    try {
      process.kill(pid, 0)
    } catch {
      return { exited: true, ms: Date.now() - started }
    }
    await Bun.sleep(25)
  }
  return { exited: false, ms: Date.now() - started }
}

await runSuite('kodi-cli', async (suite, cleanup) => {
  const alpha = await repository('alpha', { 'alpha.ts': 'export const alpha = 1\n' })
  cleanup(removeLater(alpha))
  const beta = await repository('beta', { 'beta.ts': 'export const beta = 1\n' })
  cleanup(removeLater(beta))
  const { profile, cleanup: removeProfile } = await createProfile()
  cleanup(removeProfile)

  const first = await launchApp({ folder: alpha, profile })
  cleanup(first.stop)
  await first.cdp.waitFor(showing('alpha.ts', 'beta.ts'), 20_000, 16)

  await launchSecondInstance(profile, beta)
  const switched = await first.cdp.waitFor(showing('beta.ts', 'alpha.ts'), 8_000, 16)
  suite.record('kodi <folder> with the app up shows that folder', !switched.timedOut, {
    activeTab: await first.cdp.tryEval(`document.querySelector('.world-tab[data-active="true"]')?.textContent ?? null`)
  })

  await launchSecondInstance(profile, alpha)
  const back = await first.cdp.waitFor(showing('alpha.ts', 'beta.ts'), 8_000, 16)
  const tabs = await first.cdp.tryEval(`document.querySelectorAll('.world-tab').length`)
  suite.record('kodi <folder> open in another tab goes back to it', !back.timedOut && tabs === 2, { tabs })

  // A commit review of the folder in front: the applied root is the folder's own.
  await press(first.cdp, `document.querySelector('.chrome-branch-button').click()`)
  await first.cdp.waitFor(`[...document.querySelectorAll('.git-panel-tabs [role="tab"]')].some((tab) => tab.textContent.startsWith('History'))`, 10_000, 16)
  await press(first.cdp, `[...document.querySelectorAll('.git-panel-tabs [role="tab"]')].find((tab) => tab.textContent.startsWith('History')).click()`)
  await first.cdp.waitFor(`document.querySelector('.commit-row button[aria-label^="Review commit"]') != null`, 10_000, 16)
  await press(first.cdp, `document.querySelector('.commit-row button[aria-label^="Review commit"]').click()`)
  const commitInFront = !(await first.cdp.waitFor(`${activeTab}?.querySelector('.world-source-icon[data-source="patch"]') != null`, 10_000, 16)).timedOut
  await launchSecondInstance(profile, alpha)
  const desk = await first.cdp.waitFor(deskInFront(alpha), 8_000, 16)
  suite.record('kodi <folder> with a commit review of it in front shows its working tree', commitInFront && !desk.timedOut, {
    commitInFront,
    activeTab: await first.cdp.tryEval(`${activeTab}?.textContent ?? null`)
  })

  // Long enough for every write the opens queued to land: the quit then has
  // nothing to wait for, which is when it used to run inside itself.
  await Bun.sleep(1_500)
  const idleQuit = await quitBySignal(first)
  suite.record('a SIGTERM quit with nothing left to write ends the process', idleQuit.exited && idleQuit.ms <= QUIT_BUDGET_MS, idleQuit)

  try {
    const next = await launchApp({ folder: beta, profile })
    cleanup(next.stop)
    const opened = await next.cdp.waitFor(showing('beta.ts', 'alpha.ts'), 15_000, 16)
    suite.record('the next launch opens its folder', !opened.timedOut)
    await next.stop()
  } catch (error) {
    // A survivor still serves the DevTools port, or took the hand-off and showed nothing.
    suite.record('the next launch opens its folder', false, { error: error.message })
  }
  await first.stop()

  {
    // `kodi beta` the moment the app launched on alpha is up. Spawning the second
    // launch takes longer than this window takes to boot, so the narrow race
    // (the window asked before main opened beta, or was not listening yet) is
    // not hit from here; the launch path through the window's take is.
    const { profile: bootProfile, cleanup: removeBootProfile } = await createProfile()
    cleanup(removeBootProfile)
    const launching = launchApp({ folder: alpha, profile: bootProfile })
    const deadline = Date.now() + 20_000
    while (!(await devToolsUp()) && Date.now() < deadline) await Bun.sleep(25)
    await launchSecondInstance(bootProfile, beta)
    const booted = await launching
    cleanup(booted.stop)
    const landed = await booted.cdp.waitFor(showing('beta.ts', 'alpha.ts'), 10_000, 16)
    suite.record('kodi <folder> while the window boots on another folder ends on the one it named', !landed.timedOut, {
      activeTab: await booted.cdp.tryEval(`${activeTab}?.textContent ?? null`)
    })
    await booted.stop()
  }

  {
    const edited = await repository('draft', { 'notes.ts': notes })
    cleanup(removeLater(edited))
    const { profile: draftProfile, cleanup: removeDraftProfile } = await createProfile()
    cleanup(removeDraftProfile)
    const app = await launchApp({ folder: edited, profile: draftProfile })
    cleanup(app.stop)
    await app.cdp.waitFor(`document.querySelector('.sidebar-file-count') != null`, 20_000, 16)
    const unsaved = await typeDraft(app.cdp, 'notes.ts')
    // Straight away: inside the 400 ms the draft store waits before it writes.
    const draftQuit = await quitBySignal(app)
    suite.record('a SIGTERM quit with an unsaved draft ends the process', unsaved && draftQuit.exited && draftQuit.ms <= QUIT_BUDGET_MS,
      { unsaved, ...draftQuit })
    await app.stop()

    const again = await launchApp({ folder: edited, profile: draftProfile })
    cleanup(again.stop)
    const { cdp } = again
    await cdp.waitFor(`document.querySelector('.sidebar-file-count') != null`, 20_000, 16)
    await cdp.combo('k', 'KeyK', 75, 4)
    await cdp.waitFor(`document.activeElement === document.querySelector('#command-palette-input')`, 8_000, 4)
    await cdp.send('Input.insertText', { text: 'notes.ts' })
    await cdp.waitFor(`[...document.querySelectorAll('.command-palette-results button')].some((row) => row.textContent.includes('notes.ts'))`, 8_000, 8)
    await cdp.enter()
    const restored = await cdp.waitFor(`${lineText(10)} === 'export const 9 = 9'`, 10_000, 16)
    suite.record('the draft typed just before that quit is back on the next launch', !restored.timedOut, {
      line10: await cdp.tryEval(lineText(10)),
      state: await cdp.tryEval(`document.querySelector('.file-edit-actions .file-edit-state')?.textContent ?? null`)
    })
    await again.stop()
  }
})
