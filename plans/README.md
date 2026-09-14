# Kodi plans

There are two plan documents:

| Document | Purpose | Status |
| --- | --- | --- |
| [Performance and reliability](performance-and-reliability.md) | Implementation phases for startup, Cmd+H, files/folders, PR correctness, cached reads, memory, snooze, recovery, and benchmarks. Start here. | PROPOSED |
| [GitHub architecture](grok-github-fast.md) | Supporting design for social-state caching, freshness, optional SQLite and mirrors, and mutation handling. | PROPOSED |

The seven numbered drafts are now phases of the implementation program. The older [HTML diagrams](grok-github-fast.html) are historical and are not authoritative for the revised design.

Preserve existing improvements: lazy viewer/highlighter loading, the pre-mount budget, persistent git cat-file, isolated palette search, inactive watcher pause, and hidden viewer release. Earlier implementation plans were removed before this audit.

Future app changes must pass repository gates and end with `bun run update:mac`. This consolidation changes documentation only.
