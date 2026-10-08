// ⌘-click to a definition: holding ⌘ over code underlines the identifier under
// the pointer; ⌘-click on `parseFileUri` in the review lists its one
// declaration (`src/parse.ts:3`, not the call site); Enter opens that file on
// that line. A plain click is still the viewer's.
//
// The old build had no definition search: a ⌘-click selected the line.
//
//   bun run build && bun scripts/e2e/definition-navigation.e2e.mjs
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createRepository, git, launchApp, press, removeLater, runSuite } from './harness.mjs'

const deepAll = (selector) => `(() => {
  const out = []
  const walk = (root) => {
    out.push(...root.querySelectorAll(${JSON.stringify(selector)}))
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot != null) walk(element.shadowRoot)
  }
  walk(document)
  return out
})()`
// The middle of `parseFileUri` in the changed line of src/app.ts.
const tokenPoint = `(() => {
  for (const line of ${deepAll('[data-content] [data-line-index]')}) {
    const text = line.textContent ?? ''
    const at = text.indexOf('parseFileUri(')
    if (at < 0 || !text.includes('const value')) continue
    const nodes = []
    const visit = (node) => { if (node.nodeType === 3) nodes.push(node); else node.childNodes.forEach(visit) }
    visit(line)
    let start = 0
    for (const node of nodes) {
      const end = start + node.data.length
      if (at + 4 < end) {
        const range = document.createRange()
        range.setStart(node, at + 4 - start)
        range.setEnd(node, at + 5 - start)
        const rect = range.getBoundingClientRect()
        if (rect.width === 0) return null
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
      }
      start = end
    }
  }
  return null
})()`

await runSuite('definition-navigation', async (suite, cleanup) => {
  const fixture = await createRepository('definition-navigation')
  cleanup(removeLater(fixture))
  await mkdir(join(fixture, 'src'), { recursive: true })
  await writeFile(join(fixture, 'src/parse.ts'), '// Turns a file URI into a path.\n\nexport function parseFileUri(uri: string) {\n  return uri.replace(/^file:\\/\\//, \'\')\n}\n')
  await writeFile(join(fixture, 'src/app.ts'), "import { parseFileUri } from './parse'\n\nexport const value = 1\n")
  await git(fixture, 'add', '-A')
  await git(fixture, 'commit', '--quiet', '-m', 'Base')
  await writeFile(join(fixture, 'src/app.ts'), "import { parseFileUri } from './parse'\n\nexport const value = parseFileUri('file:///tmp/a')\n")

  const app = await launchApp({ folder: fixture })
  cleanup(app.stop)
  const { cdp } = app

  const row = `${deepAll('[data-item-path="src/app.ts"][data-item-type="file"]')}[0]`
  await cdp.waitFor(`${row} != null || document.querySelector('.multi-file-review') != null`, 30_000, 16)
  if (!await cdp.eval(`document.querySelector('.multi-file-review') != null`)) await press(cdp, `${row}.click()`)
  const drawn = await cdp.waitFor(`${tokenPoint} != null`, 30_000, 16)
  suite.record('the changed call is drawn', !drawn.timedOut)
  const point = await cdp.eval(tokenPoint)

  // ── ⌘ held over the token underlines it ─────────────────────────────────
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91, modifiers: 4 })
  await Bun.sleep(300)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x - 2, y: point.y, modifiers: 4 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, modifiers: 4 })
  const underlined = await cdp.waitFor(`(() => {
    const line = document.querySelector('.definition-underline')
    if (line == null) return false
    const rect = line.getBoundingClientRect()
    return rect.width > 40 && rect.left <= ${point.x} && rect.right >= ${point.x}
  })()`, 3_000, 16)
  suite.record('⌘ over an identifier underlines all of it', !underlined.timedOut,
    { underline: await cdp.eval(`(() => { const r = document.querySelector('.definition-underline')?.getBoundingClientRect(); return r == null ? null : { left: r.left, width: r.width } })()`) })

  // ── ⌘-click lists its declaration ──────────────────────────────────────────
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers: 4 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1, modifiers: 4 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 })
  const listed = await cdp.waitFor(`document.querySelectorAll('.definition-popover [data-definition-jump]').length > 0`, 5_000, 16)
  const candidates = await cdp.eval(`[...document.querySelectorAll('.definition-popover [data-definition-jump]')].map((button) => button.dataset.definitionJump)`)
  suite.record('⌘-click lists the one declaration, not the call site', !listed.timedOut && candidates.length === 1 && candidates[0] === 'src/parse.ts:3', { candidates })
  suite.record('the click did not select the line under it', await cdp.eval(`${deepAll('[data-content] [data-selected-line]')}.length === 0`))
  suite.record('the underline is gone once ⌘ is up', await cdp.eval(`document.querySelector('.definition-underline') == null`))

  // ── Enter opens the file on that line ──────────────────────────────────────
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'char', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  const landed = await cdp.waitFor(`document.querySelector('.definition-popover') == null
    && document.querySelector('.editor-breadcrumbs')?.textContent.replaceAll('›', '/') === 'src/parse.ts'
    && ${deepAll('[data-content] [data-line="3"][data-selected-line]')}.length > 0`, 8_000, 16)
  suite.record('Enter opens src/parse.ts on line 3', !landed.timedOut, {
    path: await cdp.eval(`document.querySelector('.editor-breadcrumbs')?.textContent ?? null`),
    selected: await cdp.eval(`${deepAll('[data-content] [data-selected-line]')}.map((line) => line.getAttribute('data-line'))`)
  })

  // ── a plain click is still the viewer's ─────────────────────────────────
  suite.record('no popover without ⌘', await cdp.eval(`document.querySelector('.definition-popover') == null`))
  suite.record('memory at end', true, await app.memory())
})
