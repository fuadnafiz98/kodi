# Kodi plans

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
