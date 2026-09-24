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

## Perf guardrails

- Pre-mount JS budget is ~1,403,000 B with ~21 KB headroom — no new static imports reachable from `boot.tsx`/`App`. New surfaces: `lazy()` + own CSS file.
- Never `await` a chunk before `createRoot().render()`.
- Main process: nothing synchronous before `createMainWindow()`; session restore stays behind `setImmediate`.
- Command palette typing must cause 0 workspace re-renders (search state lives outside `AppLayout`).
