# Kodi plans

## Completed: plan 001 (Codiff parity, Guide, review tooling)

Done 2026-10-08 and removed; the code, the e2e suites (`slow-read`, `review-guide`, `generated-files`, `definition-navigation`, `agent-chat`, `review-find`) and AGENTS.md now describe it. It delivered compositor-thread slow scrolling, structured agent runs, the review Guide (Diff | Guide, sections as steps, `--guide-file`, `kodi pr N`), find across the review, generated-file folding via `.gitattributes`, open in external editor, comments as Markdown and Ask agent, commit message suggestion, and ⌘-click definitions.

Deviations kept on purpose: Claude structured runs allow `maxTurns: 4`; Codex structured runs use their own tool-less `app-server` (`CODEX_TOOLLESS_CONFIG`); the window pulls a CLI target (`takeExternalTarget`) rather than main pushing it; the commit title's 72 characters are enforced by the normaliser; definition results from a pull-request or commit review come from the working tree; Find's ⌘G / ⇧⌘G win over ⇧⌘G (Guide) while the find bar is open.

### Considered and rejected (do not re-audit)

- One native window per repository: tabs/worlds with retained viewers are the design.
- GitLab via `glab`, OpenCode / Pi backends, a sharing web service, an auto-updater: no demand or out of scope (review kinds and `AgentProvider` stay open for them).
- A status-poll watcher, three highlight workers / a 20k tokenize limit: the `fs.watch` watcher and one worker with a 2k limit are deliberate (`scroll-under-writes`, `large-worktree`).
- A JSONC config file with live reload: Settings + `localStorage` is the one source of truth.
- A plan document editor, auto-copying comments on close, pre-starting the repository read before `loadURL`.
- Linear's Activity tab, risk scores and syntax-aware intra-line highlighting; section prose scrolling beside its files (the walkthrough column keeps scrolling on the compositor).
- Login-shell environment capture for spawned CLIs: only if "works in Terminal, not from Dock" is reported.

### Maintenance

- Guide schema is version 1: a change to the schema, hunk-id grammar or category rules bumps `GUIDE_SCHEMA.version` and `guideCacheKey`'s `schemaVersion` and updates `format.md`; normalisation accepts the previous version for one release.
- After bumping `@pierre/diffs`, re-run `review-guide`, `review-find` and `palette-navigation`.
- If guide token cost draws complaints, flip "Generate guides" to off; the 400-hunk / 120-file guards and the fingerprint cache keep repeat opens free.

## Earlier program documents

Current implementation and follow-up documents:

| Document | Purpose | Status |
| --- | --- | --- |
| [Performance and reliability follow-up](performance-and-reliability-follow-up.md) | Audit at `c23562a`, 2026-09-15: remaining correctness, retention, lifecycle, local latency, and benchmark acceptance work. Start here for further implementation. | TODO |
| [Performance and reliability](performance-and-reliability.md) | Original program and acceptance targets. Implementation exists, but the follow-up identifies unmet criteria. | PARTIALLY IMPLEMENTED / NOT FULLY ACCEPTED |
| [Performance report](performance-report.md) | Historical before/after observations. See the follow-up's measurement interpretation before using these as acceptance evidence. | HISTORICAL |
| [GitHub architecture](grok-github-fast.md) | Supporting design for social-state caching, freshness, optional SQLite and mirrors, and mutation handling. | PROPOSED |

The seven numbered drafts are now phases of the implementation program. The older [HTML diagrams](grok-github-fast.html) are historical and are not authoritative for the revised design.

Preserve existing improvements: lazy viewer/highlighter loading, the pre-mount budget, persistent git cat-file, isolated palette search, inactive watcher pause, and hidden viewer release. Earlier implementation plans were removed before this audit.

Future app changes must pass repository gates and end with `bun run update:mac`. This consolidation changes documentation only.
