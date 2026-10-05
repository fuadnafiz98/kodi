// The agent dock with a scripted agent: an answer reads as formatted
// markdown, a new chat keeps the one before it, and the list survives a restart.
//
//   bun run build && bun run e2e agent-chat
//
// The agent is replaced in the main process (its IPC handlers), so no CLI or
// sign-in is needed; what reaches the renderer is the same stream of events.
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRepository, git, launchApp, removeLater, runSuite } from './harness.mjs'

const QUESTION = 'Is [1] safe?'
const LONG_LINE = 'def parse_file_uri(*, file_uri: str, etl_configs: dict) -> tuple[str, str]: return tenant_part, full_blob_path'
const ANSWER = [
  'I checked the patch and traced `parse_file_uri`.',
  '',
  '## Review: is `[1]` safe?',
  '',
  '**Yes, `[1]` is safe.** Here is why:',
  '',
  '```python',
  LONG_LINE,
  '```',
  '',
  '| Input | Matched |',
  '|---|--:|',
  '| consists of 2 phases | `2 phases` |',
  '| \\|Ni phase\\| | 3 |',
  '',
  ...Array.from({ length: 30 }, (_unused, index) => `- Point ${index + 1} about the tuple`),
  ''
].join('\n')

// Signed in, and every question answered from a queue: a session event, the
// text, done. Asks are kept so a check can read what the renderer sent.
async function installFakeAgent({ main }) {
  const result = await main.send('Runtime.evaluate', {
    includeCommandLineAPI: true,
    returnByValue: true,
    expression: `(() => {
      const { ipcMain } = require('electron')
      globalThis.__e2eAsks = []
      globalThis.__e2eCancels = []
      globalThis.__e2eTimers = new Map()
      globalThis.__e2eAnswers = [${JSON.stringify(ANSWER)}, 'Follow-up answer.']
      const status = (provider, label) => ({ provider, installed: true, authenticated: true, label, detail: '' })
      ipcMain.removeHandler('agent:get-statuses')
      ipcMain.handle('agent:get-statuses', () => ({ claude: status('claude', 'Claude Code'), codex: status('codex', 'Codex') }))
      ipcMain.removeHandler('agent:ask')
      ipcMain.handle('agent:ask', (event, request) => {
        globalThis.__e2eAsks.push({ resumeSessionId: request.resumeSessionId ?? null, selections: request.selections.length })
        const count = globalThis.__e2eAsks.length
        const next = globalThis.__e2eAnswers.shift() ?? 'ok'
        // An answer is its text, or { text, chunkMs } for one slow enough to leave mid-stream.
        const answer = typeof next === 'string' ? next : next.text
        const chunkMs = typeof next === 'string' ? 25 : next.chunkMs
        const timers = []
        globalThis.__e2eTimers.set(request.id, timers)
        const later = (ms, run) => timers.push(setTimeout(run, ms))
        const send = (agentEvent) => { if (!event.sender.isDestroyed()) event.sender.send('agent:event', { id: request.id, ...agentEvent }) }
        later(60, () => {
          send({ kind: 'session', sessionId: 'session-' + count })
          const chunks = answer.match(/[\\s\\S]{1,80}/g) ?? ['']
          chunks.forEach((text, index) => later(index * chunkMs, () => send({ kind: 'text', text })))
          later(chunks.length * chunkMs + 50, () => send({ kind: 'done' }))
        })
      })
      // A cancelled run stops, as the CLI does.
      ipcMain.removeHandler('agent:cancel')
      ipcMain.handle('agent:cancel', (_event, id) => {
        globalThis.__e2eCancels.push(id)
        for (const timer of globalThis.__e2eTimers.get(id) ?? []) clearTimeout(timer)
      })
      return 'ok'
    })()`
  })
  if (result.result?.value !== 'ok') throw new Error(`Could not install the fake agent: ${JSON.stringify(result)}`)
}

const composer = `document.querySelector('.agent-dock textarea')`
const transcriptText = `(document.querySelector('.agent-dock-transcript')?.textContent ?? '')`

await runSuite('agent-chat', async (suite, cleanup) => {
  const fixture = await createRepository('agent-chat')
  await writeFile(join(fixture, 'blob.py'), 'def parse_file_uri():\n    return "a", "b"\n')
  await git(fixture, 'add', '-A')
  await git(fixture, 'commit', '--quiet', '-m', 'Base')
  const profile = await mkdtemp(join(tmpdir(), 'kodi-e2e-agent-profile-'))
  cleanup(removeLater(profile))

  const openDock = async (cdp) => {
    await cdp.waitFor(`document.querySelector('.agent-titlebar-button') != null`, 30_000, 16)
    await cdp.eval(`document.querySelector('.agent-titlebar-button').click()`)
    await cdp.waitFor(`${composer} != null && !${composer}.disabled && document.querySelector('.agent-header-state.connected') != null`, 10_000, 16)
  }
  const ask = async (cdp, text) => {
    await cdp.eval(`${composer}.focus()`)
    await cdp.send('Input.insertText', { text })
    await cdp.eval(`document.querySelector('.agent-dock button[aria-label="Send message"]').click()`)
  }
  const answered = `document.querySelector('.agent-dock .agent-answer-actions') != null && document.querySelector('.agent-header-state.running') == null`

  const first = await launchApp({ folder: fixture, profile })
  cleanup(first.stop)
  await installFakeAgent(first)
  await openDock(first.cdp)
  await ask(first.cdp, QUESTION)
  const done = await first.cdp.waitFor(answered, 10_000, 16)
  suite.record('a scripted answer arrives', !done.timedOut)
  await Bun.sleep(400)

  const layout = await first.cdp.eval(`(() => {
    const answer = [...document.querySelectorAll('.agent-dock .agent-answer')].at(-1)
    if (answer == null) return null
    const heading = answer.querySelector('h1, h2, h3, h4, h5, h6')
    const strong = answer.querySelector('strong')
    const pre = answer.querySelector('pre')
    const label = pre?.querySelector('.agent-code-language')
    const code = pre?.querySelector('code')
    const transcript = document.querySelector('.agent-dock-transcript')
    const copy = document.querySelector('.agent-dock .agent-answer-actions button')
    const rect = (element) => element?.getBoundingClientRect()
    const before = heading?.previousElementSibling
    return {
      heading: heading?.textContent ?? null,
      headingCode: heading?.querySelector('code')?.textContent ?? null,
      headingGap: heading == null || before == null ? null : Math.round(rect(heading).top - rect(before).bottom),
      strongCode: strong?.querySelector('code')?.textContent ?? null,
      strongText: strong?.textContent ?? null,
      labelBottom: rect(label)?.bottom ?? null,
      codeTop: rect(code)?.top ?? null,
      codeScrolls: pre == null ? null : pre.scrollWidth > pre.clientWidth || (code != null && code.scrollWidth > code.clientWidth),
      scrollbarHeight: pre == null ? null : pre.offsetHeight - pre.clientHeight - 2,
      scrollbarStyle: pre == null ? null : getComputedStyle(pre).scrollbarWidth + '/' + getComputedStyle(pre).scrollbarColor,
      copyBottom: rect(copy)?.bottom ?? null,
      transcriptBottom: rect(transcript)?.bottom ?? null,
      items: answer.querySelectorAll('li').length,
      table: (() => {
        const table = answer.querySelector('.agent-table-scroll > table')
        if (table == null) return null
        return {
          header: [...table.querySelectorAll('thead th')].map((cell) => cell.textContent),
          rows: [...table.querySelectorAll('tbody tr')].map((row) => [...row.children].map((cell) => cell.textContent)),
          code: table.querySelector('tbody code')?.textContent ?? null,
          rightAligned: getComputedStyle(table.querySelector('tbody td:nth-child(2)')).textAlign
        }
      })()
    }
  })()`)
  suite.record('a heading after text is a heading, code in it included',
    layout?.heading === 'Review: is [1] safe?' && layout.headingCode === '[1]', layout)
  suite.record('code inside bold is code, no stray backticks',
    layout?.strongCode === '[1]' && !layout.strongText.includes('`'), layout)
  suite.record('a markdown table is a table, escaped pipes and code intact',
    JSON.stringify(layout?.table?.header) === '["Input","Matched"]'
      && JSON.stringify(layout.table.rows) === '[["consists of 2 phases","2 phases"],["|Ni phase|","3"]]'
      && layout.table.code === '2 phases' && layout.table.rightAligned === 'right', layout?.table)
  suite.record('a heading has room above it', (layout?.headingGap ?? 0) >= 12, layout)
  suite.record('the code block label sits clear of the code',
    layout?.labelBottom != null && layout.codeTop != null && layout.labelBottom <= layout.codeTop + 0.5, layout)
  suite.record('a long code line scrolls on a thin bar', layout?.codeScrolls === true && (layout.scrollbarHeight ?? 99) <= 6, layout)
  suite.record('Copy answer is on screen once the answer ends',
    layout?.copyBottom != null && layout.copyBottom <= layout.transcriptBottom + 0.5, layout)

  // A new chat keeps the one before it.
  await first.cdp.eval(`document.querySelector('.agent-dock button[aria-label="New conversation"]').click()`)
  await first.cdp.waitFor(`!${transcriptText}.includes(${JSON.stringify(QUESTION)})`, 5_000, 16)
  await first.cdp.eval(`document.querySelector('.agent-dock button[aria-label="Chats"]')?.click()`)
  const listed = await first.cdp.waitFor(`[...document.querySelectorAll('.agent-chat-popover .agent-chat-open')].some((row) => row.textContent.includes(${JSON.stringify(QUESTION)}))`, 5_000, 16)
  suite.record('New conversation keeps the previous chat in the list', !listed.timedOut)
  await first.cdp.eval(`[...document.querySelectorAll('.agent-chat-popover .agent-chat-open')].find((row) => row.textContent.includes(${JSON.stringify(QUESTION)}))?.click()`)
  const reopened = await first.cdp.waitFor(`${transcriptText}.includes(${JSON.stringify(QUESTION)}) && ${transcriptText}.includes('Point 30 about the tuple')`, 5_000, 16)
  suite.record('opening a chat shows its question and answer', !reopened.timedOut)
  await ask(first.cdp, 'And [0]?')
  await first.cdp.waitFor(`${transcriptText}.includes('Follow-up answer.') && ${answered}`, 10_000, 16)
  const asks = await first.main.send('Runtime.evaluate', { returnByValue: true, expression: 'globalThis.__e2eAsks' })
  suite.record('a follow-up in a reopened chat continues its session',
    asks.result?.value?.[1]?.resumeSessionId === 'session-1', { asks: asks.result?.value })
  // Past the chat list's own write delay, well inside Chromium's: the quit
  // has to flush localStorage for the restart to find it.
  await Bun.sleep(1_000)
  await first.stop()

  // …and a restart keeps the list.
  const second = await launchApp({ folder: fixture, profile })
  cleanup(second.stop)
  await installFakeAgent(second)
  await openDock(second.cdp)
  await second.cdp.waitFor(`document.querySelector('.agent-dock button[aria-label="Chats"]') != null`, 5_000, 16)
  await second.cdp.eval(`document.querySelector('.agent-dock button[aria-label="Chats"]')?.click()`)
  const restored = await second.cdp.waitFor(`[...document.querySelectorAll('.agent-chat-popover .agent-chat-open')].some((row) => row.textContent.includes(${JSON.stringify(QUESTION)}) && row.textContent.includes('2 questions'))`, 5_000, 16)
  suite.record('chats survive a restart', !restored.timedOut,
    {
      rows: await second.cdp.eval(`[...document.querySelectorAll('.agent-chat-popover .agent-chat-open')].map((row) => row.textContent)`),
      stored: await second.cdp.eval(`(() => { try { return localStorage.getItem('kodi:agent-chats:v1')?.length ?? null } catch { return 'error' } })()`),
      button: await second.cdp.eval(`document.querySelector('.agent-dock button[aria-label="Chats"]') != null`)
    })
  await second.cdp.eval(`document.querySelector('.agent-chat-popover')?.close?.()`)
  await second.cdp.eval(`document.querySelector('.agent-dock button[aria-label="Chats"]')?.click()`)

  // A selection sent with a question stays on the question: its file and line.
  const { cdp } = second
  await cdp.combo('k', 'KeyK', 75, 4)
  await cdp.waitFor(`document.activeElement === document.querySelector('#command-palette-input')`, 8_000, 4)
  await cdp.send('Input.insertText', { text: 'blob.py' })
  await cdp.waitFor(`[...document.querySelectorAll('.command-palette-results button')].some((row) => row.textContent.includes('blob.py'))`, 8_000, 8)
  await cdp.enter()
  const lineStart = `(() => {
    const walk = (root) => {
      const line = root.querySelector('[data-content] [data-line="1"]')
      if (line != null) return line
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot == null) continue
        const found = walk(element.shadowRoot)
        if (found != null) return found
      }
      return null
    }
    const line = walk(document)
    const text = line == null ? null : document.createTreeWalker(line, NodeFilter.SHOW_TEXT).nextNode()
    if (text == null) return null
    const range = document.createRange()
    range.setStart(text, 0)
    range.setEnd(text, 1)
    const rect = range.getBoundingClientRect()
    return rect.width === 0 ? null : { x: Math.round(rect.left + 1), y: Math.round(rect.top + rect.height / 2) }
  })()`
  await cdp.waitFor(`${lineStart} != null`, 10_000, 16)
  await Bun.sleep(500)
  const point = await cdp.eval(lineStart)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  await Bun.sleep(300)
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 8, commands: ['moveToEndOfLineAndModifySelection'] })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 8 })
  const addToChat = `(() => {
    const walk = (root) => {
      const button = root.querySelector('[data-selection-action] button[aria-label="Add selection to Chat"]')
      if (button != null) return button
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot == null) continue
        const found = walk(element.shadowRoot)
        if (found != null) return found
      }
      return null
    }
    return walk(document)
  })()`
  await cdp.waitFor(`${addToChat} != null`, 5_000, 16)
  await cdp.eval(`${addToChat}.click()`)
  await cdp.waitFor(`document.querySelector('.agent-dock .agent-attachment') != null`, 5_000, 16)
  await second.main.send('Runtime.evaluate', { expression: `globalThis.__e2eAnswers = [{ text: ${JSON.stringify('Slow answer. '.repeat(20) + 'END-OF-SLOW')}, chunkMs: 150 }]` })
  // A fresh chat, so the reference is the current question's own.
  await cdp.eval(`document.querySelector('.agent-dock button[aria-label="New conversation"]')?.click()`)
  await ask(cdp, 'What does it return?')
  const referenced = await cdp.waitFor(`[...document.querySelectorAll('.agent-dock .agent-turn.current .agent-question-references code')].some((code) => code.textContent === 'blob.py:1')`, 5_000, 16)
  const sent = await second.main.send('Runtime.evaluate', { returnByValue: true, expression: 'globalThis.__e2eAsks.at(-1)' })
  suite.record('a sent question keeps the file and line it was asked about', !referenced.timedOut && sent.result?.value?.selections === 1,
    { ask: sent.result?.value, chips: await cdp.eval(`[...document.querySelectorAll('.agent-dock .agent-question-references code')].map((code) => code.textContent)`) })

  // A new chat leaves the one being answered running; it finishes in the list.
  await cdp.waitFor(`${transcriptText}.includes('Slow answer.')`, 5_000, 16)
  await cdp.eval(`document.querySelector('.agent-dock button[aria-label="New conversation"]').click()`)
  await Bun.sleep(300)
  await cdp.eval(`document.querySelector('.agent-dock button[aria-label="Chats"]')?.click()`)
  const answering = await cdp.waitFor(`[...document.querySelectorAll('.agent-chat-popover .agent-chat-open')].some((row) => row.textContent.includes('What does it return?') && row.textContent.includes('Answering'))`, 3_000, 16)
  const cancels = await second.main.send('Runtime.evaluate', { returnByValue: true, expression: 'globalThis.__e2eCancels.length' })
  suite.record('New conversation leaves the running chat answering', !answering.timedOut && cancels.result?.value === 0,
    { cancels: cancels.result?.value, rows: await cdp.eval(`[...document.querySelectorAll('.agent-chat-popover .agent-chat-open')].map((row) => row.textContent)`) })
  await cdp.waitFor(`![...document.querySelectorAll('.agent-chat-popover .agent-chat-open')].some((row) => row.textContent.includes('Answering'))`, 10_000, 50)
  await cdp.eval(`[...document.querySelectorAll('.agent-chat-popover .agent-chat-open')].find((row) => row.textContent.includes('What does it return?'))?.click()`)
  const finished = await cdp.waitFor(`${transcriptText}.includes('END-OF-SLOW') && [...document.querySelectorAll('.agent-dock .agent-question-references code')].some((code) => code.textContent === 'blob.py:1')`, 5_000, 16)
  suite.record('the chat left mid-answer finished in the background, reference included', !finished.timedOut,
    { text: (await cdp.eval(transcriptText)).slice(-120) })
})
