// Cycles every selectable editor theme in the installed app and captures a
// PNG of the restored workspace for each, plus the computed-theme facts a
// screenshot alone cannot settle (shell vars, diff background, a token color).
//
//   KODI_PROBE_HIDDEN=1 bun scripts/perf/theme-screenshots.mjs
//   OUT=/tmp/shots WIDTH=1600 bun scripts/perf/theme-screenshots.mjs
//   OPEN_REPO=kodi bun scripts/perf/theme-screenshots.mjs   # review surface
//   MODE=live bun scripts/perf/theme-screenshots.mjs        # click theme
//      cards in Settings instead of reloading — catches state a reload hides
//
// The hidden window has a zero-size viewport, so an Emulation override gives
// the page a real frame to paint into before Page.captureScreenshot asks for
// it. Theme switches are written to the preferences store followed by a
// reload — the same path Settings takes, minus the UI.
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { guardExit, launch, quit, settle } from './cdp.mjs'

const OUT = process.env.OUT ?? '/tmp/kodi-theme-shots'
const WIDTH = Number(process.env.WIDTH ?? '1440')
const HEIGHT = Number(process.env.HEIGHT ?? '900')
const SCALE = Number(process.env.SCALE ?? '2')
const PORT = Number(process.env.PORT ?? '9461')
// The worker re-tokenizes after the shell paints; this delay covers the
// re-render so tokens land in the shot with the theme's own colors.
const PAINT_SETTLE_MS = Number(process.env.PAINT_SETTLE_MS ?? '1500')
// OPEN_REPO=<name in the folder picker> opens that repository first, so the
// shots cover the review surface (changed-files list + multi-file diff) rather
// than whatever the last session happened to restore.
const OPEN_REPO = process.env.OPEN_REPO ?? ''
// MODE=live switches themes through the Settings UI (no reload), which is the
// only path that can expose state left over from the previous theme.
const MODE = process.env.MODE ?? 'reload'

const THEMES = [
  'pierre-dark', 'pierre-dark-soft', 'pierre-dark-vibrant',
  'github-dark', 'github-dark-dimmed', 'vitesse-dark',
  'tokyo-night', 'catppuccin-mocha', 'nord',
  'pierre-light', 'pierre-light-soft', 'github-light',
  'vitesse-light', 'light-plus', 'solarized-light', 'catppuccin-latte'
]

const SET_THEME = (theme) => `(() => {
  const key = 'kodi:preferences:v1'
  const prefs = JSON.parse(localStorage.getItem(key) ?? '{}')
  prefs.editorTheme = ${JSON.stringify(theme)}
  localStorage.setItem(key, JSON.stringify(prefs))
  return prefs.editorTheme
})()`

const READBACK = `(() => {
  const shell = document.querySelector('.app-shell')
  if (shell == null) return null
  const style = getComputedStyle(shell)
  const diff = document.querySelector('.pierre-diff, .multi-file-code-view')
  const token = diff?.querySelector('span[style*="color"]') ?? null
  const stored = JSON.parse(localStorage.getItem('kodi:preferences:v1') ?? '{}')
  // The sidebar pane is painted inside the tree's shadow root from --trees-bg;
  // the host's own computed bg is not the painted surface.
  const tree = document.querySelector('.project-tree')
  let treePaneBg = null
  if (tree?.shadowRoot != null) {
    for (const node of tree.shadowRoot.querySelectorAll('*')) {
      const bg = getComputedStyle(node).backgroundColor
      if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') { treePaneBg = bg; break }
    }
  }
  return {
    themeType: shell.dataset.themeType ?? null,
    storedTheme: stored.editorTheme ?? null,
    canvas: style.getPropertyValue('--canvas').trim(),
    accent: style.getPropertyValue('--accent').trim(),
    text: style.getPropertyValue('--text').trim(),
    shellBg: style.backgroundColor,
    sidebarBg: getComputedStyle(document.querySelector('.sidebar') ?? shell).backgroundColor,
    treePaneBg,
    diffBg: diff == null ? null : getComputedStyle(diff).backgroundColor,
    tokenColor: token == null ? null : getComputedStyle(token).color,
    review: document.querySelector('.multi-file-review') != null,
    codeViews: document.querySelectorAll('.multi-file-code-view').length,
    diffPresent: diff != null
  }
})()`

async function openRepository(cdp, name) {
  await cdp.combo('o', 'KeyO', 79)
  const pickerReady = await cdp.waitFor(
    `document.querySelectorAll('.folder-picker-results button').length > 0`,
    8_000, 10
  )
  if (pickerReady.timedOut) throw new Error('Folder picker never opened.')
  const clicked = await cdp.eval(`(() => {
    const buttons = [...document.querySelectorAll('.folder-picker-results button')]
    const target = buttons.find((button) => button.textContent.includes(${JSON.stringify(name)}))
    if (target == null) return null
    target.click()
    return true
  })()`)
  if (clicked !== true) throw new Error(`No folder-picker row matched "${name}".`)
  const review = await cdp.waitFor(
    `document.querySelector('.multi-file-review .multi-file-code-view') != null`,
    30_000, 25
  )
  if (review.timedOut) throw new Error('Review surface never rendered.')
}

async function waitForWorkspace(cdp) {
  await settle(cdp)
  if (OPEN_REPO === '') return
  // Session restore replays the persisted workspaceView, so the review surface
  // comes back on its own; it just takes longer than the explorer.
  await cdp.waitFor(
    `document.querySelector('.multi-file-review .multi-file-code-view') != null
      || document.querySelector('#repository-diff .pierre-diff') != null`,
    30_000, 25
  )
}

/** ⌘, opens Settings; a theme-card click is the exact user path. */
async function switchLive(cdp, theme) {
  await cdp.combo(',', 'Comma', 188)
  const open = await cdp.waitFor(
    `document.querySelector('.theme-card[data-theme=${JSON.stringify(theme)}]') != null`,
    8_000, 10
  )
  if (open.timedOut) throw new Error('Settings never opened.')
  await cdp.eval(`document.querySelector('.theme-card[data-theme=${JSON.stringify(theme)}]').click()`)
  await cdp.escape()
  const closed = await cdp.waitFor(`document.querySelector('.settings-page') == null`, 8_000, 10)
  if (closed.timedOut) throw new Error('Settings never closed.')
}

guardExit()
await mkdir(OUT, { recursive: true })

const { cdp } = await launch(PORT)
try {
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false
  })
  await settle(cdp)
  if (OPEN_REPO !== '') await openRepository(cdp, OPEN_REPO)
  for (const theme of THEMES) {
    if (MODE === 'live') {
      await switchLive(cdp, theme)
    } else {
      await cdp.eval(SET_THEME(theme))
      await cdp.send('Page.reload')
      await waitForWorkspace(cdp)
    }
    await Bun.sleep(PAINT_SETTLE_MS)
    const facts = await cdp.tryEval(READBACK)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const file = resolve(OUT, `${theme}.png`)
    await writeFile(file, Buffer.from(shot.data, 'base64'))
    console.log(JSON.stringify({ theme, file, ...facts }))
  }
} finally {
  await quit()
}
