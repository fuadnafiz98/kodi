import { GUIDE_SCHEMA } from './schema.js'

// The authoring guide an agent reads before it writes a guide file
// (`kodi --guide-format`). Kodi validates and repairs whatever comes back.
const GUIDE_FORMAT_LINES = [
  "# Kodi review guide — format",
  "",
  "A review guide walks a reviewer through a change. It is a short, numbered list of sections. Each section explains why one part of the change exists and what it affects, and names the files (or hunks) that make up that part. Kodi shows the guide beside the diff: the section being read stays pinned on the left, and the files are reordered section by section on the right. The diff is not embedded in the guide. Kodi computes the live diff, resolves your references when the guide is opened, and shows the real current diff. Write the JSON to a temporary file outside the repository and open it with `kodi --guide-file <file> [folder]`.",
  "",
  "Default to the working-tree change against HEAD (`git diff HEAD`). If the user named a target (a commit, a branch comparison, a pull request), use that, and anchor every hunk id against the diff you chose.",
  "",
  "**Shape.**",
  "- `version: 1`, `kind: \"review-guide\"`.",
  "- A `title` that says what the change does, the way a good pull request title would.",
  "- An optional `overview` of one or two sentences.",
  "- `sections[]`, in reading order.",
  "  - Put the core of the change first, as `kind: \"core\"` sections: the decision, model or policy that everything else depends on, then what exposes it (endpoints, commands, UI), then the clients.",
  "  - Use `kind: \"supporting\"` for real but lower-signal parts worth one sentence of context (a migration, a snapshot refresh, a rename sweep).",
  "  - Each section has a unique `id`, a 2–6 word `title` naming the idea (never a file name), a `body`, and `refs`.",
  "- `commit` (optional, working tree only): `title` and `body` for a commit message.",
  "",
  "**Writing the body.** Explain *why* this part exists and what behaviour it changes or protects, in 1–4 plain sentences. A reviewer should know what to check before they read the code. Lead with the behaviour, not the file: \"Scheduled rides can be edited only until the dispatch lock, and the API now says so\", not \"Updates `trip_request.rb`\". Do not narrate line by line. Do not invent bugs, risks, tests or validation; describe what the diff supports. If a pull request description is available, treat it as the author's intent, not as proof. Use plain sentences: no headings, lists or code blocks. Inline backticks for symbols, paths and flags are fine.",
  "",
  "**Refs.**",
  "- A ref is a repository-relative path (meaning the whole file) or a hunk id. Use a hunk id only when one file serves two sections.",
  "- Put a file's tests in the same section as the code they test.",
  "- Every hunk belongs to one section. If you name it twice, the first section keeps it.",
  "- Leave out what does not need explaining: generated files, lockfiles, docs-only edits, repeated mechanical changes. Kodi adds every file you did not mention to automatic \"Supporting\" sections at the end, grouped as Tests, Documentation, Agent guidance, Localization, Assets, Generated files and Other changes.",
  "- Do not provide counts, statuses or metadata. Kodi computes them.",
  "",
  "**Size.** One section for a one- or two-file change, two to four for a focused change, at most eight for anything. A section is one idea that may span several files, not a file.",
  "",
  "**Hunk id format.** `<file path>:<scope>:h<ordinal>`.",
  "- `<file path>` is repository-relative.",
  "- `<ordinal>` is the hunk's 1-based position in that file's patch.",
  "- `<scope>` is one of:",
  "  - `wt` for the working tree against HEAD;",
  "  - `pull-request:<number>` for a pull request;",
  "  - the full 40-character SHA of the head commit, for a commit or branch comparison. That is the resolved HEAD for \"current branch vs `<branch>`\", and the resolved head for `base..head`.",
  "",
  "Binary, renamed-only and generated files have exactly one hunk, `…:h1`; prefer naming them by path.",
  "",
  "**Schema.** The document must conform to the following JSON schema:"
]

export const GUIDE_FORMAT_TEXT = GUIDE_FORMAT_LINES.join('\n')

/** The format text followed by the public schema, as `kodi --guide-format` prints it. */
export function guideFormatDocument(): string {
  return `${GUIDE_FORMAT_TEXT}\n\n${JSON.stringify(GUIDE_SCHEMA, null, 2)}\n`
}
