import { spawn } from 'node:child_process'

export interface EditorTarget {
  /** Absolute path of the file. */
  file: string
  line: number | null
  /** Absolute path of the repository. */
  repo: string
}

export interface EditorCommand {
  executable: string
  args: string[]
}

export type RunEditorCommand = (command: EditorCommand, timeoutMs: number) => Promise<boolean>

// How long a command has to fail. One still running then has opened the file
// and is left to run: `code --wait`, `subl -w` and `emacsclient` block until
// the file is closed, and killing them (or falling back) opened it twice.
const EDITOR_SETTLE_MS = 1_500

/** Splits a command line on whitespace, keeping single- and double-quoted runs together. No shell. */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let started = false
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (quote != null) {
      if (character === quote) quote = null
      else if (character === '\\' && quote === '"' && (command[index + 1] === '"' || command[index + 1] === '\\')) {
        current += command[index + 1]
        index += 1
      } else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      started = true
      continue
    }
    if (/\s/.test(character)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += character
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/**
 * The user's `editorCommand` with `{file}`, `{line}` and `{repo}` filled in;
 * the file is appended when the command never names it. Null when empty.
 */
export function customEditorCommand(template: string, target: EditorTarget): EditorCommand | null {
  const tokens = tokenizeCommand(template.trim())
  if (tokens.length === 0) return null
  const line = target.line == null ? '' : String(target.line)
  const names = tokens.some((token) => token.includes('{file}'))
  const filled = tokens.map((token) => token
    .replaceAll('{file}', target.file)
    // `{file}:{line}` with no line reads `file:`; drop the dangling colon.
    .replaceAll(':{line}', line === '' ? '' : `:${line}`)
    .replaceAll('{line}', line)
    .replaceAll('{repo}', target.repo))
  const [executable, ...args] = names ? filled : [...filled, target.file]
  return executable == null || executable === '' ? null : { executable, args }
}

/** VS Code when the preference is empty: Homebrew's and the installer's `code`, then by name, then macOS. */
export function defaultEditorCommands(target: EditorTarget): EditorCommand[] {
  const location = target.line == null ? target.file : `${target.file}:${target.line}`
  return [
    { executable: '/opt/homebrew/bin/code', args: ['-g', location] },
    { executable: '/usr/local/bin/code', args: ['-g', location] },
    { executable: 'code', args: ['-g', location] },
    { executable: 'open', args: ['-a', 'Visual Studio Code', target.file] },
    { executable: 'open', args: ['-t', target.file] }
  ]
}

export function editorCommands(template: string, target: EditorTarget): EditorCommand[] {
  const custom = customEditorCommand(template, target)
  return custom == null ? defaultEditorCommands(target) : [custom]
}

export const runDetached: RunEditorCommand = (command, settleMs) => new Promise((resolveRun) => {
  let settled = false
  const settle = (opened: boolean): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolveRun(opened)
  }
  const child = spawn(command.executable, command.args, { detached: true, stdio: 'ignore', windowsHide: true })
  const timer = setTimeout(() => {
    child.unref()
    settle(true)
  }, settleMs)
  child.once('error', () => settle(false))
  child.once('exit', (code) => settle(code === 0))
})

/**
 * Opens the file in the reader's editor: their command, or the VS Code chain,
 * the first that exits 0, or is still running once it had time to fail, wins. Returns false when none did, so the caller can
 * fall back to the system's default app.
 */
export async function openInEditor(
  template: string,
  target: EditorTarget,
  run: RunEditorCommand = runDetached
): Promise<boolean> {
  for (const command of editorCommands(template, target)) {
    if (await run(command, EDITOR_SETTLE_MS)) return true
  }
  return false
}
