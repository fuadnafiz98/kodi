---
name: kodi
description: Hand the change you just made to Kodi as a review guide — a short, numbered walk through the diff that explains why each part exists. Use when the user asks to "open this in Kodi", "write a review guide", "walk me through the change in Kodi", or wants a reviewer-ready explanation of the diff alongside it.
---

# Open the change in Kodi with a guide

Kodi is a diff-first Git review app on this Mac. It can show a review **guide**
beside the diff: numbered sections, each saying why one part of the change
exists, with the files (or hunks) that make up that part. You know why you made
the change; a guide you write is better than one inferred from the diff alone.

Kodi validates and repairs the guide against the live diff when it opens it:
references to files or hunks the diff does not have are dropped, files you did
not mention land in automatic "Supporting" sections, and counts are recomputed.
You never paste the diff into the guide.

## Steps

1. **Read the format.** Run:

   ```bash
   kodi --guide-format
   ```

   It prints how to write the guide and the JSON schema it must satisfy. Follow
   it exactly; it is the source of truth for field names and limits.

2. **Decide what the guide describes.**
   - Default: the working tree of the repository you changed (what `git diff HEAD` shows).
   - A commit: pass its ref (a SHA, `HEAD`, a branch) as the target.
   - Never describe a pull request you did not write.

3. **Write the JSON** to a temporary file outside the repository, for example
   `$TMPDIR/kodi-guide-<short id>.json`:
   - 2–6 core sections, ordered the way a reviewer should read them: the heart
     of the change first, then its callers, then the rest.
   - Each section: a short title, a body of a few sentences on *why* (not a
     restatement of the diff), and `refs` naming the files, by repository-relative
     path, or hunks, as the format describes.
   - Leave tests, docs, generated files and lockfiles out unless they are the
     point; Kodi groups them as Supporting on its own.
   - Write it in the user's language, plainly. No marketing words.

4. **Open it:**

   ```bash
   node "<this skill's folder>/open-kodi.mjs" --file "$TMPDIR/kodi-guide-<id>.json" [target] [folder]
   ```

   `folder` defaults to the current directory. The script forwards your Claude
   Code session (`CLAUDE_SESSION_ID`) so the last messages of this conversation
   travel with the guide; a later "Regenerate" in Kodi reads them too.

5. **Tell the user** Kodi is open on the guide, in one sentence. Do not repeat
   the guide in chat.

## If something goes wrong

- `kodi: command not found` — Kodi's CLI is not on PATH. Try
  `~/Applications/Kodi.app/Contents/Resources/kodi`; if that is missing, Kodi is
  not installed — say so and stop.
- Kodi shows "The guide no longer matches the working tree" — the files changed
  (or were committed) after you wrote it. Re-read the diff and write it again.
- The JSON is rejected — re-run `kodi --guide-format` and check the field names
  against the schema; do not invent fields.
