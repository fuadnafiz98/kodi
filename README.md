# Kodi

Kodi is a local-first desktop application for exploring projects and reviewing code changes. Open a folder, browse its file tree, and inspect files in a focused diff surface. When the folder is a Git repository, the app compares the working tree with `HEAD` and shows Git status for each changed file.

## Features

- Open Git repositories and ordinary folders from a searchable picker, with the macOS folder dialog as a fallback.
- Browse a virtualized project tree with file-type icons and Git status markers.
- Review the working tree, a GitHub pull request, a local branch compare, or a single commit.
- View changes in split or unified diff, as a multi-file review or one file at a time.
- Comment locally, and reply to GitHub review threads when `gh` is authenticated.
- Edit working-tree files in place, with a project terminal and an agent dock.
- Find files quickly with fuzzy path search, and search contents with the bundled ripgrep binary.
- Restore the last folder, watched working-tree changes, and per-review viewed state.
- Customize the interface and code fonts.
- Keep filesystem and Git access in Electron’s main process behind a narrow preload API.

Git is optional. Non-Git folders open in read-only preview mode.

## Requirements

- macOS
- Bun 1.3.9 or newer
- Git, if you want Git status and diffs

## Getting started

Clone the repository, install dependencies, and start the development app:

```sh
git clone <repository-url>
cd kodi
bun install
bun run dev
```

Use the Electron window opened by `bun run dev`. The renderer URL on its own does not have access to the native folder picker or repository service.

## Raycast

The `extensions/kodi` Raycast extension opens a GitHub pull request URL in Kodi. Copying the URL, pasting it into the command, or enabling the 10-second clipboard warmer starts the review in the background so Enter does not wait on a cold fetch.

1. Install Kodi with `bun run update:mac` so the `kodi://` link is registered.
2. Run `bun run raycast:dev` (or `npm install && npm run dev` in `extensions/kodi`). Do not Import Extension on the source folder — that produces `Missing executable`.
3. Raycast will not put Kodi under **Use with...** by itself. After install, paste a PR URL, click the gear on that section, and enable **Open in Kodi** once.

See `extensions/kodi/README.md` for the commands and hotkey setup.

## Commands

| Command | Description |
| --- | --- |
| `bun run dev` | Start the branded development app |
| `bun run dev:background` | Start development without showing or focusing a window |
| `bun run update:mac` | Build and install without interrupting or opening the app |
| `bun run update:mac:open` | Build, install, and explicitly open the app |
| `bun run open:mac` | Open the installed app |
| `bun run build` | Build the main process, preload script, and renderer |
| `bun run preview` | Preview the production renderer build |
| `bun run typecheck` | Type-check Node and renderer projects |
| `bun run lint` | Lint `src` with oxlint |
| `bun test` | Run the test suite |
| `bun run verify` | Lint, type-check, test, and build in one pass |
| `bun run raycast:dev` | Register the local Kodi Raycast extension |

Run the complete local verification with:

```sh
bun run verify
```

The same four steps run in CI (`.github/workflows/ci.yml`), followed by a React
Doctor scan that fails on any diagnostic.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Command+O` | Search and open a folder |
| `Command+P` | Go to file |
| `Command+Shift+F` | Search file contents |
| `Control+J` / `Command+J` | Toggle the project terminal |
| `]` | Next file in multi-file review |
| `[` | Previous file in multi-file review |
| `V` | Toggle viewed on the current review file |
| `C` | Collapse or expand the current review file |

## Project structure

```text
src/
├── main/       Electron lifecycle, filesystem access, Git, and ripgrep
├── preload/    Typed and restricted IPC bridge
├── renderer/   React interface, explorer, search, and diff views
└── shared/     Contracts shared between Electron processes
```

The renderer does not use Node.js or access the filesystem directly. Git commands run with argument arrays and without a shell. Repository file access is limited to the folder selected by the user.

## Technical stack

- Electron
- React 19
- TypeScript
- Vite via electron-vite
- Bun and Bun Test
- `@pierre/diffs` for diff rendering
- `@pierre/trees` for the project tree
- `@vscode/ripgrep` for content search

## Current limitations

- There is one review at a time: opening a pull request replaces the working-tree view.
- Markdown files are shown as source. PR bodies and agent answers are rendered; repository documents are not.
- Text diffs are not rendered for binary files.
- Files larger than 2 MB are not rendered in the diff surface.

## License

No license has been selected yet. Add a license before distributing the project or accepting external contributions.
