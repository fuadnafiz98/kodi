// A file is edited by clicking into it — on its own and inside the folder
// review — with no mode, no Edit button and nothing new paid for until then.
//
//   bun run build && bun run e2e in-place-editing
//
// Every check is an outcome: the text on disk after ⌘S, where the caret was,
// what stayed where it was on screen.
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'

import { createRepository, git, launchApp, press, removeLater, runSuite, startFrames, stopFrames, largestScroller, scrollGesture } from './harness.mjs'

const deepAll = (selector) => `(() => {
  const found = []
  const walk = (root) => {
    for (const element of root.querySelectorAll(${JSON.stringify(selector)})) found.push(element)
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot != null) walk(element.shadowRoot)
  }
  walk(document)
  return found
})()`
const fileRow = (path) => `${deepAll(`[data-item-path="${path}"][data-item-type="file"]`)}[0]`
const editorFocused = `(() => {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement != null) active = active.shadowRoot.activeElement
  return active?.isContentEditable === true
})()`
// The shadow root a review file renders into, found by its header.
const reviewRoot = (path) => `(${deepAll('[data-diffs-header] [data-title]')}.find((title) => title.textContent === ${JSON.stringify(path)})?.getRootNode() ?? null)`
// The single-file surface only: a retained review viewer can still be mounted.
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
// Where to click so the caret lands before character `character` of the new
// side's line `line`: the left edge of that character, plus a pixel.
const pointOnLine = (root, line, character, { deletion = false } = {}) => `(() => {
  const root = ${root}
  if (root == null) return null
  const lines = [...root.querySelectorAll('[data-content] [data-line="${line}"]')]
  const element = lines.find((candidate) => (candidate.dataset.lineType === 'change-deletion') === ${deletion}
    && !candidate.closest('code')?.hasAttribute('data-deletions'))
  if (element == null) return null
  element.scrollIntoView?.({ block: 'center' })
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  let remaining = ${character}
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
    if (remaining <= node.textContent.length) {
      const range = document.createRange()
      range.setStart(node, remaining)
      range.setEnd(node, Math.min(node.textContent.length, remaining + 1))
      const rect = range.getBoundingClientRect()
      return { x: Math.round(rect.left + 1), y: Math.round(rect.top + rect.height / 2) }
    }
    remaining -= node.textContent.length
  }
  return null
})()`
// The first added line the review has drawn for `path`, with its line number:
// the review renders a window, so a fixed line may not be on screen.
const firstAddedLine = (path) => `(() => {
  const root = ${reviewRoot(path)}
  if (root == null) return null
  const lines = [...root.querySelectorAll('[data-content] [data-line-type="change-addition"]')]
  lines[0]?.scrollIntoView({ block: 'center' })
  // The one the pointer would really hit there: a drawn row can sit under
  // another one, or outside the part of the list on screen.
  for (const line of lines) {
    const text = document.createTreeWalker(line, NodeFilter.SHOW_TEXT).nextNode()
    if (text == null) continue
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 1)
    const rect = range.getBoundingClientRect()
    const x = Math.round(rect.left + 1)
    const y = Math.round(rect.top + rect.height / 2)
    if (root.elementFromPoint(x, y)?.closest('[data-line]') === line) return { x, y, line: Number(line.dataset.line) }
  }
  return null
})()`
// Focus inside one review file's editor, not merely in some editor: closing the
// palette gives focus back to whichever editor had it.
const editorFocusedIn = (path) => `(() => {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement != null) active = active.shadowRoot.activeElement
  return active?.isContentEditable === true && active.getRootNode() === ${reviewRoot(path)}
})()`
const unsavedInToolbar = `document.querySelector('.file-edit-actions .file-edit-state')?.textContent === 'Unsaved'
  && document.querySelector('.file-edit-save') != null`
const unsavedInReview = (path) => `(${deepAll('[data-review-save]')}).some((button) => button.getAttribute('aria-label') === ${JSON.stringify(`Save ${path}`)})`
const headerTop = (path) => `(${deepAll('[data-diffs-header] [data-title]')}.find((title) => title.textContent === ${JSON.stringify(path)})?.getBoundingClientRect().top ?? null)`
// Save arrives in space the toolbar already held: the title's box and the view
// toggles stay exactly where they were.
const titleLeft = `(() => {
  const context = document.querySelector('.diff-toolbar-context')?.getBoundingClientRect()
  const controls = document.querySelector('.diff-display-controls')?.getBoundingClientRect()
  return context == null || controls == null ? null : \`\${Math.round(context.width)}:\${Math.round(controls.left)}\`
})()`

const lines = (label, count, edited) => Array.from({ length: count }, (_unused, line) =>
  edited && line % 40 === 17 ? `export const ${label}${line} = 'edited'\n` : `export const ${label}${line} = ${line}\n`).join('')
const insertAt = (text, lineNumber, character, inserted) => {
  const all = text.split('\n')
  all[lineNumber - 1] = all[lineNumber - 1].slice(0, character) + inserted + all[lineNumber - 1].slice(character)
  return all.join('\n')
}

const ACTIVATE = { settleMs: 600, rendererMs: 400, mainMs: 250, longTaskMs: 150 }
const SAVE = { settleMs: 800, rendererMs: 300, mainMs: 250, longTaskMs: 120 }

await runSuite('in-place-editing', async (suite, cleanup) => {
  const fixture = await createRepository('in-place-editing')
  cleanup(removeLater(fixture))
  await mkdir(join(fixture, 'changed'), { recursive: true })
  await writeFile(join(fixture, 'notes.ts'), lines('n', 200, false))
  for (const name of ['a', 'b', 'c']) await writeFile(join(fixture, `changed/${name}.ts`), lines(name, 400, false))
  await writeFile(join(fixture, 'docs.md'), '# Docs\n\nA paragraph.\n')
  await git(fixture, 'add', '-A')
  await git(fixture, 'commit', '--quiet', '-m', 'Base')
  for (const name of ['a', 'b', 'c']) await writeFile(join(fixture, `changed/${name}.ts`), lines(name, 400, true))
  const onDisk = (path) => readFile(join(fixture, path), 'utf8')

  const app = await launchApp({ folder: fixture })
  cleanup(app.stop)
  const { cdp } = app
  await cdp.waitFor(`${fileRow('notes.ts')} != null`, 30_000, 16)
  // The review opens on its own first file as the app starts; a pick made
  // before that lands is taken back by it.
  await cdp.waitFor(`document.querySelector('.multi-file-code-view') != null && ${deepAll('[data-content] [data-line]')}.length > 0`, 30_000, 16)
  await Bun.sleep(1_500)

  const click = async (point) => {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }
  // Every scroll position the review and the single-file view are at, so a
  // point is only taken once nothing moves: opening a file from the tree eases
  // the review to it over a few hundred milliseconds.
  const scrollPositions = `${deepAll('.multi-file-code-view, .diff-scroll')}.map((element) => element.scrollTop).join(',')`
  const untilStill = async () => {
    let last = null
    let still = 0
    for (let attempt = 0; attempt < 80 && still < 4; attempt += 1) {
      const now = await cdp.eval(scrollPositions)
      still = now === last ? still + 1 : 0
      last = now
      await Bun.sleep(50)
    }
  }
  const pointFor = async (expression, label = '') => {
    const result = await cdp.waitFor(`${expression} != null`, 10_000, 16)
    if (result.timedOut) throw new Error(`no point for ${label}`)
    // The point scrolls its line into view, so it is only true once that scroll
    // and any the review was already making have settled: measured again, with
    // the views still, until two readings agree.
    await untilStill()
    let point = await cdp.eval(expression)
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await untilStill()
      const again = await cdp.eval(expression)
      const settled = again != null && point != null && again.x === point.x && again.y === point.y
      point = again
      if (settled) break
    }
    await cdp.waitFor(`document.elementFromPoint(${point.x}, ${point.y})?.shadowRoot != null`, 3_000, 16)
    return point
  }
  const palette = async (query) => {
    await cdp.combo('k', 'KeyK', 75, 4)
    await cdp.waitFor(`document.activeElement === document.querySelector('#command-palette-input')`, 8_000, 4)
    await cdp.send('Input.insertText', { text: query })
    await cdp.waitFor(`[...document.querySelectorAll('.command-palette-results button')].some((row) => row.textContent.includes(${JSON.stringify(query)}))`, 8_000, 8)
    await cdp.enter()
  }
  const saveKey = () => cdp.combo('s', 'KeyS', 83, 4)

  // ── A unified diff numbers both sides, as GitHub does ─────────────────────
  // changed/a.ts rewrites line 18: its deleted row shows 18 in the old column
  // only, its added row 18 in the new column only, a context row both.
  const gutter = await cdp.eval(`(() => {
    const root = ${reviewRoot('changed/a.ts')}
    if (root == null) return null
    const cells = [...root.querySelectorAll('[data-gutter] [data-column-number]')]
    const read = (cell) => cell == null ? null : {
      old: getComputedStyle(cell, '::after').content,
      number: cell.querySelector('[data-line-number-content]')?.textContent ?? null,
      numberShown: cell.querySelector('[data-line-number-content]') != null
        && getComputedStyle(cell.querySelector('[data-line-number-content]')).visibility === 'visible',
      right: Math.round(cell.querySelector('[data-line-number-content]')?.getBoundingClientRect().right ?? -1)
    }
    return {
      deleted: read(cells.find((cell) => cell.dataset.lineType === 'change-deletion' && cell.dataset.columnNumber === '18')),
      added: read(cells.find((cell) => cell.dataset.lineType === 'change-addition' && cell.dataset.columnNumber === '18')),
      context: read(cells.find((cell) => cell.dataset.lineType === 'context' && cell.dataset.columnNumber === '17'))
    }
  })()`)
  suite.record('a unified diff shows the old and the new line number side by side',
    gutter?.deleted?.old === '"18"' && gutter.deleted.numberShown === false
      && (gutter.added?.old === '""' || gutter.added?.old === 'none') && gutter.added.numberShown === true
      && gutter.context?.old === '"17"' && gutter.context.number === '17' && gutter.context.numberShown === true
      && gutter.added.right === gutter.context.right,
    gutter)

  // ── Phase 1: a file on its own ────────────────────────────────────────────
  await palette('notes.ts')
  await cdp.waitFor(`document.querySelector('.editor-breadcrumbs')?.textContent.includes('notes') && ${singleRoot} != null`, 10_000, 16)
  await Bun.sleep(500)
  suite.record('an editable file shows no Edit button and no editing controls',
    await cdp.eval(`document.querySelector('.file-edit-start') == null && document.querySelector('.file-edit-save') == null`))
  const titleBefore = await cdp.eval(titleLeft)

  let point = await pointFor(pointOnLine(singleRoot, 10, 13))
  await suite.watch(app, 'a click in a file makes it editable with the caret where it landed',
    () => click(point), { ...ACTIVATE, done: editorFocused, check: editorFocused })
  await cdp.send('Input.insertText', { text: 'ZZ' })
  await suite.step(cdp, 'typing brings Unsaved and Save into the toolbar', async () => {}, unsavedInToolbar, { timeoutMs: 5_000 })
  const titleAfter = await cdp.eval(titleLeft)
  suite.record('the title does not move when Save appears', titleBefore != null && titleBefore === titleAfter,
    { before: titleBefore, after: titleAfter, actionsWidth: await cdp.eval(`document.querySelector('.file-edit-actions')?.scrollWidth`) })
  const notesExpected = insertAt(lines('n', 200, false), 10, 13, 'ZZ')
  await suite.watch(app, '⌘S writes the text typed where the click was', saveKey,
    { ...SAVE, done: `document.querySelector('.file-edit-save') == null`, check: `document.querySelector('.file-edit-save') == null` })
  suite.record('notes.ts on disk has the edit at the clicked column', (await onDisk('notes.ts')) === notesExpected)
  // Put back from outside, so the file stays out of the review (a changed file
  // opens there): a clean session takes the disk copy as it lands.
  await writeFile(join(fixture, 'notes.ts'), lines('n', 200, false))
  await suite.step(cdp, 'a write from outside a clean session shows the disk copy', async () => {},
    `!(${singleRoot}?.textContent.includes('ZZ') ?? true)`, { timeoutMs: 8_000 })

  // A draft outlives leaving its file, and opens straight back into it — also
  // one typed after a save, which is keyed to the saved revision.
  await click(await pointFor(pointOnLine(singleRoot, 10, 13)))
  await cdp.waitFor(editorFocused, 5_000, 16)
  await cdp.send('Input.insertText', { text: 'YY' })
  await suite.step(cdp, 'typing after a save is unsaved again', async () => {}, unsavedInToolbar, { timeoutMs: 5_000 })
  await palette('docs.md')
  await cdp.waitFor(`document.querySelector('.editor-breadcrumbs')?.textContent.includes('docs')`, 8_000, 16)
  await suite.step(cdp, 'leaving a file with a draft keeps it on the unsaved pill', async () => {},
    `[...document.querySelectorAll('.file-edit-state')].some((pill) => pill.textContent === '1 unsaved')`, { timeoutMs: 5_000 })
  await palette('notes.ts')
  await suite.step(cdp, 'coming back to the file opens its draft, unsaved', async () => {},
    `${unsavedInToolbar} && ${singleRoot}?.textContent.includes('export const YYn9')`, { timeoutMs: 8_000 })
  await suite.watch(app, 'Discard puts the disk copy back', () => press(cdp, `document.querySelector('[aria-label="Discard changes"]').click()`),
    { ...SAVE, done: `document.querySelector('.file-edit-save') == null`, check: `!${singleRoot}?.textContent.includes('YYn9')` })
  suite.record('discarding wrote nothing', (await onDisk('notes.ts')) === lines('n', 200, false))

  // Markdown beside its preview: editing keeps the split, and the preview follows.
  await palette('docs.md')
  await cdp.waitFor(`document.querySelector('.markdown-file-preview') != null && ${singleRoot} != null`, 8_000, 16)
  await Bun.sleep(300)
  await click(await pointFor(pointOnLine(singleRoot, 3, 2), 'docs:3'))
  await cdp.waitFor(editorFocused, 5_000, 16)
  await cdp.send('Input.insertText', { text: 'LIVE ' })
  await suite.step(cdp, 'the markdown preview follows the draft as it is typed', async () => {},
    `document.querySelector('.markdown-file-preview')?.textContent.includes('LIVE') === true`, { timeoutMs: 3_000 })
  await press(cdp, `document.querySelector('[aria-label="Discard changes"]').click()`)
  await cdp.waitFor(`document.querySelector('.file-edit-save') == null`, 5_000, 16)

  // ── Phase 2: inside the folder review ─────────────────────────────────────
  await palette('changed/b.ts')
  await cdp.waitFor(`${fileRow('changed/b.ts')} != null`, 10_000, 16)
  await Bun.sleep(400)
  await press(cdp, `${fileRow('changed/b.ts')}.click()`)
  await cdp.waitFor(`document.querySelector('.multi-file-code-view') != null && ${reviewRoot('changed/b.ts')} != null`, 15_000, 16)

  const bPoint = await pointFor(firstAddedLine('changed/b.ts'), 'b added line')
  point = bPoint
  await Bun.sleep(300)
  const bTop = await cdp.eval(headerTop('changed/b.ts'))
  await suite.watch(app, 'a click on a review line edits that file where it is', () => click(point),
    { ...ACTIVATE, done: editorFocusedIn('changed/b.ts'), check: `${editorFocusedIn('changed/b.ts')} && document.querySelector('.multi-file-code-view') != null` })
  const bTopAfter = await cdp.eval(headerTop('changed/b.ts'))
  suite.record('the edited file does not move on screen', bTop != null && Math.abs(bTopAfter - bTop) <= 2, { before: bTop, after: bTopAfter })
  await cdp.send('Input.insertText', { text: 'QQ' })
  await suite.step(cdp, 'the file header shows Unsaved and Save', async () => {}, unsavedInReview('changed/b.ts'), { timeoutMs: 5_000 })
  const bExpected = insertAt(lines('b', 400, true), bPoint.line, 0, 'QQ')
  await suite.watch(app, '⌘S in the review saves the file being typed in', saveKey,
    { ...SAVE, settleMs: 1_500, done: `!${unsavedInReview('changed/b.ts')}`, check: `document.querySelector('.multi-file-code-view') != null` })
  const bOnDisk = await onDisk('changed/b.ts')
  const bDiff = bOnDisk.split('\n').map((line, index) => [index + 1, line, bExpected.split('\n')[index]]).filter(([, actual, expected]) => actual !== expected).slice(0, 3)
  suite.record('b.ts on disk has the edit at the clicked column', bOnDisk === bExpected, { line: bPoint.line, differences: bDiff })

  // An old line is history: clicking it edits nothing.
  const editableIn = (path) => `(${reviewRoot(path)}?.querySelector('[contenteditable="true"]') != null)`
  await palette('changed/a.ts')
  await Bun.sleep(1_000)
  // Whichever deleted line of a is rendered: the review only draws a window.
  const deletion = await pointFor(`(() => {
    const line = ${reviewRoot('changed/a.ts')}?.querySelector('[data-content] [data-line-type="change-deletion"]')
    if (line == null) return null
    line.scrollIntoView({ block: 'center' })
    const rect = line.getBoundingClientRect()
    return { x: Math.round(rect.left + 30), y: Math.round(rect.top + rect.height / 2) }
  })()`, 'a deletion')
  await click(deletion)
  await Bun.sleep(800)
  suite.record('a click on a deleted line does not start editing', !(await cdp.eval(editableIn('changed/a.ts'))))

  // Two files unsaved at once; ⌘S saves the one with focus.
  await palette('changed/c.ts')
  await Bun.sleep(1_000)
  const cPoint = await pointFor(firstAddedLine('changed/c.ts'), 'c added line')
  point = cPoint
  await click(point)
  await cdp.waitFor(editorFocusedIn('changed/c.ts'), 5_000, 16)
  await cdp.send('Input.insertText', { text: 'C1' })
  await palette('changed/a.ts')
  await Bun.sleep(1_000)
  const aPoint = await pointFor(firstAddedLine('changed/a.ts'), 'a added line')
  point = aPoint
  await click(point)
  await cdp.waitFor(editorFocusedIn('changed/a.ts'), 5_000, 16)
  await cdp.send('Input.insertText', { text: 'A1' })
  // c has scrolled out of the render window; its draft is on the pill.
  const otherUnsaved = `[...document.querySelectorAll('.file-edit-state')].some((pill) => pill.textContent === '1 unsaved')`
  await cdp.waitFor(`${unsavedInReview('changed/a.ts')} && ${otherUnsaved}`, 5_000, 16)
  suite.record('two files can be unsaved at once', await cdp.eval(`${unsavedInReview('changed/a.ts')} && ${otherUnsaved}`))
  await saveKey()
  await cdp.waitFor(`!${unsavedInReview('changed/a.ts')}`, 5_000, 16)
  const lineOnDisk = async (path, line) => (await onDisk(path)).split('\n')[line - 1]
  suite.record('⌘S saved only the focused file', (await lineOnDisk('changed/a.ts', aPoint.line)).startsWith('A1export const a')
    && !(await onDisk('changed/c.ts')).includes('C1'))
  await palette('changed/c.ts')
  await suite.step(cdp, 'a file scrolled out of view keeps its unsaved text', async () => {},
    `${unsavedInReview('changed/c.ts')} && (${reviewRoot('changed/c.ts')}?.textContent.includes('C1') ?? false)`, { timeoutMs: 8_000 })
  await press(cdp, `${deepAll('[data-review-save]')}.find((button) => button.getAttribute('aria-label') === 'Save changed/c.ts').click()`)
  await cdp.waitFor(`!${unsavedInReview('changed/c.ts')}`, 5_000, 16)
  suite.record('the header Save saves its own file', (await lineOnDisk('changed/c.ts', cPoint.line)).startsWith('C1export const c'))

  // A write from outside under an open, untouched editor — an agent's edit —
  // shows in the review: saved through a temp file and a rename, then in place.
  for (const [marker, atomic] of [['OUTSIDE-RENAME', true], ['OUTSIDE-INPLACE', false]]) {
    const point = await pointFor(firstAddedLine('changed/c.ts'), `c line before ${marker}`)
    await click(point)
    await cdp.waitFor(editorFocusedIn('changed/c.ts'), 5_000, 16)
    await Bun.sleep(400)
    const next = (await onDisk('changed/c.ts')).replace(/^(export const c\d+ = )/m, `// ${marker}\n$1`)
    if (atomic) {
      await writeFile(join(fixture, 'changed/.c.ts.tmp'), next)
      await rename(join(fixture, 'changed/.c.ts.tmp'), join(fixture, 'changed/c.ts'))
    } else {
      await writeFile(join(fixture, 'changed/c.ts'), next)
    }
    await suite.step(cdp, `an outside write under an open editor shows in the review (${atomic ? 'rename' : 'in place'})`, async () => {},
      `${reviewRoot('changed/c.ts')}?.textContent.includes(${JSON.stringify(marker)}) ?? false`, { timeoutMs: 8_000 })
  }

  // Reading after editing is as smooth as before.
  const scroller = await cdp.eval(largestScroller('.multi-file-code-view'))
  await suite.watch(app, 'the review scrolls smoothly after editing', async () => {
    await startFrames(cdp)
    for (let fling = 0; fling < 3; fling += 1) await scrollGesture(cdp, scroller, fling % 2 === 0 ? 4_000 : -4_000, 4_000)
    const frames = await stopFrames(cdp)
    suite.record('fling frames after editing', frames.over50 <= 1, frames)
  }, { settleMs: 400, timedAction: false, rendererMs: 400, longTaskMs: 100 })

  // A commit review is history too.
  await press(cdp, `document.querySelector('.chrome-branch-button').click()`)
  await cdp.waitFor(`[...document.querySelectorAll('.git-panel-tabs [role="tab"]')].some((tab) => tab.textContent.startsWith('History'))`, 10_000, 16)
  await press(cdp, `[...document.querySelectorAll('.git-panel-tabs [role="tab"]')].find((tab) => tab.textContent.startsWith('History')).click()`)
  await cdp.waitFor(`document.querySelector('.commit-row button[aria-label^="Review commit"]') != null`, 10_000, 16)
  await press(cdp, `document.querySelector('.commit-row button[aria-label^="Review commit"]').click()`)
  await cdp.waitFor(`document.querySelector('.multi-file-code-view') != null && ${deepAll('[data-content] [data-line]')}.length > 0`, 20_000, 16)
  await Bun.sleep(800)
  const historyPoint = await pointFor(`(() => {
    const line = ${deepAll('[data-content] [data-line]')}.find((candidate) => candidate.dataset.lineType !== 'change-deletion' && candidate.textContent.length > 4)
    if (line == null) return null
    const rect = line.getBoundingClientRect()
    return { x: Math.round(rect.left + 12), y: Math.round(rect.top + rect.height / 2) }
  })()`)
  await click(historyPoint)
  await Bun.sleep(600)
  suite.record('a commit review is not editable', !(await cdp.eval(editorFocused)))

  // A theme that writes its colors as `color(display-p3 …)` — the vibrant ones.
  // The editor re-colors a line as it is typed in, and read those colors off a
  // table that holds only hex: every token of an edited line drew in #00000001,
  // and the line looked deleted.
  await cdp.eval(`(() => {
    const key = 'kodi:preferences:v1'
    const current = JSON.parse(localStorage.getItem(key) ?? '{}')
    localStorage.setItem(key, JSON.stringify({ ...current, editorTheme: 'pierre-dark-vibrant' }))
    location.reload()
  })()`).catch(() => {})
  await cdp.waitFor(`${fileRow('notes.ts')} != null`, 30_000, 16)
  await Bun.sleep(1_000)
  await palette('notes.ts')
  await cdp.waitFor(`document.querySelector('.editor-breadcrumbs')?.textContent.includes('notes') && ${singleRoot} != null`, 10_000, 16)
  await Bun.sleep(500)
  await click(await pointFor(pointOnLine(singleRoot, 12, 13), 'vibrant:12'))
  await cdp.waitFor(editorFocused, 5_000, 16)
  await cdp.send('Input.insertText', { text: 'V' })
  await Bun.sleep(400)
  const inkOnEditedLine = await cdp.eval(`(() => {
    const line = ${singleRoot}?.querySelector('[data-content] [data-line="12"]')
    if (line == null) return null
    const alpha = (color) => {
      const slash = /\\/\\s*([\\d.]+%?)\\s*\\)$/.exec(color)
      const rgba = /^rgba\\([^)]*,\\s*([\\d.]+)\\)$/.exec(color)
      const value = slash?.[1] ?? rgba?.[1]
      if (value == null) return 1
      return value.endsWith('%') ? Number(value.slice(0, -1)) / 100 : Number(value)
    }
    const spans = [...line.querySelectorAll('span')].filter((span) => span.textContent.trim() !== '')
    return { text: line.textContent, faintest: Math.min(...spans.map((span) => alpha(getComputedStyle(span).color))) }
  })()`)
  suite.record('an edited line in a display-p3 theme is still drawn', inkOnEditedLine != null
    && inkOnEditedLine.text.includes('V') && inkOnEditedLine.faintest > 0.5, inkOnEditedLine)

  // The editor's selection bar is the review's: three icons. Add to Chat takes
  // the lines the selection covers — line 12, where the caret is.
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 8, commands: ['moveToEndOfLineAndModifySelection'] })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 8 })
  const bar = `${deepAll('[data-selection-action]')}[0]`
  await cdp.waitFor(`${bar} != null`, 3_000, 16)
  suite.record('the editor selection bar is three icon buttons', await cdp.eval(`(() => {
    const buttons = [...(${bar}?.querySelectorAll('button') ?? [])]
    return buttons.length === 3 && buttons.every((button) => button.querySelector('svg') != null && button.textContent.trim() === '')
  })()`))
  await press(cdp, `${bar}.querySelector('button[aria-label="Add selection to Chat"]').click()`)
  const chip = `[...document.querySelectorAll('.agent-dock *')].some((element) => element.children.length === 0 && element.textContent.trim() === 'notes.ts:12')`
  const attached = await cdp.waitFor(chip, 5_000, 16)
  suite.record('Add to Chat references the selected line', !attached.timedOut)

  const banner = await cdp.tryEval(`document.querySelector('.error-banner')?.textContent ?? null`)
  suite.record('no error banner', banner == null, { banner })
  suite.record('memory at end', true, await app.memory())
})
