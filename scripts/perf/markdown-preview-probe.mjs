// One-shot CDP check for the multi-file review markdown preview toggle.
// Hidden launch, click a markdown file in the explorer, toggle preview on/off,
// verify aria-pressed + rendered content + the P shortcut.
import { writeFile } from 'node:fs/promises'
import { CDP, connect, guardExit, launch, quit, settle, waitForPage } from './cdp.mjs'

const PORT = 9333

guardExit()

try {
  const { cdp } = await launch(PORT)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false
  })
  await settle(cdp)
  console.log('settled')

  // Find a markdown row in the explorer tree.
  const rows = await cdp.eval(`[...document.querySelectorAll('[data-item-type="file"]')]
    .map((row) => row.getAttribute('data-item-path'))`)
  console.log('tree rows:', JSON.stringify(rows))
  const markdownPath = (rows ?? []).find((path) => /\.(md|mdx|markdown)$/i.test(path))
  console.log('markdown row:', markdownPath)

  // Click the row → should enter the multi-file review with that file visible.
  await cdp.eval(`(() => {
    const row = document.querySelector('[data-item-path="${markdownPath}"][data-item-type="file"]')
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    return row != null
  })()`)

  const review = await cdp.waitFor(`document.querySelector('[data-review-markdown-toggle]') != null`, 15000)
  console.log('review toggle visible:', !review.timedOut)

  const state0 = await cdp.eval(`(() => {
    const button = document.querySelector('[data-review-markdown-toggle]')
    return { pressed: button?.getAttribute('aria-pressed'), label: button?.getAttribute('aria-label') }
  })()`)
  console.log('initial toggle state:', JSON.stringify(state0))

  // Toggle preview on — the markdown pipeline is lazy, wait for real elements.
  await cdp.eval(`document.querySelector('[data-review-markdown-toggle]')?.click()`)
  const preview = await cdp.waitFor(`document.querySelector('.markdown-review-body')?.textContent?.length > 20`, 15000)
  console.log('preview rendered:', !preview.timedOut)
  // The <pre> fallback holds the space while the renderer chunk loads — wait
  // for real element output, not the fallback itself.
  const rich = await cdp.waitFor(
    `document.querySelector('.markdown-review-body .gh-markdown h1, .markdown-review-body .gh-markdown h2, .markdown-review-body .gh-markdown ul') != null`,
    15000)
  console.log('real markdown rendered:', !rich.timedOut)
  // Watch the preview + header for flapping over 6s (500ms polls).
  for (let i = 0; i < 12; i++) {
    console.log(`t+${(i * 0.5).toFixed(1)}s`, JSON.stringify(await cdp.eval(`(() => ({
      previews: document.querySelectorAll('.markdown-review-preview').length,
      bodyChars: document.querySelector('.markdown-review-body')?.textContent?.length ?? 0,
      h1: document.querySelector('.markdown-review-body h1') != null,
      toggles: [...document.querySelectorAll('[data-review-markdown-toggle]')].map((b) => b.getAttribute('aria-label')?.slice(0, 60)),
      headers: document.querySelectorAll('[data-review-collapse-button]').length
    }))()`)))
    await Bun.sleep(500)
  }
  const previewList = await cdp.eval(`[...document.querySelectorAll('[data-review-markdown-toggle]')]
    .map((b) => b.getAttribute('aria-label'))`)
  console.log('markdown toggles in review:', JSON.stringify(previewList))

  const previewState = await cdp.eval(`(() => {
    const button = document.querySelector('[data-review-markdown-toggle]')
    const body = document.querySelector('.markdown-review-body')
    return {
      pressed: button?.getAttribute('aria-pressed'),
      partial: document.querySelector('.markdown-review-partial')?.textContent ?? null,
      headings: body?.querySelectorAll('h1,h2,h3').length ?? 0,
      lists: body?.querySelectorAll('ul,ol').length ?? 0,
      code: body?.querySelectorAll('pre,code').length ?? 0,
      chars: body?.textContent?.length ?? 0,
      html: body?.querySelector('h1,h2')?.outerHTML?.slice(0, 140) ?? body?.innerHTML?.slice(0, 140)
    }
  })()`)
  console.log('preview state:', JSON.stringify(previewState))

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile('/tmp/kodi-markdown-preview.png', Buffer.from(shot.data, 'base64'))
  console.log('screenshot: /tmp/kodi-markdown-preview.png')

  // P shortcut toggles back to the diff.
  await cdp.key('keyDown', 'p', 'KeyP', 80, 0)
  await cdp.key('keyUp', 'p', 'KeyP', 80, 0)
  const backToDiff = await cdp.waitFor(
    `document.querySelector('[data-review-markdown-toggle]')?.getAttribute('aria-pressed') === 'false'`, 8000)
  console.log('P toggled back to diff:', !backToDiff.timedOut)
  console.log('after first P:', JSON.stringify(await cdp.eval(`(() => {
    const button = document.querySelector('[data-review-markdown-toggle]')
    const file = button?.closest('[data-path], [data-item-path], [id]')
    return {
      state: button?.getAttribute('data-state'),
      pressed: button?.getAttribute('aria-pressed'),
      toggleCount: document.querySelectorAll('[data-review-markdown-toggle]').length,
      focused: document.activeElement?.tagName,
      toast: document.querySelector('[class*="toast"], [role="status"]')?.textContent ?? null
    }
  })()`)))

  // P again → preview on.
  await cdp.key('keyDown', 'p', 'KeyP', 80, 0)
  await cdp.key('keyUp', 'p', 'KeyP', 80, 0)
  await Bun.sleep(300)
  console.log('right after second P:', JSON.stringify(await cdp.eval(`(() => {
    const headers = [...document.querySelectorAll('[data-review-collapse-button]')]
      .map((b) => ({ label: b.getAttribute('aria-label'), top: Math.abs(b.getBoundingClientRect().top) }))
      .sort((a, b) => a.top - b.top)
    return {
      toggles: [...document.querySelectorAll('[data-review-markdown-toggle]')]
        .map((b) => ({ label: b.getAttribute('aria-label'), state: b.getAttribute('data-state') })),
      previews: document.querySelectorAll('.markdown-review-preview').length,
      toasts: [...document.querySelectorAll('[class*="toast" i], [role="status"], [role="alert"]')].map((t) => t.textContent),
      nearest: headers.slice(0, 3)
    }
  })()`)))
  const previewAgain = await cdp.waitFor(`document.querySelector('.markdown-review-body') != null`, 8000)
  console.log('P re-enabled preview:', !previewAgain.timedOut)
} finally {
  await quit()
}
