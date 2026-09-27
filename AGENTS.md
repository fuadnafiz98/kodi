# Kodi — agent notes

Electron + React 19 diff-first Git explorer. Bun toolchain, electron-vite, `@pierre/diffs` viewer.

## After any app change — always reinstall

Any change to `src/main`, `src/preload`, `src/renderer`, or packaging **must** end with:

```bash
bun run update:mac
```

This builds, packages arm64, and replaces `~/Applications/Kodi.app`. It quits the running app — expected. Do not open the app afterward unless the user asks. Skip only for docs/rules-only changes.

## Testing without windows flashing

Performance probes and CDP checks run fully hidden — prefix with `KODI_PROBE_HIDDEN=1`:

```bash
KODI_PROBE_HIDDEN=1 bun run perf:startup-probe <label>
KODI_PROBE_HIDDEN=1 bun run perf:open-folder-probe <label>
KODI_PROBE_HIDDEN=1 PRS=<url> bun run perf:pr-open-probe <label>
```

For ad-hoc CDP checks, `scripts/perf/cdp.mjs` exports `launch`/`quit`/`CDP`. The hidden window has a zero-size viewport — use `Emulation.setDeviceMetricsOverride` before relying on virtualized lists.

- `launch(port, ['--kodi-folder', '/path/to/repo'])` opens a fixture repository directly — but it rewrites the user's real session (tabs, `lastRoot`, approved roots). Add `--user-data-dir=/tmp/<scratch>` to any probe that opens folders or clicks UI, so the real profile is untouched. The flag also works with `node_modules/.bin/electron .` against a local `bun run build`, which gives screenshots without reinstalling.
- Explorer rows and diff lines live in shadow roots; search recursively through `el.shadowRoot` (`[data-item-path="x"][data-item-type="file"]`, `[data-line]`). Clicking a changed file's row enters the multi-file review.
- In hidden mode the review only renders its first file, so use one changed file per fixture repo.

## Gates

`bun run lint`, `bun run lint:css`, `bun run typecheck`, `bun test`, `bun run build`, `bun run check:entry`.

Explorer, tree, watcher, review or editor changes also run `bun run e2e` after `bun run build` (hidden window, scratch profile, generated fixtures; results append to `scripts/e2e/results/<suite>.jsonl`, compare with `bun scripts/e2e/trend.mjs <suite>`):

- `cold-start` — rebuilds, then launches right away (the first launch after an install) and clicks the changed file while the skeleton shows: every launch must end on the live snapshot. The old build sat on "Detached HEAD, 4 files" here.
- `file-contents` — a file with nothing to diff is still shown: committing the open file (terminal or Source Control) or reverting it must switch to its contents, not "No files to review"; a file scrolled past keeps the review on what is being read; staging keeps the diff; ⌘K to a clean file shows it; returning from the single-file view lands on the clicked file, not the review's last offset.
- `palette-navigation` — ⌘K to a file from a folder review and a commit review must scroll that file's section to the top and select it in the tree, and in the single-file view must show that file's own header. Every load runs three ways: as sent, with each invoke reply ahead of its streamed pages, and with the reply between the first page and the rest (`reorderReviewProgress` in the harness, via the main inspector) — Electron does not order a reply against `webContents.send`, and a load that trusted the reply kept the first file only, so ⌘K did nothing.
- `smoothness` — frame pacing and long tasks while flinging a 4,000-line diff, sitting idle, saving elsewhere with the review open (0 refetches, 0 whole-file hydrations mid-fling), and ⌘K open/type/scroll.
- `soak` — cycles ⌘K, tree clicks, scrolling, watcher ticks, Source Control and idle for `KODI_E2E_SOAK_MINUTES` (default 3) and fails when the end of the run is worse than its start, on any freeze ≥ 250 ms, on heap/DOM/listener growth, or on any paged review fallback. For real conditions point it at a copy of a busy repository and profile: `KODI_E2E_SOAK_FOLDER=<copy> KODI_E2E_SOAK_PROFILE=<copy of ~/Library/Application Support/kodi without Cookies> KODI_E2E_SOAK_LOG=<file.jsonl> KODI_E2E_SOAK_MINUTES=240`.
- `large-worktree` — ~24k untracked files / ~6k folders: expand/collapse all, status ticks over 24k statuses, watcher burst, Stage All. Fails a renderer stall over 1.5 s; collapse-all once froze 15 s here.
- `huge-repo` — 100k tracked files: status ticks, saves, new files and filter typing must keep the reader's folders as they left them, cause no tree rebuild (`treeResets`) and no renderer long task over 100 ms; ⌘P typing and opening Source Control must not re-render the workspace. `KODI_E2E_FIXTURE_CACHE=1` reuses the fixture (~40 s to write).
- `session-restore` — restarts on one profile: a folder left open comes back; a folder whose tab was closed stays closed (the dashboard opens).
- `review-editing` — 80 changed files: a `git add` with the review open refetches nothing (`comparisonRequests`); typing in the editor re-renders the workspace at most a few times, not per key.

Harness switches: `KODI_E2E_APP_DIR=<checkout>` runs another checkout's `out/` (a `git worktree` of an older commit, built there, with `node_modules` symlinked) — the baseline for "is this a regression"; `KODI_E2E_VISIBLE=1` shows a real window, because a hidden one never paints; `KODI_E2E_PORT` moves the DevTools port (main uses port + 1) so a long soak and other suites can run at once. `bun run update:mac` pkills every "Kodi Helper" process — including an e2e run's renderer — so never install while a suite is running.

A freeze or waste fix is proven by the suite failing on the old build first: `KODI_E2E_APP=~/Applications/Kodi.app/Contents/MacOS/Kodi bun scripts/e2e/<suite>.e2e.mjs` runs the last installed build as the baseline. Counters for these checks live in `src/renderer/src/perf/kodiCounters.ts`.

## Perf guardrails

- Pre-mount JS budget is ~1,403,000 B with ~9 KB headroom (1,393,772 B on 2026-09-27) — no new static imports reachable from `boot.tsx`/`App`. New surfaces: `lazy()` + own CSS file.
- Never `await` a chunk before `createRoot().render()`.
- Main process: nothing synchronous before `createMainWindow()`; session restore stays behind `setImmediate`.
- Command palette typing must cause 0 workspace re-renders (search state lives outside `AppLayout`).
