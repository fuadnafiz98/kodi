// What a relaunch brings back must follow what the reader left in front:
//   - a folder left open comes back;
//   - a folder whose tab was closed stays closed — the dashboard opens instead.
//
//   bun run build && bun run e2e session-restore
//
// Before the fix, closing the tab released the folder but left it as the one to
// restore, so every launch reopened it.
import { createProfile, createRepository, launchApp, press, removeLater, runSuite } from './harness.mjs'

// The session is written right away, the workspace cache a second after the
// last change; the restart waits for both.
const PERSIST_SETTLE_MS = 2_500
const fileCount = `document.querySelector('.sidebar-file-count') != null`
const dashboard = `document.querySelector('.welcome') != null && document.querySelector('.sidebar-file-count') == null`
const closeActiveTab = `document.querySelector('.world-tab[data-active="true"] .world-close').click()`

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
})
