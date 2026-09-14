// Verify the progress pill is gone and the scroll-end sentinel loads pages.
import { writeFile } from 'node:fs/promises'
import { guardExit, launch, quit, settle } from './cdp.mjs'

const PORT = 9333

guardExit()

try {
  const { cdp } = await launch(PORT)
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 2, mobile: false
  })
  await settle(cdp)
  await cdp.waitFor(`document.querySelector('[data-review-collapse-button]') != null`, 15000)
  await Bun.sleep(800)

  console.log('initial:', JSON.stringify(await cdp.eval(`(() => ({
    pill: document.querySelector('.multi-file-progress') != null,
    sentinel: document.querySelector('.review-load-sentinel') != null,
    headers: document.querySelectorAll('[data-review-collapse-button]').length,
    status: document.querySelector('[role="status"]')?.textContent ?? null
  }))()`)))

  // Jump near the bottom — the sentinel should page in the next 50 files.
  const itemCount = () => cdp.eval(`document.querySelectorAll('[data-review-collapse-button]').length`)
  const before = await itemCount()
  for (let i = 0; i < 6; i++) {
    await cdp.eval(`(() => {
      const scroller = document.querySelector('.multi-file-code-view')
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    })()`)
    await Bun.sleep(600)
  }
  const after = await itemCount()
  console.log('headers before/after scroll-to-end:', before, '→', after)
  console.log('final:', JSON.stringify(await cdp.eval(`(() => ({
    pill: document.querySelector('.multi-file-progress') != null,
    sentinel: document.querySelector('.review-load-sentinel') != null,
    backToTop: document.querySelector('.back-to-top') != null
  }))()`)))

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  await writeFile('/tmp/kodi-no-pill.png', Buffer.from(shot.data, 'base64'))
  console.log('screenshot: /tmp/kodi-no-pill.png')
} finally {
  await quit()
}
