# Kodi performance and reliability implementation plan

Status: proposed; audited at `f5ee11e` with existing working-tree changes, 2026-09-14. This document consolidates the seven short plans into one phased implementation program. No product changes or new packaged benchmarks were performed during this audit.

The companion [GitHub architecture](grok-github-fast.md) covers the optional replica design. This document controls implementation order and acceptance. Phase numbers are work checkpoints, not separate plans.

## Execution order

Start with Phase 1. Phase 2 protects review identity before Phases 3 and 6. Phase 4 can proceed after measurement without waiting for the GitHub redesign. Phase 5 depends on measurement and launch-state ownership. Phase 7 persistence/deadline work can proceed early; its mutation queue depends on Phases 2 and 3.

## Shared execution contract

- Compare live source with the evidence below before editing; the audit used a dirty worktree, so HEAD alone is not a complete baseline. Preserve unrelated changes.
- Keep new surfaces lazy and preserve the 1,403,000-byte pre-mount and 64 KiB entry-closure budgets. Never await a chunk before React renders.
- Gates: `bun run lint`, `bun run lint:css`, `bun run typecheck`, `bun test`, `bun run build`, `bun run check:entry`. Each must exit zero. After app or packaging changes, run `bun run update:mac`; do not open the app afterward.
- Use `KODI_PROBE_HIDDEN=1` for existing probes. They launch the installed build, quit Kodi, and disable throttling. They cannot measure production hidden-idle behavior. A separate lifecycle mode must preserve throttling and set a nonzero CDP viewport before checking virtualized content.
- Stop and report when source assumptions fail, draft persistence cannot be proven, or a change requires broader product semantics. Do not weaken correctness to meet a timing budget.

## Phase 1: Establish trustworthy performance and memory baselines

> This phase is measurement-only. Use deterministic fixtures by default and existing authorized read access for live smoke checks. Do not change product behavior or user repositories to create benchmark fixtures.

### Status

- Priority: P0; Effort: M; Risk: LOW; Depends on: none; Category: perf/tests; Planned at: `f5ee11e`, 2026-09-14.

### Why this matters

Kodi already has useful probes, but their clocks and “usable” markers are not one contract. Without a baseline, improvements can trade a faster dock bounce for a slower first file, or measure the wrong Electron process. Establish reproducible p50/p95 numbers first.

### Scope and current state

Inspect `scripts/perf/startup-probe.mjs`, `open-folder-probe.mjs`, `pr-open-probe.mjs`, `cdp.mjs`, `benchmark-memory.sh`, `src/main/index.ts:110`, `src/renderer/src/app/startupMetrics.ts`, and `scripts/check-entry-chunk.mjs`. Preserve hidden probes and the existing entry budget.

### Steps

1. Add a fixture manifest and a run ID to probe output. Record cold process, warm process, cold disk cache where possible, 1/30/300/1000/3000-file PRs, 0/100/101-thread conversations, small/large folders, offline, slow, and force-push scenarios. Verify JSONL parses with `bun scripts/perf/...`; every sample has the same origin fields.
2. Normalize clocks to process launch, and label `windowShown`, shell paint, React commit, explorer usable, first metadata, first file, first tokenized file, first interactive input, complete validated snapshot, and restore settled separately. Verify a delayed GitHub response does not mark a local folder unusable.
3. Update memory sampling to accept an explicit root PID and report p50/p95 RSS, physical footprint, CPU time, event-loop delay, child count, watcher count, cache bytes, subprocess concurrency, queue wait, abort latency, and retained RSS after close. Verify it refuses to silently select another Kodi instance.
4. Record baseline artifacts under `scripts/perf/results` (gitignored) and document commands in `scripts/perf/README.md`. Do not commit user data or tokens.

### Done criteria

- [ ] At least 30 samples per ordinary latency scenario produce raw samples, failure counts, and p50/p95 summaries; three runs are only a smoke check.
- [ ] Cold Cmd+H and warm Cmd+H report first metadata, first file, first usable viewport, and complete snapshot.
- [ ] Memory reports the intended process tree and retained memory after closing a review.
- [ ] `bun run lint && bun run typecheck && bun test` pass.

### Maintenance

Each later phase runs the affected small/large scenarios plus startup and memory guardrails. Run the full matrix at program close-out. A budget is not changed because a single sample improves.

### Measurement protocol and acceptance gate

Record the machine, RAM, macOS version, app build hash, Git/gh versions, power state, fixture revision, viewport, cache state, and active child processes. Separate two warmup runs from at least 30 recorded samples for key latency scenarios. Report p50, p95, maximum, failures/timeouts, and raw samples; p95 from a small sample remains provisional. Never drop timeouts from the report to improve a percentile.

Cold launch starts at process launch; warm PR/file/folder opens start at the user trigger, with main receipt as a second app-only origin. Distinguish process-cold, Kodi-cache-cold, and OS-page-cache-cold. Do not claim OS-cold results unless controlled. Existing commands after installing the measured app are `KODI_PROBE_HIDDEN=1 SAMPLES=30 bun run perf:startup-probe baseline`, `KODI_PROBE_HIDDEN=1 FOLDERS=<fixture names> bun run perf:open-folder-probe baseline`, and `KODI_PROBE_HIDDEN=1 PRS=<fixture URLs> bun run perf:pr-open-probe baseline`. The latter two currently require repeated runs for sample counts; add a harness loop without combining different scenarios into one percentile.

Initial acceptance rules: no new correctness failures; zero workspace renders from palette typing; unchanged static bundle caps; no more than 5% p95 latency or retained-footprint regression on unaffected scenarios, subject to repeat-run noise. A performance phase should demonstrate at least a 10% improvement in its targeted cost or justify a concrete reliability gain. These are proposed review thresholds, not measured results.

Snoozed state must have zero periodic GitHub detail reads, zero clipboard interval ticks, zero active repository watch handles, and a bounded dirty flag. Resume must coalesce to one authoritative refresh per resumed active root. Measure idle CPU-time deltas over ten minutes and require no increase against baseline. Deep hibernation remains experimental until it saves at least 20% physical footprint and its p95 wake-to-usable penalty stays within an explicitly recorded 250 ms allowance relative to snooze; change these provisional values only with recorded evidence.

## Phase 2: Make pull-request snapshots immutable and complete

### Status

- Priority: P0; Effort: L; Risk: HIGH; Depends on: Phase 1; Category: correctness/perf; Planned at: `f5ee11e`, 2026-09-14.

### Why this matters

The current cache key is URL plus head OID (`src/main/repository.ts:1190`). Revalidation checks only head (`:2993`) and emits an automatic replacement (`:3013`). A base retarget can therefore reuse the wrong patch, and a background force-push can move a frozen tab while the user is reading it. Conversation queries also cap threads/comments/reviews without page information (`:295-309`).

### Scope

In scope: `src/main/repository.ts`, `src/main/patchBuilder.ts`, shared review contracts, cache tests, and renderer review replacement handling. Out of scope: SQLite, webhooks, mirror fetches, and UI redesign.

### Steps

1. Add a versioned snapshot identity containing canonical host/repo/number, base ref and OID, head OID, effective comparison/base metadata, patch source, and format epoch. Migrate or quarantine old entries. Verify retargeted PRs cannot hit the old patch.
2. Treat metadata/diff/files as a provisional flight. Capture identity, validate after collection, and discard/retry once when head/base changes. These checks detect movement but do not prove independently fetched mutable endpoints are an atomic snapshot. If provenance cannot be verified, retain provisional/incomplete status and gate snapshot-dependent writes. Verify fake transports changing revisions mid-flight produce no reusable mixed snapshot.
3. Replace background `replace` with `revisionAvailable`; only explicit refresh adopts a new frozen snapshot. Keep local drafts and agent context attached to the old world. Verify force-push notification does not change `baseOid`/`headOid` until refresh.
4. Paginate threads, nested comments, and reviews. Carry `complete`, cursor, and partial-error state. Publish contiguous completed pages; enforce response-byte and page budgets. Verify 101 threads, 51 replies, 51 reviews, deleted nodes, failure, and cancellation.
5. Extend `sameConversation` to compare path, start line, side, coordinates, edits, and all render-affecting fields. Verify coordinate-only changes update anchors.

### Done criteria

- [ ] No cache entry is reusable without matching full snapshot identity.
- [ ] Frozen tab remains frozen across background revalidation.
- [ ] Paginated fixtures retain every bounded page or explicitly show incomplete state.
- [ ] `bun test` covers retarget, force-push, mixed-flight, pagination, cancellation, and coordinate updates.

### Stop conditions

Stop if GitHub cannot provide a stable identity for a requested page, or if changing replacement semantics would break an undocumented public contract.

## Phase 3: Add account-scoped cached GitHub reads and shared flights

### Status

- Priority: P1; Effort: L; Risk: MED; Depends on: Phase 2; Category: perf/reliability; Planned at: `f5ee11e`, 2026-09-14.

### Why this matters

`usePullRequestConversation` polls every 30 seconds and `repository.ts:2274-2300` spawns an uncached GraphQL command. Renderer cancellation only suppresses adoption; it does not cancel the subprocess. Two worktrees can repeat the same request, and a transient failure currently replaces useful content with an unavailable empty result.

### Scope

Use the existing RepositoryService IPC contract first. Add a main-owned review flight/cache module, tests, and renderer status fields. SQLite is optional only after measuring the bounded file cache; do not make SQLite a startup dependency.

### Steps

1. Define cache identity as `(host, verified accountId, authEpoch, repo, number, slice, snapshot identity)`. Include schema version, fetched/attempted times, completeness, byte limits, and stale/error status. Clear validators and reject late results on account/token generation change.
2. Coalesce reads by key. Track subscribers; one detaching subscriber must not abort a shared flight, while the last detachment may abort. Promote foreground opens ahead of background polls. Verify two subscribers create one command and account changes cannot expose old private data.
3. Use slice TTLs as freshness policy, not proof: visible summary 30s, conversation 60s, checks 15–30s pending and 120s complete as starting values. Same-SHA CI reruns invalidate checks. Respect Retry-After, primary reset, and secondary cooldowns.
4. Persist only successful bounded snapshots with atomic writes. Preserve last-good content on failure and expose stale/error metadata. Verify offline poll keeps visible threads and reconnect replaces them.
5. Keep local PR list, branches, history, remotes, and ahead/behind independent from GitHub latency (`repository.ts:2459-2482`). Verify delayed or missing `gh` does not block local panels.

### Done criteria

- [ ] Warm valid reads avoid duplicate GraphQL/subprocess work.
- [ ] Hidden/snoozed views perform no periodic detail reads.
- [ ] Last-good conversation remains visible during outages.
- [ ] Account switch invalidates flights, ETags, and private cache namespace.

## Phase 4: Remove launch and local-folder latency from the critical path

### Status

- Priority: P1; Effort: M; Risk: MED; Depends on: Phase 1; Category: perf/reliability; Planned at: `f5ee11e`, 2026-09-14.

### Evidence

`src/main/index.ts:1255-1265` loads the complete workspace cache before `createMainWindow`; `workspaceCacheStore.ts:19-21` synchronously parses up to 25,000 paths. `index.ts:1283` starts folder catalog scanning on every ready. External review delivery uses mutable globals at `:235-246`, so overlapping Cmd+H requests can publish a URL with the wrong root.

### Steps

1. Split a tiny launch manifest (theme, restore decision, last root, pending review hint) from heavy path/file cache. Read only the manifest before window creation; hydrate heavy cache asynchronously through the existing restore promise. Preserve cached useful paint and generation checks. Verify max, corrupt, missing-root, and external-review fixtures.
2. Defer folder catalog scan until after useful paint or picker demand. Serve a bounded persisted stale catalog, cancel superseded scans, and invalidate on approved-root changes. Verify newly created/deleted folders and slow roots.
3. Carry external review requests as immutable `{requestId,url,root}` objects. Apply a latest-request-wins generation guard (or document multi-tab semantics) and ignore late root-resolution results. Verify A/B completion orders, timeout then late success, queued cold launches, and renderer loading.
4. Measure Cmd+H from receipt to first PR metadata and first file. Do not add static renderer imports; preserve `check:entry` budgets.

### Done criteria

- [ ] Window creation and first shell paint do not parse the full workspace cache.
- [ ] Folder catalog work cannot delay a PR open.
- [ ] Concurrent external requests cannot cross URL/root identity.
- [ ] Startup and open-folder probes improve or remain within recorded p95 budgets.

## Phase 5: Add main-owned snooze, sleep, and resource lifecycle

### Status

- Priority: P1; Effort: L; Risk: HIGH; Depends on: Phases 1 and 4; Category: perf/reliability; Planned at: `f5ee11e`, 2026-09-14.

### Evidence

Viewer release already occurs after five hidden minutes or one minute at high memory (`useViewerSuspension.ts:6-16`). Inactive sessions can pause watchers, but hidden active repositories retain recursive handles and pending paths (`repositoryWatcher.ts:178-183,222-229`). Clipboard warmup reads every two seconds (`index.ts:288-297`) and cooldown maps grow without eviction. No main-owned suspend/resume coordinator exists.

### Steps

1. Add lifecycle states visible, hidden-grace, snoozed, restoring. Main owns elapsed hidden time. Pause clipboard warmup, background polls, catalog scans, and unclaimed speculative flights when hidden/snoozed; never cancel active terminal, agent, mutation, or unsaved editor work.
2. On snooze, close watcher handles and replace unbounded paths with `needsFullRefresh` plus a bounded counter. On resume, rearm once and perform one authoritative refresh. Add OS suspend/resume and lock/unlock inputs using Electron power APIs. Verify 100,000 hidden file events, renderer crash, sleep during refresh, and deleted checkout.
3. Expire warmup cooldown entries and start clipboard polling only while an eligible window is visible; focus performs one read. Verify ten hidden idle minutes produce zero clipboard ticks and zero warmup commands.
4. Add resource accounting and only then prototype deep renderer hibernation. Do not destroy state when unsaved edits, terminal jobs, agent turns, mutations, or active review requests exist. Persist a resumable descriptor before destruction.

### Done criteria

- [ ] Hidden idle CPU, wakeups, watcher handles, pending paths, and network reads meet explicit budgets.
- [ ] Resume refreshes once and produces a correct final snapshot.
- [ ] Deep hibernation has measured RSS savings and a bounded resume penalty.

## Phase 6: Bound renderer retention and stream large reviews

### Status

- Priority: P1; Effort: L; Risk: MED; Depends on: Phases 1 and 2; Category: perf; Planned at: `f5ee11e`, 2026-09-14.

### Evidence

`useReviewWorlds.ts:328-334` skips eviction for local branch/commit and loading worlds. `useReviewSession.ts:41,58` keeps a session-memory map with no production bound. Patch parsing remains synchronous in `useReviewLoadState.ts:252-300` and `reviewItems.ts:179`. Files pagination waits for a complete concurrency wave (`repository.ts:3292`), while page concurrency is eight (`patchBuilder.ts:21`).

### Steps

1. Add explicit byte, item, and age budgets to session/world retention. First add immutable reload descriptors for local branch/commit worlds and prove restoration of selection, scroll, and persisted drafts. Do not simply remove existing skip guards. Loading worlds need backpressure or explicit cancellable/restartable ownership before any eviction. Never evict unsaved edits, pending mutations, or the focused world. Verify last-three viewer behavior remains intact.
2. Parsing is already incremental. Profile parse duration, ordering/merge cost, and allocations first. If tasks exceed 50 ms, prototype chunking or a worker; include structured-clone/transfer cost and peak memory in the comparison. Keep the current path if the prototype does not improve end-to-end latency. Preserve stable file order and cancellation. Verify first file and input latency for 300/1000/3000-file fixtures.
3. Replace wave waits with a bounded sliding queue. Bound out-of-order page bytes, publish completed contiguous pages, prioritize page one, stop from trustworthy counts, and benchmark concurrency 2/4/8. Carry cancellation, partial-failure, and generation state. Verify a delayed page eight does not block page one or allow unbounded buffering.
4. Add memory snapshots before open, after first file, complete review, close, and 30-minute hidden state. Record renderer private memory and retained world/cache bytes.

### Done criteria

- [ ] The session-memory cache and eligible inactive world payloads enforce documented byte/entry limits; protected unsaved state is accounted separately and never silently discarded.
- [ ] First file and input readiness improve for large reviews without changing coordinates.
- [ ] Peak and retained RSS are lower or unchanged for small reviews.

## Phase 7: Make subprocesses, persistence, and mutations recoverable

### Status

- Priority: P1; Effort: L; Risk: HIGH; Depends on: Phases 2 and 3; Category: reliability; Planned at: `f5ee11e`, 2026-09-14.

### Evidence

`src/main/gitCommands.ts:425-455` can hold a semaphore slot indefinitely when a child stalls. `sessionStore.ts:116-123` overwrites session JSON directly while workspace cache uses atomic rename. Mutation behavior currently treats a failed comment as a toast, but a timeout cannot prove whether GitHub accepted it.

### Steps

1. Add operation-specific queue and execution deadlines, owner cancellation, escalation, and telemetry. On ambiguous mutation outcomes, use `outcome-unknown`; reconcile before offering resend. Verify hanging, oversized, late-exit, and cancellation fixtures release slots and do not publish stale output.
2. Reuse atomic temp+rename persistence for sessions and window state, with serialized newest-state writes and corrupt-file quarantine. Verify failed write/rename and interrupted shutdown preserve the last valid state.
3. Implement mutation states `queued → sending → outcome-unknown|refreshing → confirmed|failed`. Serialize per PR, keep global one-second spacing, never auto-retry non-idempotent POSTs, and revalidate expected head/base and permissions before sensitive writes. Verify one remote comment after timeout/reconcile and merge refusal after retarget.
4. Add Raycast timing for fallback URL parsing, clipboard, process detection, open, main receipt, reveal, and first file. Parse valid fallback text before reading clipboard; retain delivery-before-close semantics.

### Done criteria

- [ ] A stalled child cannot permanently occupy a command lane.
- [ ] Interrupted writes preserve the previous valid session via atomic replacement. Document separately whether fsync-based power-loss durability is required; rename alone does not guarantee it.
- [ ] Ambiguous mutations cannot be silently duplicated.
- [ ] Raycast warm and cold handoffs have p50/p95 evidence.


## Audit coverage and limits

The audit inspected startup, main-process services, GitHub requests, sessions, watchers, file/folder pipelines, renderer review retention, palette/viewer boot, Raycast handoff, and benchmark scripts. The renderer subagent stopped before a final report; the session-memory map, local-world eviction exception, and synchronous incremental parsing were subsequently checked directly. This is a targeted source audit, not an exhaustive security audit, dependency vulnerability scan, or a measured claim that every synchronous operation is a bottleneck.
