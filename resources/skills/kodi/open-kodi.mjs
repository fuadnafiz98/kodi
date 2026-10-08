#!/usr/bin/env node
// Opens Kodi on a review guide an agent wrote:
//
//   node open-kodi.mjs --file <guide.json> [target] [folder]
//
// `target` is a commit ref (the working tree when omitted). The Claude Code
// session (CLAUDE_SESSION_ID) is forwarded so its last messages travel with
// the guide. Kodi checks the guide against the live diff when it opens it.
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
let file = null
const positionals = []
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]
  if (argument === '--file') file = args[++index] ?? null
  else if (argument.startsWith('--file=')) file = argument.slice('--file='.length)
  else if (argument === '-h' || argument === '--help') {
    console.log('usage: node open-kodi.mjs --file <guide.json> [target] [folder]')
    process.exit(0)
  } else positionals.push(argument)
}
if (file == null || !existsSync(file) || !statSync(file).isFile()) {
  console.error(`open-kodi: no guide file${file == null ? '' : `: ${file}`}`)
  process.exit(2)
}

// A lone positional is a folder when it is one, otherwise a commit ref.
let [target, folder] = positionals
if (folder == null && target != null && existsSync(target) && statSync(target).isDirectory()) {
  folder = target
  target = undefined
}

const candidates = [
  'kodi',
  join(homedir(), 'Applications', 'Kodi.app', 'Contents', 'Resources', 'kodi'),
  '/Applications/Kodi.app/Contents/Resources/kodi'
]
const cli = candidates.find((candidate) =>
  candidate === 'kodi' ? spawnSync('which', ['kodi']).status === 0 : existsSync(candidate))
if (cli == null) {
  console.error('open-kodi: Kodi is not installed (no `kodi` on PATH or in ~/Applications).')
  process.exit(1)
}

const session = process.env.CLAUDE_SESSION_ID
const cliArgs = [
  '--guide-file', resolve(file),
  ...(session != null && /^[0-9a-f-]{36}$/i.test(session) ? ['--claude-session', session] : []),
  ...(target == null ? [] : [target]),
  folder ?? process.cwd()
]
const result = spawnSync(cli, cliArgs, { stdio: 'inherit' })
process.exit(result.status ?? 1)
