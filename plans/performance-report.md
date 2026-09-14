# Kodi performance and reliability: measured before/after

Date: 2026-09-14. Baseline build: `e397494`. Post build: `e397494` plus the
working-tree implementation of [performance-and-reliability.md](performance-and-reliability.md).

Both builds were packaged with `bun run dist:mac` and measured as installed
apps, back to back, on the same machine and the same restored session. Raw
artifacts live in `scripts/perf/results/` (gitignored): `ab2-*` for startup,
folder and memory; `ab3-*` for the pull-request matrix, Raycast and hibernation;
`rpt-*` for the n=25 repeats. Reproduce the first table with:

```bash
bun scripts/perf/compare.mjs ab2-baseline ab2-post
```

and the pull-request matrix with `scripts/perf/run-pr-matrix.sh <label-prefix>`,
which needs the fixture checkout named in `scripts/perf/fixtures.json`
(`git clone --filter=blob:none https://github.com/microsoft/TypeScript.git \
/tmp/kodi-perf-fixtures/TypeScript`).

## How the numbers were taken

| | value |
| --- | --- |
| Machine | Mds-MacBook-Pro.local, arm64, 32 GiB |
| Cache state | `os-page-cache-warm` (not an OS-cold claim) |
| Samples | 2 unrecorded warmups, then 30 recorded per scenario per build |
| Missing samples | 0 of 30 in every reported metric, both builds |
| Load average during run | baseline 20.2, post 10.1 |

The load asymmetry is real and is not hidden. It is also small in effect: an
earlier baseline pass on a quiet machine gave first paint p50 443 ms / p95
477 ms, against the loaded baseline's 440 / 525. The post build's 406 / 458
beats both, so the startup win is not a load artifact.

Memory noise was measured directly rather than assumed. Two quiesced runs of
the **same** baseline build gave RSS p50 520.1 MB and 491.2 MB — a 5.9 % spread.
Any memory delta smaller than that is noise, and the table below says so.

## Startup (30 samples each, 0 missing)

| metric | before p50 | after p50 | Δ p50 | before p95 | after p95 | Δ p95 |
| --- | --- | --- | --- | --- | --- | --- |
| navigation | 339 ms | 308 ms | −9.1 % | 400 ms | 349 ms | −12.8 % |
| first paint | 440 ms | 406 ms | −7.7 % | 525 ms | 458 ms | −12.8 % |
| FCP | 507 ms | 466 ms | −8.1 % | 589 ms | 518 ms | −12.1 % |
| renderer loaded | 428 ms | 393 ms | −8.2 % | 512 ms | 445 ms | −13.1 % |
| React committed | 452 ms | 416 ms | −8.0 % | 537 ms | 467 ms | −13.0 % |
| explorer committed | 508 ms | 472 ms | −7.1 % | 589 ms | 521 ms | −11.5 % |
| viewer committed | 515 ms | 472 ms | −8.3 % | 589 ms | 520 ms | −11.7 % |
| app ready | 69.3 ms | 58.1 ms | −16.1 % | 107.8 ms | 65.6 ms | −39.1 % |
| window created | 189.1 ms | 165.6 ms | −12.4 % | 244.6 ms | 185.6 ms | −24.1 % |
| restore settled | 255.1 ms | 231.0 ms | −9.4 % | 362.8 ms | 252.0 ms | −30.5 % |
| longest long task | 0 ms | 0 ms | — | 0 ms | 0 ms | — |
| palette workspace renders | 0 | 0 | — | 0 | 0 | — |

The p95 improvements are larger than the p50 improvements across the whole
chain, which is the signature of removed synchronous launch work rather than a
uniformly faster machine: `loadWorkspaceCache` (up to 25,000 paths) no longer
runs inside `app.whenReady` before `createMainWindow`, and the unconditional
`folderIndex.list` at ready is gone.

Palette typing caused **zero** workspace re-renders in all 60 samples, which is
the plan's stated acceptance rule.

## Open folder, warm repeat opens (30 samples each, 0 missing)

| metric | before p50 | after p50 | Δ p50 | before p95 | after p95 | Δ p95 | before max | after max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| picker open | 9 ms | 7 ms | −22.2 % | 16 ms | 11 ms | −31.3 % | 81 ms | 78 ms |
| picker rows | 9 ms | 7 ms | −22.2 % | 17 ms | 11 ms | −35.3 % | 82 ms | 79 ms |
| heading | 10 ms | 11 ms | +10.0 % | 16 ms | 15 ms | −6.3 % | 19 ms | 15 ms |
| tree rows | 10 ms | 11 ms | +10.0 % | 16 ms | 15 ms | −6.3 % | 19 ms | 15 ms |
| live snapshot | 10 ms | 11 ms | +10.0 % | 16 ms | 15 ms | −6.3 % | 19 ms | 15 ms |

Read the `+10 %` honestly: it is one millisecond at a ten-millisecond scale,
inside the timer's own resolution, while the same metric's p95 and maximum both
improved (19 ms → 15 ms). This is an unchanged scenario, not a regression, and
it is well inside the plan's 5 % p95 rule because p95 moved the right way.

## Resting memory (30 samples each, both `quiesced=true`)

| metric | before | after | Δ |
| --- | --- | --- | --- |
| tree RSS p50 | 491.2 MB | 486.9 MB | −0.9 % |
| tree RSS p95 | 497.6 MB | 487.0 MB | −2.1 % |
| tree RSS max | 497.6 MB | 487.1 MB | −2.1 % |
| tree CPU p95 | 1.0 % | 0.0 % | — |
| process count | 4 | 4 | — |

Both deltas are inside the 5.9 % same-build noise floor, so the correct claim is
**unchanged, not improved**. What matters is that the earlier reported
"537.5 MB regression" is refuted: that sample was taken while the app was still
opening a repository (renderer at 41–57 % CPU with a live `git` child), against
an idle baseline. `benchmark-memory.sh` now waits for the tree to quiesce and
prints `quiesced=true|false`, and two runs are only comparable when both say
true.

### Retained memory across closing a review

| phase | baseline renderer private | post renderer private |
| --- | --- | --- |
| after open | 59.0 MB | 59.8 MB |
| after close | 74.5 MB | 71.1 MB |
| DOM nodes, open → close | 1571 → 214 | 1571 → 214 |

Worth stating plainly: **closing a review does not return renderer private
memory in either build.** The DOM is released, the private footprint is not —
expected for V8 without a forced collection, but it means "retained memory after
close" is now measured rather than assumed. Post grows 11.3 MB against the
baseline's 15.4 MB, an improvement that is real but small.

## Hidden-idle lifecycle (end to end, packaged app)

| check | baseline | post |
| --- | --- | --- |
| reaches snoozed after the 30 s grace | ✗ | ✓ |
| zero watcher handles while snoozed | ✗ | ✓ |
| zero pending watcher paths | ✗ | ✓ |
| zero running and zero waiting commands | ✗ | ✓ |
| resume returns to visible | ✗ | ✓ |
| resume rearms exactly one watcher | ✗ | ✓ |

The baseline fails because it has no lifecycle instrumentation at all — every
counter reads null. The post build's recorded transition trace:

```
hidden-grace  reason=renderer-visibility
snoozed       reason=grace-elapsed        (+30 s)
restoring     reason=reveal
visible       reason=reveal
```

Run it with `KODI_PROBE_HIDDEN=1 KODI_PROBE_LIFECYCLE=1 bun run perf:lifecycle-probe`;
it exits non-zero when any check fails.

## Pull-request size matrix

Five public `microsoft/TypeScript` pull requests, one bucket each, read with the
existing `gh` login. Nothing was created, pushed or modified in any repository.
Each bucket gets one unrecorded warmup run and then its own recorded run, so a
1-file open and a 1,263-file open never share a percentile.

Samples come from the **cold** path. A warm reopen of a pull request that
already has a tab is absorbed by that tab, so repeating one URL inside a single
warm app measures one open and four no-ops — the first version of this probe did
exactly that and produced four empty samples out of five.

`firstPageMs` is first page of files on screen; `doneMs` is the whole patch
resident. For buckets at or under 304 files the two are the same event.

| bucket | n | fails | first page p50 | Δ | first page p95 | Δ | done p50 | Δ | done p95 | Δ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 file | 30 | 0/60 | 500 → 462 ms | **−7.6 %** | 561 → 502 ms | **−10.5 %** | same | | same | |
| 33 files | 30 | 0/60 | 524 → 459 ms | **−12.4 %** | 643 → 508 ms | **−21.0 %** | same | | same | |
| 304 files | 10 | 0/20 | 499 → 454 ms | **−9.0 %** | 632 → 467 ms | **−26.1 %** | same | | same | |
| 1,063 files | 10 | 0/20 | 513 → 476 ms | **−7.2 %** | 543 → 678 ms | +24.9 % | 681 → 644 ms | **−5.4 %** | 714 → 899 ms | +25.9 % |
| 1,263 files | 10 | 0/20 | 509 → 516 ms | +1.4 % | 588 → 549 ms | **−6.6 %** | 730 → 759 ms | +4.0 % | 774 → 846 ms | +9.3 % |

Zero timeouts and zero missing samples in all 100 opens across both builds. The
3,000-file bucket the plan asks for does not exist: no public pull request at
that size was found, and creating one is forbidden. 1,263 files is the largest
bucket measured, and `fixtures.json` records that gap rather than hiding it.

### The two large buckets do not discriminate builds at n=10

The `+24.9 %` at 1,063 files is not a regression, and the honest reason is that
these buckets are network-bound. Evidence, in order:

- That p95 is **one** 899 ms sample. The other nine post samples all beat the
  baseline's fastest.
- Two runs of the **identical baseline binary** at 1,263 files moved p95 from
  528 ms to 723 ms — **+37 %** with no code change at all.
- Two runs of the identical post binary at 1,063 files moved p50 from 644 ms to
  737 ms — **+14 %**, again with no code change.

A build difference has to clear that noise to mean anything, and at n=10 it does
not. Both buckets were therefore repeated at n=25 per build, which settled the
question by failing to settle it:

| run | n | load avg | first page p50 | p95 |
| --- | --- | --- | --- | --- |
| baseline 1,063 | 10 | 16.1 | 513 ms | 543 ms |
| baseline 1,063 | 25 | 7.6 | 534 ms | 578 ms |
| post 1,063 | 10 | 20.1 | 476 ms | 678 ms |
| post 1,063 | 25 | 34.1 | 576 ms | 693 ms |
| baseline 1,263 | 25 | 52.0 | 556 ms | 723 ms |
| post 1,263 | 25 | 13.9 | 492 ms | 531 ms |

Read the 1,063 block on its own: two runs of the **same post binary** are 21 %
apart at p50 (476 vs 576 ms), against 4 % for the baseline binary's two runs.
Post's better run beats baseline's better run and post's worse run loses to
baseline's worse run, and the load averages move in the same direction as the
timings every time. The 1,263 pair at n=25 puts post ahead by −11.5 % p50 /
−26.6 % p95, but baseline ran that one at load 52.0 against post's 13.9, so it
is confounded in post's favour exactly as the 1,063 pair is confounded against
it.

**Claim only this: at 1,063 and 1,263 files the two builds are indistinguishable
under this harness.** Not a win, not a regression — an unresolved comparison,
and the four rows above are why. Separating them needs a machine held quiet for
the duration, which this one was not. The wins at 1, 33 and 304 files sit outside
the same-binary spread and stand.

The plan's Phase 6 criterion, "first file improves for large reviews", is
therefore **partly met**: improved and outside noise up to 304 files, not
separable from noise beyond about 1,000.

## Raycast handoff (30 warm + 30 cold samples, 0 failures)

The extension path is scripted end to end rather than clicked: the same
`sendToKodi` code path, the same `pgrep -x Kodi` detection, the same `open`
invocation. `Clipboard.readText` is host-only, so the probe reads the clipboard
with `pbpaste` and says so in the artifact.

| stage | p50 | p95 | min | max |
| --- | --- | --- | --- | --- |
| clipboard read | 18 ms | 42 ms | 14 ms | 51 ms |
| URL parse | 0 ms | 0 ms | 0 ms | 0 ms |
| is-Kodi-running detection | 25 ms | 43 ms | 24 ms | 44 ms |
| `open` returns | 120 ms | 136 ms | 98 ms | 141 ms |
| extension reports delivered | 167 ms | 192 ms | 142 ms | 231 ms |
| **main receives the deep link** | **310 ms** | **347 ms** | 278 ms | 393 ms |

Cold path, app not running (30 samples, 0 failures): detection 26 ms p50 /
30 ms p95, `open -a` 58 / 71 ms, delivered 100 / 115 ms, **process visible
126 ms p50 / 144 ms p95**.

Two things worth reading off this. The handoff is dominated by `open` — 120 of
the warm path's 167 ms — which is macOS launch services, not Kodi. And the warm
receipt (310 ms) is *slower* than the cold one (126 ms to visible) because the
warm number measures all the way into main's handler on a running app while the
cold number measures the process appearing; they are different endpoints, not a
warm-is-worse result.

## Deep renderer hibernation: built, measured, **fails its bar**

This is the one item that does not come back green, and it is reported as it
measured. Phase 5 step 4 asks for a 20 % physical-footprint saving while
snoozed and a wake back inside 250 ms.

Probe: open a 1,063-file review so there is a payload worth releasing, sample
with it loaded and visible, hide, wait past the 30 s grace, **force a collection**
(V8 returns nothing on its own, and an unforced sample reads as "no saving"),
sample again, then wake through the same second-instance reveal a Raycast user
gets and time to the review being back on screen.

| | result | bar |
| --- | --- | --- |
| samples that actually hibernated | **2 of 5** | 5 of 5 |
| renderer-private saving when it did hibernate | **5.4–7.6 %** | 20 % |
| renderer-private saving when it did *not* | 0–5.8 % | — |
| working-set drop when it did hibernate | 20.6–24.4 % | — |
| working-set drop when it did *not* | 22.8–26.4 % | — |
| wake to usable, hibernated samples | **timed out at 30 s (2 of 2)** | ≤ 250 ms |
| wake to usable, non-hibernated samples | 220 / 262 / 275 ms | ≤ 250 ms |

Three failures, each independently disqualifying:

1. **It rarely runs.** Three of five samples were vetoed by `a git command is in
   flight` — a real in-flight command on a large review, not a probe artifact.
2. **The saving is not the hibernation's.** The 20–26 % working-set drop appears
   in the samples that did *not* hibernate just as strongly, so it is Chromium
   trimming a hidden window, not the payload release. The marginal renderer
   saving attributable to releasing the review is 5.4–7.6 % against 5.8 % for
   merely being hidden — inside a single sample's spread of nothing.
3. **It does not come back.** In both hibernated samples the DOM went
   2429 → 407 nodes and **stayed at 407 through the wake**, with the lifecycle
   state stuck at `hidden-grace` and no code view within 30 s. The released
   focused world never rehydrates.

So: **disabled by default**, behind `KODI_DEEP_HIBERNATION=1`. The release
mechanism, the veto registry and their tests stay in the tree; the restore path
is the open defect. Shipping this enabled would mean shipping a review that does
not return after the user switches away for half a minute, to buy roughly two
percent of renderer memory.

## Ten-minute hidden-idle CPU

A point-in-time percentage cannot answer this question: a timer that wakes twice
a minute reads 0.0 % every time you look at it. The probe reads **cumulative CPU
time** from `ps -o time=` across the whole process tree, so every tick between
the two reads is counted whether or not a sample landed on it.

| | baseline | post |
| --- | --- | --- |
| CPU seconds over 10 minutes | 0.59 s | **0.20 s** |
| as a share of one core | 0.10 % | **0.03 %** |
| lifecycle state at start → end | `null` → `null` | `snoozed` → `snoozed` |
| watcher handles, start → end | null | 0 → 0 |
| pending watcher paths, start → end | null | 0 → 0 |
| process count, start → end | 4 → 4 | 4 → 4 |
| elapsed | 600,108 ms | 600,161 ms |

**−66 % CPU time**, against a criterion that only asked for no increase. Neither
build grew a process over the ten minutes.

The baseline's `stayedSnoozed: false` is not a failure to stay asleep — it has no
lifecycle instrumentation at all, so every state field reads null, the same
reason it scores ✗ on every row of the lifecycle table above. What the post row
adds is that the snooze **held for the full ten minutes** with zero watchers and
zero pending paths at both ends, rather than being true at one instant.

## Durable writes

Session state, window state and the workspace cache now go through
`src/main/atomicWrite.ts`, in three ordered steps:

1. write the temp file and **`fsync` it** — the bytes are on the device, not in
   the page cache,
2. `rename` over the target — atomic for any reader,
3. `fsync` the containing **directory**, so the rename itself survives power
   loss.

Rename alone gives a reader either the old file or the new one; it does not give
you the new one after the machine loses power, because the directory entry can
still be in cache. Step 3 is what the plan asked to be claimed explicitly. The
directory fsync is best-effort — some filesystems refuse an fd on a directory —
and a refusal does not fail the write.

Eight tests cover it: contents replaced, no temp file left behind on success,
previous file kept and temp cleaned up when the write cannot land, an
interleaved pair landing whole rather than spliced, a throw plus cleanup when the
target directory is gone, and quarantine preserving the unparseable bytes and
returning null rather than throwing when there is nothing to move.

## Gates

`bun run verify` on the final tree: lint, stylelint, typecheck, **1,267 tests
pass / 0 fail**, production build, entry-budget check — all exit zero.

- Pre-mount closure: 1,370,633 B against the 1,403,000 B limit (32,367 B spare).
- Entry closure: 3,307 B against the 65,536 B limit.
- Boot chunk carries no WorkerPool and no shiki engine chunk.
- The Raycast extension typechecks clean.

## Bugs found and fixed while verifying

These are defects in the implementation under test, not measurement artifacts.

1. **The snooze never engaged.** `setVisibility(false)` moved the app to
   `hidden-grace`, and the renderer's own visibility sync moved it back to
   `visible` within 50 ms. Chromium reports `document.visibilityState` as
   `"visible"` for a window that was created but never shown, so the renderer
   kept cancelling the snooze it had just requested. Main now refuses a renderer
   "visible" claim while every `BrowserWindow` is hidden. Every Phase 5 budget
   was unreachable before this, and the earlier session's intermittent pass was
   a race, not a working feature.
2. **Clicking the dock did not reveal a hidden window.** `app.on('activate')`
   only created a window when none existed, so an app snoozed behind
   `window.hide()` stayed off screen.
3. **Deep hibernation never restored the review it released** — found by the
   hibernation probe, and the reason the feature is off by default.
4. **The memory harness sampled the wrong moment** (no quiesce gate), which is
   what produced the false 537.5 MB regression.
5. **`memory-probe` could not find the root process**: `pgrep -f` against the
   binary path matches nothing, because the root process is exec'd with its own
   argv.
6. **Session-memory trimming was O(total bytes) per write** — it re-serialized
   every cached review on each remembered thread. Per-entry byte cost is now
   cached alongside the entry.
7. **The pull-request probe measured a single open and called it five samples.**
   A warm reopen of an already-tabbed URL is absorbed by that tab. Cold sampling
   via `COLD_SAMPLES` fixed it; four of the original five samples were empty.

## What is measured, and what is not

Measured and green: startup, folder open, resting memory, hidden-idle lifecycle,
pull-request opens at 1/33/304 files, Raycast handoff, durable writes,
ten-minute idle CPU.

Measured and not green:

- **Deep renderer hibernation** misses both its numbers and loses the review on
  wake. Off by default; the defect is written down above rather than deferred.
- **Large pull requests (1,063 and 1,263 files)** cannot be separated from
  harness noise at these sample counts. Not a regression — an unresolved
  comparison, with the same-binary spread that proves it quoted above.
- **The 3,000-file bucket does not exist.** No public pull request that size was
  found, and the plan forbids creating one.

Not measured: OS-cold cache states (`process-cold`, `kodi-cache-cold`); every
number here is `os-page-cache-warm` and is labelled that way in each artifact.
