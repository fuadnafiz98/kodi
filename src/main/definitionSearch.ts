import { spawn as spawnChild } from 'node:child_process'
import { dirname, extname } from 'node:path'

import type { DefinitionCandidate } from '../shared/contracts.js'
import { EXCLUDED_DIRECTORIES } from './ignoredListing.js'

/**
 * "Where is this defined?" without a language server: ripgrep finds the
 * identifier as a whole word in files of the clicked file's language, and a
 * conservative per-language pattern keeps only lines that declare it. A call
 * site never matches; a declaration the patterns do not know is simply missed.
 */

export const MAX_DEFINITION_CANDIDATES = 12
const SEARCH_TIMEOUT_MS = 1_500
const SEARCH_OUTPUT_LIMIT = 256 * 1024

interface DefinitionPattern {
  kind: DefinitionCandidate['kind']
  strength: number
  /** `NAME` stands for the escaped identifier. */
  source: string
}

interface LanguageGroup {
  extensions: readonly string[]
  patterns: readonly DefinitionPattern[]
}

const C_FAMILY: readonly DefinitionPattern[] = [
  { kind: 'class', strength: 100, source: String.raw`\b(?:class|interface|enum|struct|record|typedef)\s+NAME\b` },
  { kind: 'function', strength: 70, source: String.raw`^\s*(?:[\w:<>,*&\[\]]+\s+)+\**NAME\s*\(` }
]

const LANGUAGES: readonly LanguageGroup[] = [
  {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
    patterns: [
      { kind: 'function', strength: 100, source: String.raw`\b(?:async\s+)?function\s*\*?\s*NAME\b` },
      { kind: 'class', strength: 100, source: String.raw`\bclass\s+NAME\b` },
      { kind: 'interface', strength: 100, source: String.raw`\binterface\s+NAME\b` },
      { kind: 'type', strength: 95, source: String.raw`\b(?:type|enum|namespace)\s+NAME\b` },
      { kind: 'variable', strength: 85, source: String.raw`\b(?:const|let|var)\s+NAME\b` }
    ]
  },
  {
    extensions: ['.py', '.pyi'],
    patterns: [
      { kind: 'function', strength: 100, source: String.raw`^\s*(?:async\s+)?def\s+NAME\b` },
      { kind: 'class', strength: 100, source: String.raw`^\s*class\s+NAME\b` },
      { kind: 'variable', strength: 80, source: String.raw`^\s*NAME\s*(?::[^=]+)?=(?!=)` }
    ]
  },
  {
    extensions: ['.go'],
    patterns: [
      { kind: 'function', strength: 100, source: String.raw`^\s*func\s+(?:\([^)]*\)\s*)?NAME\b` },
      { kind: 'type', strength: 90, source: String.raw`^\s*(?:type|var|const)\s+NAME\b` }
    ]
  },
  {
    extensions: ['.rs'],
    patterns: [
      { kind: 'function', strength: 100, source: String.raw`^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+NAME\b` },
      { kind: 'type', strength: 95, source: String.raw`^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|type|mod|const|static)\s+NAME\b` },
      { kind: 'function', strength: 100, source: String.raw`^\s*macro_rules!\s+NAME\b` }
    ]
  },
  {
    extensions: ['.rb'],
    patterns: [
      { kind: 'function', strength: 100, source: String.raw`^\s*def\s+(?:self\.)?NAME\b` },
      { kind: 'class', strength: 95, source: String.raw`^\s*(?:class|module)\s+NAME\b` }
    ]
  },
  {
    extensions: ['.swift'],
    patterns: [
      { kind: 'function', strength: 100, source: String.raw`\bfunc\s+NAME\b` },
      { kind: 'type', strength: 90, source: String.raw`\b(?:class|struct|enum|protocol|typealias|let|var)\s+NAME\b` }
    ]
  },
  {
    extensions: ['.kt', '.kts'],
    patterns: [
      { kind: 'function', strength: 100, source: String.raw`\bfun\s+(?:[\w.<>]+\.)?NAME\b` },
      { kind: 'type', strength: 90, source: String.raw`\b(?:class|interface|object|typealias|val|var)\s+NAME\b` }
    ]
  },
  {
    extensions: ['.php'],
    patterns: [
      { kind: 'function', strength: 100, source: String.raw`\bfunction\s+NAME\b` },
      { kind: 'class', strength: 95, source: String.raw`\b(?:class|interface|trait|enum)\s+NAME\b` }
    ]
  },
  {
    extensions: ['.sh', '.bash', '.zsh'],
    patterns: [{ kind: 'function', strength: 100, source: String.raw`^\s*(?:function\s+)?NAME\s*\(\)` }]
  },
  {
    extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.m', '.mm', '.java', '.cs', '.scala'],
    patterns: C_FAMILY
  }
]

const IDENTIFIER = /^[$_\p{ID_Start}][$\p{ID_Continue}]*$/u
const KEYWORDS = new Set([
  'abstract', 'and', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def',
  'default', 'defer', 'delete', 'do', 'elif', 'else', 'enum', 'export', 'extends', 'false', 'final', 'finally',
  'fn', 'for', 'from', 'func', 'function', 'go', 'if', 'impl', 'implements', 'import', 'in', 'instanceof',
  'interface', 'is', 'let', 'match', 'mod', 'module', 'mut', 'new', 'nil', 'none', 'None', 'not', 'null', 'or',
  'package', 'pass', 'private', 'protected', 'pub', 'public', 'return', 'self', 'static', 'struct', 'super',
  'switch', 'this', 'throw', 'trait', 'true', 'True', 'False', 'try', 'type', 'typeof', 'undefined', 'use',
  'var', 'void', 'while', 'with', 'yield'
])

export function isSearchableIdentifier(identifier: string): boolean {
  return identifier.length <= 128 && IDENTIFIER.test(identifier) && !KEYWORDS.has(identifier)
}

export function languageFor(path: string): LanguageGroup | null {
  const extension = extname(path).toLowerCase()
  return LANGUAGES.find((group) => group.extensions.includes(extension)) ?? null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type DefinitionClassifier = (path: string, text: string) => { kind: DefinitionCandidate['kind']; strength: number } | null

export function definitionClassifier(identifier: string): DefinitionClassifier {
  const name = escapeRegExp(identifier)
  // `\b` before `$name` never matches, so a name that starts or ends outside
  // \w gets explicit edges.
  const compiled = new Map<LanguageGroup, Array<{ kind: DefinitionCandidate['kind']; strength: number; pattern: RegExp }>>()
  return (path, text) => {
    const group = languageFor(path)
    if (group == null) return null
    let patterns = compiled.get(group)
    if (patterns == null) {
      patterns = group.patterns.map(({ kind, strength, source }) => ({
        kind,
        strength,
        pattern: new RegExp(source.replaceAll(String.raw`NAME\b`, () => `${name}(?![$\\w])`).replaceAll('NAME', () => name), 'u')
      }))
      compiled.set(group, patterns)
    }
    for (const { kind, strength, pattern } of patterns) if (pattern.test(text)) return { kind, strength }
    return null
  }
}

export interface DefinitionMatch {
  path: string
  line: number
  text: string
}

export function rankDefinitions(identifier: string, fromPath: string, matches: readonly DefinitionMatch[]): DefinitionCandidate[] {
  const classify = definitionClassifier(identifier)
  const fromDirectory = dirname(fromPath)
  const ranked: Array<DefinitionCandidate & { score: number }> = []
  for (const match of matches) {
    const found = classify(match.path, match.text)
    if (found == null) continue
    const score = found.strength + (match.path === fromPath ? 25 : 0) + (dirname(match.path) === fromDirectory ? 10 : 0)
    ranked.push({ path: match.path, line: match.line, kind: found.kind, preview: match.text.trim().slice(0, 200), score })
  }
  ranked.sort((first, second) => second.score - first.score || first.path.localeCompare(second.path) || first.line - second.line)
  return ranked.slice(0, MAX_DEFINITION_CANDIDATES).map(({ score: _score, ...candidate }) => candidate)
}

export interface FindDefinitionsOptions {
  root: string
  identifier: string
  fromPath: string
  ripgrep: string
  spawn?: typeof spawnChild
  timeoutMs?: number
}

export async function findDefinitions(options: FindDefinitionsOptions): Promise<DefinitionCandidate[]> {
  const { root, identifier, fromPath, ripgrep } = options
  if (!isSearchableIdentifier(identifier)) return []
  const group = languageFor(fromPath)
  if (group == null) return []
  const globs = group.extensions.flatMap((extension) => ['-g', `*${extension}`])
  const exclusions = EXCLUDED_DIRECTORIES.flatMap((directory) => ['-g', `!${directory}/`])
  const matches = await new Promise<DefinitionMatch[]>((resolve) => {
    const child = (options.spawn ?? spawnChild)(ripgrep, [
      '--json', '-w', '-F', '--max-count', '20', '--max-filesize', '1M', '--max-columns', '400',
      '--threads', '2', ...globs, ...exclusions, '--', identifier, '.'
    ], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] })
    const found: DefinitionMatch[] = []
    let pending = ''
    let bytes = 0
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(found)
    }
    const timer = setTimeout(finish, options.timeoutMs ?? SEARCH_TIMEOUT_MS)
    const take = (line: string): void => {
      if (line === '') return
      try {
        const event = JSON.parse(line) as { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } }
        if (event.type !== 'match' || event.data?.path?.text == null || event.data.lines?.text == null) return
        found.push({ path: event.data.path.text.replace(/^\.\//, ''), line: event.data.line_number ?? 1, text: event.data.lines.text.replace(/\r?\n$/, '') })
      } catch {
        // A record cut by the kill.
      }
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      bytes += chunk.length
      pending += chunk
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) take(line)
      if (bytes >= SEARCH_OUTPUT_LIMIT) finish()
    })
    child.on('error', finish)
    child.on('close', () => {
      take(pending)
      finish()
    })
  })
  return rankDefinitions(identifier, fromPath, matches)
}
