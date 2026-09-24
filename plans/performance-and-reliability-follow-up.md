# Kodi performance and reliability follow-up

Status: proposed after follow-up audit. Planned at `c23562a`, 2026-09-15. Source was clean when this audit started. This document supersedes any interpretation that the original program is fully accepted; it preserves that program's performance and correctness targets.

## Verdict

The previous implementation does not satisfy every acceptance criterion. Several improvements are present, but ordinary review eviction can violate frozen snapshot identity, conversation persistence and refresh have correctness defects, and the benchmark harness cannot yet support all of the performance conclusions in the previous report.

This is an implementation handoff, not a claim that the changes below have been made. Existing measurements are historical observations. No new before/after speed or memory measurements were made for this audit.

## Execution contract

- Compare the current source with `c23562a` and the cited symbols before changing it. Preserve unrelated work.
- Keep the diff-first review model, immutable review identities, persisted drafts, and last-three viewer behavior.
- Keep pre-mount JavaScript below 1,403,000 bytes and the entry closure below 65,536 bytes. Do not add static imports to boot for optional surfaces.
- Each phase needs focused regression tests before implementation, then the full gates: `bun run lint`, `bun run lint:css`, `bun run typecheck`, `bun test`, `bun run build`, `bun run check:entry`. All must exit zero.
- App changes must end with `bun run update:mac`. Run packaged verification with `KODI_PROBE_HIDDEN=1`; lifecycle probes must preserve production throttling. Leave Kodi closed afterward.
- Use deterministic local fixtures and a controlled GitHub transport. No remote PR creation or remote writes are required for fault tests.
- Do not commit, push, publish, or change unrelated dependency or UI behavior as part of these phases.

## Ranked findings

| ID | Finding | Priority | Effort | Fix risk | Confidence |
| --- | --- | --- | --- | --- | --- |
| R1 | Released GitHub reviews reload through a mutable URL | P0 | M | High | High |
| R2 | Merge checks use the disk index and run before queue admission | P0 | M | High | High |
| R13 | Storage eviction treats unsaved drafts and comments as disposable cache | P0 | M | High | High |
| R3 | Patch-cache sweep deletes persisted conversations | P1 | S | Low | High |
| R4 | Conversation pagination restarts completed connections | P1 | M | Medium | High |
| R5 | Successful mutations and manual refresh can return the old TTL cache | P1 | M | Low | High |
| R6 | Unknown mutation outcomes permit duplicate resend | P1 | L | Medium | High |
| R7 | Conversation flights lack cancellation and shared auth-generation ownership | P1 | L | Medium | High |
| R8 | Completed file pages can accumulate behind a slow earlier page | P1 | M | Medium | High |
| R9 | Benchmark failures, cache states, and attribution are insufficiently controlled | P1 | L | Low | High |
| R10 | Lock/sleep state is conflated with window visibility | P1 | M | Medium | High |
| R11 | Media limits apply after full allocation | P1 | M | Low | High |
| R12 | Subprocess cancellation has no explicit escalation or confirmed-exit accounting | P1 | M | Medium | High for missing mechanism |
| R14 | Local Git panels still wait for GitHub | P1 | M | Medium | High |

## Phase 1: Restore the exact frozen snapshot

Priority P0; effort M; risk HIGH. Scope: `src/main/repository.ts`, `src/shared/contracts.ts`, `src/preload/index.ts`, `src/main/index.ts`, `src/renderer/src/git/useGitWorkflow.ts`, related review tests. No changes to draft identity or automatic revision adoption policy.

### Evidence and impact

`useGitWorkflow.ts:604–627` restores an evicted GitHub world with `openPullRequestReview(world.review.pullRequest.url, ...)`. The Since restoration at lines 640–648 also fetches by URL. `repository.ts:3237–3242` consumes a pending revision-refresh marker or opens the latest URL index. Consequently, returning to an evicted tab can adopt a force-push without explicit refresh. Since can combine new patch bytes with its old changed-path filter and identity.

The relevant current expression is `this.#reviewsRequiringRefresh.delete(normalizedSelector)`. It does not distinguish restoration from user-requested refresh.

### Implementation steps

1. Add an immutable restore request carrying the complete stored snapshot identity, root, and request ID. Keep explicit refresh a distinct operation. Follow the existing typed preload/IPC pattern; validate payloads in main. Verify with `bun run typecheck`.
2. Read the cache by full identity, never by latest URL index, for restore. If unavailable, reconstruct only from verifiable immutable objects; otherwise return an explicit unavailable-snapshot result. Never silently fall back to latest. Verify with `bun test src/main/repository.test.ts`.
3. Restore Since from its parent's exact identity and preserve its filter, selection, scroll, comments, and viewed signatures. Route tab focus, close-to-next-tab, and eventual hibernation wake through the same restoration coordinator. Verify with `bun test src/renderer/src/git/useGitWorkflow.dom.test.tsx src/renderer/src/review/useReviewWorlds.test.ts`.
4. Add a transport fixture: open revision A, announce B, evict A, focus A, and compare OIDs and patch contents. Repeat after deleting A's cache, after base retarget, and for a released Since parent. Expected: A stays A or reports unavailable; only explicit refresh adopts B.
5. Characterize fresh-flight provenance as well as restoration. `repository.ts:3401` starts the mutable diff request before metadata is captured; lines 3517–3520 compare later metadata with that capture. This detects some movement but cannot prove that an earlier diff belongs to the captured revision. Carry provisional/validated/unavailable status explicitly, test movement between diff start and metadata capture, and gate snapshot-dependent writes on the proven status. A matching pair of metadata reads alone must not be described as atomic endpoint consistency.

Done: every restoration test passes; no restore path adopts a latest URL revision; draft/scroll/selection tests pass; full gates pass. Stop if an old snapshot cannot be reconstructed: preserve the descriptor and report unavailability. Do not solve the problem by changing the meaning of a frozen tab.

## Phase 2: Validate and reconcile remote writes

Priority P0/P1; effort L; risk HIGH. Depends on Phase 1's identity contract. Scope: repository mutation methods, shared/preload IPC contracts, Git workflow and conversation action hooks, focused tests. No actual GitHub mutations during automated verification.

### Evidence and impact

`repository.ts:2656–2683` queries base/head, compares the latest disk index, then queues `gh pr merge` without an expected-head argument. The selected world's snapshot is not part of this API. The global queue at lines 483–490 can delay sending after validation. Another world can update the index, or the remote can change while the merge waits.

`runGitHubMutation` at lines 491–495 converts one timeout string to advice to refresh. It stores no unresolved operation. The renderer clears pending state after failure and permits resend. Acceptance followed by timeout or connection loss can therefore produce a duplicate comment.

### Implementation steps

1. Pass the selected world's expected snapshot to sensitive writes. Revalidate it inside the queued callback immediately before sending; check permissions there. Use the server-supported expected-head merge guard. Treat base validation as a separate check and document any remaining server-side race instead of claiming atomic protection. Verify with `bun run typecheck`.
2. Replace the bare global promise tail with per-PR ordering plus shared one-second admission spacing. Record bounded queued/sending/outcome-unknown/refreshing/confirmed/failed operations. Define queue expiry separately from execution expiry. Verify with new mutation service tests using an injected clock and transport.
3. For ambiguous outcomes, preserve the submitted draft and operation identity, force a fresh read, and reconcile against returned remote identifiers/content/author/revision. Do not auto-retry a non-idempotent POST. If reconciliation remains ambiguous, expose that state and require a deliberate duplicate-risk decision before resend.
4. Test acceptance then timeout, acceptance then connection reset, rejection before send, account change while queued, head/base movement while queued, and a second world's changed index. Expected: zero stale merges and exactly one accepted comment in recoverable timeout cases.

Done: `bun test` includes these state transitions; writes cannot authorize themselves from a newer disk index; no unresolved operation silently becomes resendable; full gates pass. Stop if the service cannot distinguish an accepted operation from an absent operation; preserve uncertainty rather than guess. Review future mutation additions against the same coordinator.

## Phase 3: Repair conversation storage, pagination, and freshness

Priority P1; effort M; risk MEDIUM. Scope: `src/main/repository.ts`, conversation IPC and renderer hook, cache and conversation tests. Existing parse tests in `repository.test.ts` are the structural starting point; add service-level transport tests.

### Evidence and impact

- `repository.ts:2464` writes `conversation-<hash>.json` beside patch metadata. `sweep()` at lines 1437–1459 treats all non-index JSON as patch metadata and deletes it when the companion `.patch` is absent. A patch write can delete the conversation's disk fallback.
- Lines 2513–2519 turn an exhausted cursor into `null` while continuing the other connection. Null starts that connection again. Two versus three pages can cycle until the budget and incorrectly report incomplete data.
- Lines 2527 and 2557–2574 infer nested pagination from parsed comment count and refetch the initial comments page. Preserve the actual connection cursor instead; deleted/filtered nodes must not determine continuation.
- Lines 2395–2396 return fresh TTL entries. Reply/resolve do not invalidate them, while `usePullRequestConversation.ts:210` merely repeats the same read. Manual refresh likewise has no freshness override.

### Implementation steps

1. Separate conversation and patch namespaces. Add independent disk count, age, and byte budgets, plus size checks before reading/parsing persisted files. Test conversation write → patch sweep → process-like cache reload. Verify with `bun test src/main/repository.test.ts`.
2. Track connection completion separately from its cursor. Stop querying a completed connection. Preserve nested `pageInfo`, count every request, enforce byte/page budgets before accumulation, and return explicit partial state for malformed cursors or failed pages. Test 0/100/101 threads, unequal 2/3-page connections, 51 reviews/replies, more than 100 nested comments, deleted nodes, and mid-page failure.
3. Add explicit force-refresh and successful-write invalidation keyed to the affected PR. Concurrent forced reads should still share one request. Prevent an older read from overwriting a post-mutation result. Verify reply → refresh and resolve → refresh with a populated cache and a delayed older flight.
4. Preserve last-good content when identity lookup, executable resolution, or a refresh fails, subject to verified account boundaries. Surface stale and partial states in the view. Verify offline/reconnect and partial-failure tests.

Done: no connection restarts after completion; no duplicate first-page fetch to rediscover its cursor; disk conversations survive patch sweeps; manual refresh bypasses TTL; successful writes become visible immediately after confirmation; full gates pass.

## Phase 4: Own GitHub read lifetimes and account generations

Priority P1; effort L; risk MEDIUM. Depends on Phase 3. Scope: a main-owned GitHub read/auth module extracted from repository service, repository callers, IPC subscription contract, renderer conversation hook and tests.

`repository.ts:2398–2424` coalesces a bare promise. Pagination at lines 2489–2500 and 2558–2566 passes no cancellation signal and uses the interactive lane. Renderer cleanup only suppresses adoption. Account ID/epoch at lines 3810–3824 is service-local and cached for 60 seconds, whereas flights/cache are global. Completion at line 2405 has no auth-generation check.

1. Centralize verified account identity and generation. Capture it for each flight and reject late results after a generation change. Define how external CLI account changes and same-account credential changes are detected; never persist credential values. Verify with deterministic two-worktree/account-switch tests.
2. Add subscriber tokens and detach cancellation. One detachment must preserve another subscriber; final detachment must abort owned subprocesses. Background polls use background capacity; a foreground subscriber promotes pending work. Verify with two-consumer and last-consumer tests.
3. Make snooze/lock stop periodic reads and unclaimed speculation in main, while protecting user writes, terminals, and agents. Add host/account cooldown handling from actual rate-limit responses; arbitrary TTLs do not satisfy Retry-After. Test snooze during slow pagination and rate-limit expiry with a fake clock.
4. Bound cache bytes and outstanding flight count as well as entry count. Record cache hits, shared joins, bytes, subprocess counts, cancellation latency, and late-result rejection counts.

Done: no old-generation result is published; one request serves concurrent valid consumers; zero unclaimed reads remain after snooze cancellation settles; account changes invalidate permissions and private cache access consistently; full gates pass.

## Phase 5: Bound large-review buffers and subprocess lifetime

Priority P1; effort M; risk MEDIUM. Scope: `repository.ts` files collector, `gitCommands.ts`, their tests, performance instrumentation. Preserve stable order and first-page priority.

`repository.ts:3680–3705` limits only the in-flight map to four. Completed pages behind a slow earlier page do not count toward admission. Almost all pages can accumulate. Failure also lacks explicit sibling abort/drain. `gitCommands.ts:505–535` delegates abort to `execFile` with no termination escalation or confirmed process-tree exit. Releasing a semaphore is not proof that a resistant child exited.

1. Add a scheduling window relative to `nextToPublish` and a response-byte cap. Charge completed and in-flight allowances together. Stop from trustworthy counts and abort/drain siblings on failure. Test delayed page one, delayed page eight, large page bodies, early terminal pages, cancellation, and a rejected sibling.
2. Benchmark concurrency 2/4/8 against identical deterministic fixtures after Phase 7 establishes valid measurement. Select the lowest resource cost meeting first-file/input latency targets; do not hardcode four as a proven optimum.
3. Add bounded termination escalation and explicit exit tracking for Kodi-owned children. Handle descendant pipes and process identity safely on each supported platform. Test a child that ignores graceful termination and a child that leaves a descendant. Assert both lane recovery and actual process disappearance.
4. Record queue wait, execution duration, live child peak, output bytes, and abort-to-exit latency. Keep timings out of the boot import closure.

Done: buffer cap holds under an adversarial completion order; every owned process exits within the documented abort grace; no unhandled sibling rejection; large fixtures preserve file coordinates and order; full gates pass.

## Phase 6: Separate lifecycle inputs and repair experimental wake

Priority P1 for lifecycle; P2 for hibernation; effort M/L; risk HIGH for state restoration. Scope: main lifecycle coordinator, repository sessions, renderer hibernation/wake handling, lifecycle tests/probes. Deep hibernation remains disabled by default pending its acceptance gate.

`index.ts:389–422` uses window visibility as the deciding input. `lock-screen` at line 1481 only requests hidden grace. At grace expiry an OS-visible window changes state back to visible, even while locked. That branch does not restart clipboard polling; a later unlock can return early because state already says visible. Track lock and sleep independently from renderer and window visibility.

The existing report also records two hibernated samples timing out on wake. `hibernateWorldPayloads` releases the focused review (`useReviewWorlds.ts:351–359`); restoration is called by focus/close actions (`useGitWorkflow.ts:604–669`), not by a complete wake handshake.

1. Extract a testable main coordinator with explicit locked, suspended, window-visible, and renderer-ready inputs. Reconcile resources idempotently from effective state. Verify visible-window lock → snooze → unlock, resume while locked, hide/show during grace, and renderer crash with fake time.
2. Add an acknowledged wake request that restores the focused descriptor through Phase 1, waits for usable content, then marks wake complete. Protect dirty editors, unsaved comments, terminal jobs, agent turns, pending writes, and active loads. Test each veto and failure path.
3. Run packaged lifecycle probes with production throttling and a fixed viewport. Check zero watchers, pending paths, clipboard ticks, and detail requests throughout a ten-minute interval; one authoritative refresh on resume. Include active conversations and filesystem events, not only an idle folder.
4. Compare hibernation to snooze from the same loaded review using paired runs. Measure total physical footprint and renderer private memory separately. Record natural collection and forced collection separately. Enable only after at least 20% total physical-footprint savings and p95 additional wake cost ≤250 ms with zero restore failures in at least 30 cycles.

Done: lock state cannot be overridden by renderer visibility; resource ownership survives every transition; wake restores exact content/drafts; optional hibernation remains off if it misses its bar. Abandoning deep hibernation is acceptable if the measured benefit is too small.

## Phase 7: Make benchmarks capable of accepting or rejecting a change

Priority P1; effort L; risk LOW. This phase can start first and must finish before accepting performance claims from Phases 4–6. Scope: `scripts/perf/`, `scripts/benchmark-memory.sh`, isolated fixture support, benchmark documentation, CI. Never clear the user's real cache or modify their repository to manufacture a sample.

### Confirmed evidence gaps

- `run-matrix.sh` continues when its load wait expires and catches memory/lifecycle failures without an aggregate failing exit status. `run-pr-matrix.sh:49–53` ignores warmup failure and converts failed recorded pipelines into an echo.
- `pr-open-probe.mjs:115–124` restarts the process but keeps its disk cache. Matrix warmup seeds that cache. `repository.ts:3240` serves it before revalidation. These samples measure process-cold cached replay, and cannot establish an improvement in fresh network pagination.
- `cdp.mjs:416–438` records app path and end-of-run load, but no binary hash, source revision, fixture revision, actual cache hit/miss, or interval-wide load. `compare.mjs:93–102` prints comparisons without checking compatibility.
- `idle-cpu-probe.mjs:82–99` subtracts CPU totals for processes alive at the endpoints. Children that start and exit between endpoints are absent; different PID sets can distort subtraction. Two equal endpoint states do not prove uninterrupted snooze.
- The manifest's 3,000-file fixture is a declaration, not an executed deterministic fixture. The previous report's lack of a public PR does not prevent local fixture testing.

### Implementation steps

1. Create a schema shared by all probes: attempt ID, explicit outcome, timeout bound, raw timing origins, binary hash, source/fixture revisions, viewport, OS/hardware/power, process mode, actual cache state, and load samples across the run. Preserve every attempted sample. Separate unavailable instrumentation from failed behavior. Verify schema tests with missing metrics and mismatched builds.
2. Give matrix runners an aggregate nonzero exit on failure. Allow an explicit baseline-compatibility mode, but never turn missing baseline instrumentation into a product failure. Abort or invalidate runs outside machine-load conditions. Add shell harness tests with injected failing child commands.
3. Add deterministic fake-gh fixtures at the subprocess boundary for 1/30/300/1000/3000 files, 0/100/101 threads, nested replies, delays, account changes, retarget, force-push, cancellation, and accepted-then-timeout writes. Use isolated app profiles and explicit warm/cold Kodi caches. Verify the production parser, IPC, and renderer are exercised.
4. Measure process start → paint separately from user input → first metadata/file/tokenized viewport/interactive input and validated completion. Assert actual content and file counts in a fixed nonzero viewport; DOM presence alone is insufficient. Keep a live read-only PR smoke check as a separate network experiment.
5. Alternate baseline/post blocks on the same machine, with two warmups and ≥30 recorded attempts per ordinary scenario. Compare matching fixtures/cache states/build hashes. Report p50/p95/max, timeout and failure rate, uncertainty, and raw samples. Treat noisy results as inconclusive; do not claim the absence of regression from noisy data.
6. Account for exited child CPU through process-lifecycle telemetry and resource usage, and validate with a short-lived CPU-consuming fixture. Record watcher/clipboard/network counters across the interval. Measure memory before open, first file, completion, close, and 30 minutes hidden, including world/cache bytes and physical footprint.
7. Add a macOS packaged smoke job or reproducible local release gate for restoration, snooze/resume, and critical review flows. Existing Linux CI verifies source/build but cannot certify macOS packaged behavior. Keep slow performance runs separate from fast deterministic correctness gates.

Done: intentionally failed probes fail the matrix; incompatible artifacts cannot receive a pass; all fixture buckets execute; cold-cache tests demonstrate misses and warm-cache tests demonstrate hits; no success percentile suppresses timeout evidence; acceptance uses ≤5% p95/retained-footprint regression on unaffected scenarios and ≥10% target-cost improvement or a stated correctness gain.

## Phase 8: Bound media downloads before allocating them

Priority P1; effort M; risk LOW. Scope: `src/main/avatars.ts`, `src/main/markdownMedia.ts`, their tests, and a narrowly shared bounded-download helper.

`avatars.ts:26–27` and `markdownMedia.ts:33–35` call `arrayBuffer()` before testing 256 KiB/48 MiB limits. Neither fetch has a deadline or caller cancellation. Oversized or stalled responses therefore consume memory/time before the guard acts. Avatar cache clearing at its count cap also drops every entry at once and can trigger refetch bursts.

1. Validate Content-Length when present, then stream and enforce an authoritative cumulative byte cap even without that header. Abort on overflow, timeout, or consumer cancellation. Verify streamed over-limit and indefinitely stalled fixtures.
2. Bound parallel downloads and total reserved/retained bytes. Avoid unnecessary Buffer/Uint8Array/base64 copies, measuring peak allocation before deciding representation changes. Replace whole-cache clear with bounded eviction and short failure expiry.
3. Test malformed type, missing length, oversized streaming body, cancellation, repeated URL coalescing, and retry after transient failure. Verify with `bun test src/main/avatars.test.ts src/main/markdownMedia.test.ts`, then full gates.

Done: the downloader stops reading at its budget; all requests have bounded lifetime; repeated failures do not poison the cache for the session; measured peak bytes stay within the documented aggregate budget.

## Phase 9: Protect user-authored state from cache eviction

Priority P0; effort M; risk HIGH. Run before expanding retention or enabling hibernation. Scope: `src/renderer/src/review/storageBudget.ts`, `reviewThreadStorage.ts`, `useReviewSession.ts`, `src/renderer/src/editor/draftStore.ts`, and their tests. Add main-owned durable draft storage only if required by the selected design; preserve existing keys through a tested migration.

`storageBudget.ts:4–9` manages viewed marks, review comments, checkpoints, and editor drafts in one pool. Lines 119–132 evict every old key except the current write's key. `draftStore.ts:118` puts unsaved drafts into that pool. Saving viewed state in one review can therefore remove another project's unsaved draft or unpublished comments. The removal result is not surfaced to the caller. `useReviewSession.ts:134–142` also ignores failed saves during identity changes, while its bounded memory map can later evict the fallback copy.

1. Distinguish regenerable cache from user-authored state. Never evict the only copy of a dirty draft or unpublished comment to meet a cache target. Report protected bytes separately from evictable bytes. Add tests with dirty projects A/B and a new viewed-state write C under a deliberately small budget.
2. Reserve the incoming write's size before cache eviction. Current `persistManagedValue` enforces the previous index total before inserting the new value, so the nominal cap can be exceeded until a later write. Define size units consistently and test Unicode payloads, growth of an existing value, and actual quota failure.
3. Propagate persistence outcomes on tab/root transitions. Preserve dirty data in a durable store or a protected memory owner until acknowledged; expose actionable persistence failure. Test failed localStorage writes, switching more than 32 review identities, reload, and session close.
4. Verify with `bun test src/renderer/src/review/storageBudget.test.ts src/renderer/src/review/reviewThreadStorage.test.ts src/renderer/src/editor/draftStore.test.ts`, then the full gates. Add a DOM test for persistence failure followed by identity switch.

Done: budget pressure cannot silently delete user-authored state; a failed save cannot become an evictable sole copy; cache accounting includes incoming data; restart preserves acknowledged drafts. Stop if preservation cannot be demonstrated; do not loosen the preservation requirement to reach a memory number.

## Phase 10: Make local Git panels independent of GitHub

Priority P1; effort M; risk MEDIUM. Scope: `src/main/repository.ts:getGitIntegration`, integration IPC contracts and renderer consumers, related tests. No redesign of branch/history UI.

`repository.ts:2759` resolves `gh` before starting local branches. Lines 2784–2792 await local branches, remotes, history, ahead/behind, and `pullRequestsPromise` in one `Promise.all`. Missing gh can reject the whole method; a slow PR-list request holds back already-computed local results. This directly leaves original Phase 3 step 5 incomplete.

1. Return or publish local integration data independently of the GitHub slice. Reuse the existing snapshot/generation conventions so a delayed response cannot update another root. Verify missing-gh and delayed-gh transport tests.
2. Give the remote list its own freshness/error status and background refresh policy. Preserve usable local data and last-good remote rows during remote failure. Verify offline and reconnect without reloading local history unnecessarily.
3. Add a packaged fixture with a 30-second remote delay. Assert branches/history become usable within the normal local-path budget and remote failure does not replace them. Report local readiness and remote completion as separate metrics.

Done: local panels pass with gh missing, slow, and offline; remote completion cannot block their initial render; no cross-root late adoption; full gates pass.

## Acceptance and reporting

Execute Phase 7 measurement foundations first or alongside Phase 1. Prioritize Phase 9's draft protection before any additional eviction. Complete Phase 1 before sensitive-write identity and hibernation restoration. Complete Phase 3 before Phase 4 and mutation reconciliation. Phase 10 can proceed independently. Measure Phase 5 only with Phase 7's controlled cache/transport.

Maintain a phase status and attach test names, exact benchmark commands, build hashes, raw artifact paths, and exceptions. A passing unit suite does not close an untested integration criterion. A disabled experimental feature is neither a production regression nor an achieved feature.

Final close-out must explicitly state which criteria passed, failed, remained inconclusive, or were intentionally rejected. Do not mark the original program fully complete until this reconciliation is done.

## Phase status and dependency order

| Execution group | Phase | Status | Dependency |
| --- | --- | --- | --- |
| First | 7: benchmark foundations | TODO | None |
| First | 9: draft preservation | TODO | None |
| First | 1: immutable restoration | TODO | None |
| Next | 3: conversation correctness | TODO | None |
| Next | 2: remote writes | TODO | 1; reconciliation uses 3 |
| Next | 4: read/auth ownership | TODO | 3 |
| Next | 5: buffers and child lifetime | TODO | 7 for performance acceptance |
| Independent | 8: bounded media | TODO | None |
| Independent | 10: local panels | TODO | None |
| Last | 6: lifecycle and experimental wake | TODO | 1, 4, 9; 7 for acceptance |

Phase numbers identify scopes; the table defines execution order. Each executor updates its row with evidence and runs the shared full gates after its changes.

## Verification performed for this audit

- `bun run lint`: passed.
- `bun run lint:css`: passed.
- `bun test src/main/gitCommands.test.ts src/main/atomicWrite.test.ts src/renderer/src/review/useReviewWorlds.test.ts scripts/perf/cdp.test.mjs`: 68 passed, zero failed. These tests do not cover all the cross-service defects above.
- `bun run check:entry`: passed against the existing build output: pre-mount 1,371,577 bytes; entry 3,307 bytes. This audit did not rebuild, so these bytes are not certified as a fresh build of HEAD.
- `bun audit --json`: returned advisories, including high-severity reports for build-tool transitive dependencies. The lockfile contains `@xmldom/xmldom` 0.8.13 (`bun.lock:454`), `fast-uri` 3.1.5 (`:730`), and `js-yaml` 4.3.1 (`:908`). `app-builder-lib`/`plist`/Ajv connect these to the build toolchain. This is dependency-maintenance evidence, not proof of a reachable application exploit. Triage the affected APIs and update compatible transitive versions in a separate verified maintenance change; do not mix a broad framework migration into the performance work.
- No source edits, installation, app launch, full suite rerun, or new runtime benchmark was performed. Only plan documents changed.

## Measurement interpretation and remaining investigations

The earlier report's raw results remain useful observations, but causal statements need correction when the new harness is implemented:

- A cached process restart does not measure fresh GitHub files pagination. Calling the large buckets network-bound is not established by these probes.
- Different machine load and repeated same-build spread demonstrate confounding; they cannot prove that a regression is absent or that a smaller difference is definitively an improvement.
- Endpoint CPU sums do not include all short-lived child work. The historical ten-minute result is an endpoint measurement, not complete process-tree accounting.
- Missing baseline lifecycle counters mean unavailable instrumentation. They do not demonstrate a failed baseline lifecycle check.
- The hibernation report measures renderer-private savings, whereas the original acceptance asks for physical-footprint savings. Use both, with a snooze control and the same loaded fixture.

Further performance work should be driven by the corrected measurements: incremental parser task duration and allocations at 300/1000/3000 files; highlight completion and input latency during scroll; active versus inactive world bytes; cold versus cached folder readiness; and queue contention while agents/terminals are active. A worker prototype is justified only if measured main-thread tasks exceed 50 ms and its transfer overhead does not erase the end-to-end gain.

## Considered and rejected

- Replacing the Electron/React stack: no evidence that a migration would address the confirmed failures more effectively than repairing ownership and measurement.
- Adding SQLite or repository mirrors now: defer until bounded cache/transport measurements demonstrate a specific need. Existing file-cache defects do not establish that SQLite is required.
- Enabling deep hibernation to advertise a memory win: rejected until wake correctness and paired physical-footprint measurements pass.
- Evicting loading worlds directly: rejected without restartable ownership and protected-state accounting. Backpressure is the safe first step.
- Treating a passing unit suite or React Doctor score as complete E2E validation: rejected; neither exercises all CLI/network/cache/lifecycle transitions.
- Treating synchronous window-bounds loading as a new defect: it is an explicitly documented constructor requirement. Profile before changing it. Debounced synchronous geometry fsync is a lower-priority measurement candidate, not a proven responsiveness regression.

## Coverage limits

The scan covered the core Git/GitHub services, snapshot/cache boundaries, renderer retention and persistence, lifecycle, subprocesses, media loading, benchmark scripts, build configuration, and CI. Agent and terminal services were checked as lifecycle dependencies, not exhaustively audited internally. This was not an exhaustive security assessment, accessibility/design review, Windows/Linux runtime test, or new statistical benchmark campaign. No claim of improvement in every metric is justified until the planned measurements run.
