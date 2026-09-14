# Kodi performance harness

Three CDP probes that drive the **installed** app (`~/Applications/Kodi.app`,
or whatever `KODI_APP` points at) and one PATH shim that counts git/gh spawns.
They measure the shipped build, so run `bun run update:mac` first — building the
repo alone changes nothing they can see.

Every probe quits Kodi before it starts and again when it finishes, including
on Ctrl+C, so none of them leaves a window behind.

The scenario catalog is `fixtures.json`. Set `KODI_PERF_FIXTURE` and
`KODI_PERF_CACHE_STATE` for every recorded run. Each JSONL record includes a
UUID run ID, clock origins, machine RAM, architecture, fixture ID, and cache
state. `PERF` summaries report p50, p95, maximum, and missing-sample failures.
Use two unrecorded warmups before the 30 recorded samples. A p95 from fewer
than 30 samples is provisional.

```bash
bun run perf:startup-probe before      # cold launch + first Cmd+P
bun run perf:open-folder-probe before  # Cmd+O -> Enter -> usable tree
bun run perf:pr-open-probe before      # kodi://review deep link, warm and cold
bun run perf:memory-probe before       # resting RSS of the tree + retained after close
bun run perf:lifecycle-probe           # hidden-idle snooze budget and resume
```

`bun run perf:matrix <label>` runs all of those in one recorded pass (two
warmups, then 30 samples each) and writes `<label>.jsonl`,
`<label>-folder.jsonl`, `<label>-memory.txt` and `<label>-lifecycle.json`.
`bun scripts/perf/compare.mjs <before> <after>` prints p50/p95/max per metric
from the raw samples of two such labels, with sample and missing-sample counts
beside every number.

`memory-probe` refuses to guess between Kodi instances: it launches the app
itself, resolves the single root PID, and hands it to `benchmark-memory.sh`,
which waits for the process tree to go quiet before it samples and prints
`quiesced=true|false`. Two memory runs are comparable only when both quiesced —
a tree still spawning `git` measures the open, not the resting cost. The probe
then closes every review world and re-reads the counters, so memory that a
closed review still retains shows up as an `after-close` row.

`lifecycle-probe` drives the snooze contract end to end: hide, wait past the
30-second grace, then assert the snoozed state has zero watcher handles, zero
pending paths and idle command lanes, and that resume rearms exactly one
watcher. Resume goes through a second launch of the app binary, because the
single-instance lock turns that into the same reveal a user gets from Raycast
or `kodi .`. It exits non-zero when any of those checks fail.

Prefix a probe with `KODI_PROBE_HIDDEN=1` to run it with the window never
shown — nothing appears on screen, nothing takes focus, no dock bounce. The
app binary is exec'd directly with `KODI_PROBE=1`, the session still restores,
and `windowShown` reports null because `window.show()` genuinely never ran.

For lifecycle checks, also set `KODI_PROBE_LIFECYCLE=1`. This preserves normal
Chromium background throttling and applies a 1440×920 CDP viewport before
virtualized-list assertions.

`theme-screenshots.mjs` is the visual counterpart rather than a perf probe: it
cycles all sixteen editor themes, captures a PNG of the restored workspace for
each into `OUT` (default `/tmp/kodi-theme-shots`), and prints the computed
shell vars per theme as JSON. `OPEN_REPO=<picker name>` opens that repository
first so the shots cover the review surface; `MODE=live` switches through the
Settings theme cards instead of reloading, which is the only path that can
expose state left over from the previous theme.

```bash
KODI_PROBE_HIDDEN=1 bun run perf:startup-probe quiet
```

The argument is a label. Each run appends one JSON object to
`scripts/perf/results/<label>.jsonl` (gitignored) as well as printing to stdout,
so `before` and `after` runs stay side by side. Every probe also prints one
`PERF {…}` line last, carrying the median, min and max of its headline metrics —
`grep '^PERF' ` two runs and the comparison is a two-line diff.

## Environment

| Variable | Default | Applies to |
| --- | --- | --- |
| `KODI_APP` | `~/Applications/Kodi.app` | all |
| `KODI_PERF_RESULTS_DIR` | `scripts/perf/results` | all |
| `KODI_PERF_RUN_ID` | random UUID | all |
| `KODI_PERF_FIXTURE` | `restored-session` | all |
| `KODI_PERF_CACHE_STATE` | `os-page-cache-warm` | all |
| `SAMPLES` | `3` | startup |
| `TIMEOUT_MS` | `20000` | startup |
| `QUERY` | `app` | startup (what to type into the palette) |
| `FOLDERS` | `imux,materialsx-core-3,imux,kodi` | open-folder |
| `OPEN_TIMEOUT_MS` | `20000` | open-folder (whole open, not per condition) |
| `PRS` | *(required)* | pr-open |
| `PR_TIMEOUT_MS` | `20000` | pr-open (whole open, not per condition) |

## What each probe reports

**startup-probe** — `firstPaintMs` / `fcpMs` measured from the `open` call, the
renderer marks (`reactCommitted`, `snapshotReady`, `explorerCommitted`,
`viewerCommitted`), main's `mainStartup` block (`windowShown`,
`restoreSettled`), every long task over 50 ms, and a palette block:
`openMs`, `paletteOpenAppMs`, `emptyRows`, `fileResultsMs`, `contentResultsMs`
and `workspaceRenders` (the re-render delta across the typed query; `null` until
the renderer exposes `window.__kodiMetrics`). Read Cmd+P from
`paletteOpenAppMs`: it is the app's own `kodi:palette-open-to-focus` measure,
where `openMs` also carries the probe's four input round trips and a poll.
`emptyRows` is read once the count stops moving (the palette paints 12 rows and
fills in the rest a frame later), so it is the list the user actually sees.

**open-folder-probe** — per folder: `pickerOpenMs`, `pickerRowsMs`,
`headingMs`, `treeRowsMs`, `branchMs`, `publishedMs` and `liveSnapshotMs`. The
last one is the number that matters: the first moment the folder is genuinely
usable rather than a path skeleton. It is the earlier of two sightings, reported
as `liveSource`: `change` for a publish carrying a branch (or `stage: 'live'`),
and `dom` for the branch appearing in the explorer heading. Both are needed —
an open whose refresh wins the 150 ms race answers over IPC and publishes
nothing, and `window.repository` is frozen by `contextBridge`, so the probe
cannot intercept the IPC result itself. A skeleton snapshot has no branch and
renders as "Detached HEAD", which is what makes the heading a reliable marker.

**pr-open-probe** — per pull request, warm app and cold app:
`tabOrLoadingMs`, `reviewSurfaceMs`, `metadataMs`, `firstPageMs`, `doneMs`,
`firstCodeViewMs`, and `progressKinds` (the first sighting and the count of
every progress kind the renderer saw, including ones this probe predates).
`timedOut` says whether the review finished inside the deadline; the moments
that did happen are still timed when it did not.

Both open probes poll one expression against a single deadline, so a condition
that never arrives leaves its own field null instead of delaying every
measurement behind it.

## Counting git and gh spawns

`git-shim/` holds a `git` and a `gh` that log every spawn and then exec the real
binary. Put it first on `PATH` for the process that launches Kodi, and point
`KODI_GIT_SHIM_LOG` at a file:

```bash
KODI_GIT_SHIM_LOG=/tmp/kodi-git.log \
PATH="$PWD/scripts/perf/git-shim:$PATH" \
  bun run perf:open-folder-probe after
```

The app must inherit that environment, so launch it from the same shell (the
probes use `open -na`, which does inherit it). Each line is tab separated:

```
started_epoch_seconds  elapsed_ms  exit_status  tool  argv
```

Useful reductions:

```bash
wc -l < /tmp/kodi-git.log                                    # total spawns
cut -f5 /tmp/kodi-git.log | sort | uniq -c | sort -rn | head # by command
awk -F'\t' '{sum += $2} END {print sum " ms"}' /tmp/kodi-git.log
awk -F'\t' '$4 == "gh"' /tmp/kodi-git.log                    # gh only
```

Without `KODI_GIT_SHIM_LOG` the shim is a transparent pass-through, so leaving
it on `PATH` is harmless. It adds one `zsh -f` startup per spawn (a few
milliseconds), which is why spawn *counts* are the number to trust from it and
wall times are indicative.

## Bundle budget

`bun run check:entry` is the static counterpart: it sums the transitive
pre-mount closure in `out/renderer` (entry, boot and the workspace/viewer
chunks, following static imports only) and fails above `MAX_PREMOUNT_BYTES`. It
prints the fifteen largest chunks in that closure, which is the fastest way to
see what a regression pulled back onto the boot path.
