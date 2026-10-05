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
- A probe that reads the review's `CodeView` (`window.__INSTANCE`) reads `root.scrollTop`, never `getScrollTop()`: that call consumes the viewer's pending scroll state, and a probe calling it mid-frame made plain scrolling drift.
- In hidden mode the review only renders its first file, so use one changed file per fixture repo.

## Gates

`bun run lint`, `bun run lint:css`, `bun run typecheck`, `bun test`, `bun run build`, `bun run check:entry`.

Explorer, tree, watcher, review or editor changes also run `bun run e2e` after `bun run build` (hidden window, scratch profile, generated fixtures; results append to `scripts/e2e/results/<suite>.jsonl`, compare with `bun scripts/e2e/trend.mjs <suite>`):

- `agent-chat` — the agent dock against a scripted agent (its IPC handlers replaced through the main inspector, so no CLI or sign-in): an answer's heading, code inside bold, a code block's label and its thin scrollbar, spacing above a heading, Copy answer on screen when an answer ends; a markdown table (alignment, escaped pipes, code in cells); New conversation keeps the previous chat in the Chats list, opening it shows it and a follow-up resumes its session, and the list survives a restart; a selection sent with a question stays on it as `file:line`; New while a chat is answering leaves it running (no cancel) and it finishes in the background.
- `cold-start` — rebuilds, then launches right away (the first launch after an install) and clicks the changed file while the skeleton shows: every launch must end on the live snapshot. The old build sat on "Detached HEAD, 4 files" here.
- `file-contents` — a file with nothing to diff is still shown: committing the open file (terminal or Source Control) or reverting it must switch to its contents, not "No files to review"; a file scrolled past keeps the review on what is being read; staging keeps the diff; ⌘K to a clean file shows it and opens the tree out to its row, selected; returning from the single-file view lands on the clicked file, not the review's last offset. ⌃Tab / ⌃⇧Tab cycle the tabs (also with the caret in a file) and ⌘1–9 pick one; two quick presses move two tabs.
- `in-place-editing` — a file is edited by clicking into it, on its own and inside the folder review: the caret lands at the click, ⌘S writes exactly that text, the edited file does not move on screen, the title does not shift when Save appears, a draft survives leaving the file (and scrolling out of the review) and opens back into it, Discard puts the disk copy back, a write from outside a clean session shows the disk copy (in the review too, with an editor open on the file, whether the write lands in place or through a temp file and a rename), the markdown split's preview follows the draft, deleted lines and commit reviews stay read-only, the review still scrolls smoothly after editing, an edited line in a `color(display-p3 …)` theme (the vibrant ones) is still drawn, the editor's selection bar is the review's three icons, Add to Chat attaches the selected line, and a unified diff shows the old and the new line number side by side (a deleted row in the old column only, an added one in the new only).
- `kodi-cli` — `kodi <folder>` (a second launch on the profile, as the bundled script does it) with the app up shows that folder; one open in another tab goes back to that tab, also with a commit review of it in front; one straight after a launch on another folder ends on the one it named. A SIGTERM quit ends the process with nothing left to write and with an unsaved draft, the draft typed just before it is back on the next launch, and the next launch opens its folder. The old build stayed on the folder it was showing (main opened the new one; the window drops change events for other roots), and its quit left a windowless process holding the single-instance lock, so every later launch and `kodi .` was handed to it. Main holds the folder until the window takes it (`takeExternalFolder`), after the window's startup snapshot has settled.
- `palette-navigation` — ⌘K to a file from a folder review and a commit review must scroll that file's section to the top and select it in the tree, and in the single-file view must show that file's own header. Enter pressed straight after typing opens what was typed (the file results are a deferred render behind the input). A path with a line (`src/app.ts:42`, `:42:7`, `#L42`, `(42,7)`) lands on that line, selected and on screen, in the folder review and the single-file view; a bare `:42` goes to that line of the open file. Every load runs three ways: as sent, with each invoke reply ahead of its streamed pages, and with the reply between the first page and the rest (`reorderReviewProgress` in the harness, via the main inspector) — Electron does not order a reply against `webContents.send`, and a load that trusted the reply kept the first file only, so ⌘K did nothing.
- `scroll-under-writes` — reading a folder review while an agent rewrites its files every 300–700 ms (the file on screen above and below the line being read, files above and below the viewport, a 3,600-line lockfile with ~2,500-character lines; in place and through a rename), scrolling like a trackpad and sitting still, in every diff style × word wrap × folding combination, then toggling each: the line at the top of the screen must stay where the reader's own scrolling puts it (no drift > 2 px), and a toggle must keep it on screen. The old build drifted up to 568 px per write. `KODI_E2E_SCROLL_FOLDER=<copy of a repository> KODI_E2E_SCROLL_PROFILE=<copy of a profile>` runs it on a real working tree (its files are put back byte for byte); `KODI_E2E_SCROLL_ONLY=<configuration>` runs one combination.
- `smoothness` — frame pacing and long tasks while flinging a 4,000-line diff, sitting idle, saving elsewhere with the review open (0 refetches, 0 whole-file hydrations mid-fling), and ⌘K open/type/scroll.
- `soak` — cycles ⌘K, tree clicks, scrolling, watcher ticks, Source Control and idle for `KODI_E2E_SOAK_MINUTES` (default 3) and fails when the end of the run is worse than its start, on any freeze ≥ 250 ms, on heap/DOM/listener growth, or on any paged review fallback. For real conditions point it at a copy of a busy repository and profile: `KODI_E2E_SOAK_FOLDER=<copy> KODI_E2E_SOAK_PROFILE=<copy of ~/Library/Application Support/kodi without Cookies> KODI_E2E_SOAK_LOG=<file.jsonl> KODI_E2E_SOAK_MINUTES=240`.
- `large-worktree` — ~24k untracked files / ~6k folders: expand/collapse all, status ticks over 24k statuses, watcher burst, Stage All. Fails a renderer stall over 1.5 s; collapse-all once froze 15 s here.
- `huge-repo` — 100k tracked files: status ticks, saves, new files and filter typing must keep the reader's folders as they left them, cause no tree rebuild (`treeResets`) and no renderer long task over 100 ms; ⌘P typing and opening Source Control must not re-render the workspace. `KODI_E2E_FIXTURE_CACHE=1` reuses the fixture (~40 s to write).
- `session-restore` — restarts on one profile: a folder left open comes back; a folder whose tab was closed stays closed (the dashboard opens); the file left open comes back at its top (not its last line), a Backspace in it deletes one character and shows Unsaved, and Discard puts it back without moving the file.
- `review-editing` — 80 changed files: a `git add` with the review open refetches nothing (`comparisonRequests`); typing in the editor re-renders the workspace at most a few times, not per key.

Stopping an app (the harness, `update:mac`) sends SIGTERM to the main process alone first: it quits as on ⌘Q, flushing the session and localStorage (an unsaved-draft prompt is skipped; drafts are restored on the next launch), with a 3 s failsafe. Killing the helpers at the same time lost whatever localStorage had written in the last few seconds. Electron replaces Node's SIGTERM handler with its own while it starts, so the app's listener is added once the app is ready; one added as the module loads never runs. `before-quit` calls its second `app.quit()` from a `setImmediate`: called from the handler's own microtasks, it ran inside the first quit, which then marked itself cancelled and left the app up with no window. The installer SIGKILLs a main process still up 4 s after the SIGTERM.

Harness switches: `KODI_E2E_APP_DIR=<checkout>` runs another checkout's `out/` (a `git worktree` of an older commit, built there, with `node_modules` symlinked) — the baseline for "is this a regression"; `KODI_E2E_VISIBLE=1` shows a real window, because a hidden one never paints; `KODI_E2E_PORT` moves the DevTools port (main uses port + 1) so a long soak and other suites can run at once. `bun run update:mac` pkills every "Kodi Helper" process — including an e2e run's renderer — so never install while a suite is running.

A freeze or waste fix is proven by the suite failing on the old build first: `KODI_E2E_APP=~/Applications/Kodi.app/Contents/MacOS/Kodi bun scripts/e2e/<suite>.e2e.mjs` runs the last installed build as the baseline. Counters for these checks live in `src/renderer/src/perf/kodiCounters.ts`.

## Perf guardrails

- Pre-mount JS budget is ~1,403,000 B with ~19 KB headroom (1,381,834 B on 2026-10-01) — no new static imports reachable from `boot.tsx`/`App`. New surfaces: `lazy()` + own CSS file. Code only some reviews or files need (pull request parts, the comment summary, review editing, the live markdown preview) loads through `createLazyModule` (`app/lazyModule.ts`) when it is first wanted.
- CSS in a template string ships verbatim, comments included — the minifier only drops JS comments. Write a comment inside one as `${/* … */ ''}` (esbuild folds it to nothing) or above the const. The two viewers' own stylesheets (`@pierre/diffs` and `@pierre/trees` `dist/style.js`) are run through the CSS minifier at build time (`kodi:minify-library-styles`), ~15 KB off the boot path. Our own template stylesheets lose the whitespace that spans their line breaks at build time (`kodi:collapse-css-strings`, ~2.4 KB) when the const's name ends in `_CSS` or `_STYLES`; name a new one that way.
- The markdown parser is off the startup path: `useAgentAnswer` loads it with the first question (`loadAgentMarkdown`); only type imports of `markdown/markdown` belong in pre-mount modules.
- Never `await` a chunk before `createRoot().render()`.
- Main process: nothing synchronous before `createMainWindow()`; session restore stays behind `setImmediate`.
- Command palette typing must cause 0 workspace re-renders (search state lives outside `AppLayout`).

## Patched dependencies

`patches/@pierre%2Fdiffs@1.3.6.patch` (applied by `bun install` through `patchedDependencies`) fixes library bugs and adds what the library lacks:

- The single-file `Virtualizer` anchored a file that had no height yet by its bottom, so a file opening at the top of the scroller jumped to its last line once it rendered.
- The editor's tokenizer read token colors off shiki's hex-only color map without `colorReplacements`, so in a theme written in `color(display-p3 …)` every edited line drew in #00000001 — invisible.
- Each unified gutter cell gets a `data-old-line` (the old side's number), which `viewerCss.ts` draws as a second number column, so a unified diff reads old | new like GitHub's.
- A file whose content changed kept drawing its old highlighted text, laid out as the new diff, until the new highlight arrived (`DiffHunksRenderer.renderDiff`), then snapped by the rows inserted above with no scroll correction — the jump under every agent write. It now draws the new content at once, and a highlight for a diff it no longer shows is dropped. Kodi primes the highlight before it swaps a rewrite in, so the plain-text frame is rare: `primeReviewHighlights` for the review (rendered items only, at most three — the worker caches four), `usePrimedComparison` for the single-file view (never during an edit session).
- A line anchor carries its row's text and is found again by that text in the new diff (`resolveAnchorLinePosition`, within the rows added or removed plus some slack); a line number names other text once lines move, and every row of a new file is numbered on the new side. The anchor prefers the new side of a row, skips blank and brace-only rows, and resolves against the diff being laid out, not the one last drawn. A file whose header is on screen stays anchored by its header unless its diff object was replaced, then by its first line.
- With word wrap, row heights are remembered by row text per diff style and code width (`rememberWrappedRows`/`seedWrappedRows`; each file keeps its own width — a new file's split view is one column, a long file's gutter is wider) and a row never measured is estimated from its length (`countWrappedRows`, pre-wrap + break-word in a monospace column). Every reset — a rewrite, a split/unified/wrap/fold toggle, a selection, a collapse — used to drop all measurements and fall back to one row per line, so wrapped files re-grew under the reader and the scroll position was corrected frame after frame. Keying the memory by style alone made two files of different widths evict each other every frame (1000 px corrections on materialsx-core-4, where bun.lock sits second); files over 8,000 rows are left to the library.
- The sticky container's random 0–19 px offset (a shake whenever rendering fell behind scrolling) is gone.

Bumping `@pierre/diffs` means re-checking each of these against the new version (`getScrollAnchor`, `editor/tokenizer.js`, `pushGutterLineNumber`, `renderDiff`'s pool branch, `getNumericScrollAnchor`/`resolveAnchoredScrollTop`, `reconcileHeights`/`prepareCodeViewItem`, `applyStickyPositioning`) and renaming the patch to the new version. Regenerate the patch with `git diff --no-index` of a pristine copy of the package (bun's cache, `~/.bun/install/cache/@pierre/diffs@<version>@@@1`) against `node_modules/@pierre/diffs`. Do not use `bun patch` on it — a failed `bun patch` deletes the package folder (`bun install` restores it).
