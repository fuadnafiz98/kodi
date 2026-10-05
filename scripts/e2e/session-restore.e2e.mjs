// What a relaunch brings back must follow what the reader left in front:
//   - a folder left open comes back;
//   - a folder whose tab was closed stays closed — the dashboard opens instead;
//   - the file that comes back can be typed into, and Discard leaves it where it was.
//
//   bun run build && bun run e2e session-restore
//
// Before the fix, closing the tab released the folder but left it as the one to
// restore, so every launch reopened it. The file painted from the cache at launch
// took keystrokes without the app hearing of them — no Unsaved, no Discard — and
// was later redrawn under the caret, which then deleted at the end of the file.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createProfile, createRepository, git, launchApp, press, removeLater, runSuite } from './harness.mjs'

// The session is written right away, the workspace cache a second after the
// last change; the restart waits for both.
const PERSIST_SETTLE_MS = 2_500
const fileCount = `document.querySelector('.sidebar-file-count') != null`
const dashboard = `document.querySelector('.welcome') != null && document.querySelector('.sidebar-file-count') == null`
const closeActiveTab = `document.querySelector('.world-tab[data-active="true"] .world-close').click()`
// The single-file surface's shadow root, and the new side's text on one line.
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
const scrollTop = `document.querySelector('.editor-scroll')?.scrollTop ?? null`
const notes = Array.from({ length: 200 }, (_unused, line) => `export const n${line} = ${line}\n`).join('')

await runSuite('session-restore', async (suite, cleanup) => {
  const fixture = await createRepository('restore')
  cleanup(removeLater(fixture))

  // Control: an open folder survives a restart, so the next case can only pass
  // for the right reason.
  {
    const { profile, cleanup: removeProfile } = await createProfile()
    cleanup(removeProfile)
    const first = await launchApp({ folder: fixture, profile })
    await first.cdp.waitFor(fileCount, 20_000, 16)
    await Bun.sleep(PERSIST_SETTLE_MS)
    await first.stop()
    const second = await launchApp({ profile })
    const restored = await second.cdp.waitFor(fileCount, 15_000, 16)
    suite.record('a folder left open comes back after a restart', !restored.timedOut)
    await second.stop()
  }

  {
    const { profile, cleanup: removeProfile } = await createProfile()
    cleanup(removeProfile)
    const first = await launchApp({ folder: fixture, profile })
    await first.cdp.waitFor(fileCount, 20_000, 16)
    await first.cdp.waitFor(`document.querySelector('.world-tab[data-active="true"] .world-close') != null`, 10_000, 16)
    await press(first.cdp, closeActiveTab)
    const closed = await first.cdp.waitFor(dashboard, 10_000, 16)
    suite.record('closing the tab shows the dashboard', !closed.timedOut)
    await Bun.sleep(PERSIST_SETTLE_MS)
    await first.stop()

    const second = await launchApp({ profile })
    await second.cdp.waitFor(`document.querySelector('.welcome, .sidebar-file-count') != null`, 15_000, 16)
    // Give a late restore every chance to show up before calling it absent.
    await Bun.sleep(2_000)
    const reopened = await second.cdp.tryEval(fileCount)
    suite.record('a closed folder stays closed after a restart', reopened === false, { reopened })
    await second.stop()
  }

  {
    const repository = await createRepository('restore-edit')
    cleanup(removeLater(repository))
    await writeFile(join(repository, 'notes.ts'), notes)
    await git(repository, 'add', '-A')
    await git(repository, 'commit', '--quiet', '-m', 'Notes')
    const { profile, cleanup: removeProfile } = await createProfile()
    cleanup(removeProfile)
    const first = await launchApp({ folder: repository, profile })
    cleanup(first.stop)
    await first.cdp.waitFor(fileCount, 20_000, 16)
    await first.cdp.combo('k', 'KeyK', 75, 4)
    await first.cdp.waitFor(`document.activeElement === document.querySelector('#command-palette-input')`, 8_000, 4)
    await first.cdp.send('Input.insertText', { text: 'notes.ts' })
    await first.cdp.waitFor(`[...document.querySelectorAll('.command-palette-results button')].some((row) => row.textContent.includes('notes.ts'))`, 8_000, 8)
    await first.cdp.enter()
    await first.cdp.waitFor(`${lineText(10)} === 'export const n9 = 9'`, 10_000, 16)
    await Bun.sleep(PERSIST_SETTLE_MS)
    await first.stop()

    const second = await launchApp({ profile })
    cleanup(second.stop)
    const { cdp } = second
    const shown = await cdp.waitFor(`${lineText(10)} === 'export const n9 = 9'`, 15_000, 16)
    suite.record('the file left open is back on screen after a restart', !shown.timedOut, {
      path: await cdp.tryEval(`document.querySelector('.editor-breadcrumbs')?.textContent ?? document.querySelector('.diff-file-title')?.textContent ?? null`),
      state: await cdp.tryEval(`document.querySelector('.diff-state')?.textContent ?? null`)
    })
    // A reader looks before they type; the file main reads replaces the painted one.
    await Bun.sleep(1_500)
    // The viewer anchored a file that had no height yet by its bottom, so the
    // file opened scrolled to its last line.
    const openedAt = await cdp.eval(scrollTop)
    suite.record('the restored file opens at its top, not its last line', openedAt === 0, { scrollTop: openedAt })
    await cdp.waitFor(`${pointOnLine(10, 14)} != null`, 5_000, 16)
    const point = await cdp.eval(pointOnLine(10, 14))
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
    }
    await cdp.waitFor(editorFocused, 5_000, 16)
    await cdp.key('keyDown', 'Backspace', 'Backspace', 8, 0)
    await cdp.key('keyUp', 'Backspace', 'Backspace', 8, 0)
    const unsaved = await cdp.waitFor(`document.querySelector('.file-edit-actions .file-edit-state')?.textContent === 'Unsaved'`, 5_000, 16)
    suite.record('typing in the restored file is unsaved', !unsaved.timedOut)
    suite.record('Backspace deletes one character on its line', await cdp.eval(`${lineText(10)} === 'export const 9 = 9' && ${lineText(11)} === 'export const n10 = 10'`),
      { line10: await cdp.eval(lineText(10)), line11: await cdp.eval(lineText(11)) })
    const before = await cdp.eval(scrollTop)
    await press(cdp, `document.querySelector('[aria-label="Discard changes"]')?.click()`)
    const discarded = await cdp.waitFor(`${lineText(10)} === 'export const n9 = 9'`, 5_000, 16)
    await Bun.sleep(300)
    const after = await cdp.eval(scrollTop)
    suite.record('Discard puts the line back and leaves the file where it was', !discarded.timedOut && before === after, { before, after })
    await second.stop()
  }
})
