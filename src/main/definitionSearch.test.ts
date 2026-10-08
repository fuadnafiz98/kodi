import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { definitionClassifier, findDefinitions, isSearchableIdentifier, rankDefinitions } from './definitionSearch.js'

const { rgPath } = createRequire(import.meta.url)('@vscode/ripgrep') as { rgPath: string }

describe('definitionClassifier', () => {
  test('TypeScript declarations, never a call site', () => {
    const classify = definitionClassifier('parseFileUri')
    expect(classify('a.ts', 'export function parseFileUri(uri: string) {')).toEqual({ kind: 'function', strength: 100 })
    expect(classify('a.ts', 'export async function parseFileUri() {')?.kind).toBe('function')
    expect(classify('a.ts', 'const parseFileUri = (uri) => uri')?.kind).toBe('variable')
    expect(classify('a.ts', 'const parsed = parseFileUri(x)')).toBeNull()
    expect(classify('a.ts', 'function parseFileUriSafe() {}')).toBeNull()
    expect(definitionClassifier('Guide')('a.tsx', 'export class Guide extends Base {')?.kind).toBe('class')
    expect(definitionClassifier('Guide')('a.ts', 'export interface Guide {')?.kind).toBe('interface')
  })

  test('Python, Go, Rust and shell', () => {
    expect(definitionClassifier('parse')('a.py', '    def parse(self, uri):')?.kind).toBe('function')
    expect(definitionClassifier('parse')('a.py', 'value = parse(uri)')).toBeNull()
    expect(definitionClassifier('LIMIT')('a.py', 'LIMIT: int = 4')?.kind).toBe('variable')
    expect(definitionClassifier('LIMIT')('a.py', 'if LIMIT == 4:')).toBeNull()
    expect(definitionClassifier('Parse')('a.go', 'func (p *Parser) Parse(uri string) error {')?.kind).toBe('function')
    expect(definitionClassifier('Parse')('a.go', '\treturn p.Parse(uri)')).toBeNull()
    expect(definitionClassifier('parse')('a.rs', 'pub(crate) async fn parse(uri: &str) {')?.kind).toBe('function')
    expect(definitionClassifier('build')('a.sh', 'build() {')?.kind).toBe('function')
  })

  test('identifiers with $ match exactly', () => {
    const classify = definitionClassifier('$state')
    expect(classify('a.ts', 'const $state = 1')?.kind).toBe('variable')
    expect(classify('a.ts', 'const $stateful = 1')).toBeNull()
  })
})

test('isSearchableIdentifier rejects keywords, punctuation and long names', () => {
  expect(isSearchableIdentifier('parseFileUri')).toBe(true)
  expect(isSearchableIdentifier('$el')).toBe(true)
  expect(isSearchableIdentifier('return')).toBe(false)
  expect(isSearchableIdentifier('a.b')).toBe(false)
  expect(isSearchableIdentifier('1abc')).toBe(false)
  expect(isSearchableIdentifier('a'.repeat(129))).toBe(false)
})

test('rankDefinitions prefers the same file, then the same folder', () => {
  const ranked = rankDefinitions('load', 'src/app.ts', [
    { path: 'lib/load.ts', line: 1, text: 'export function load() {}' },
    { path: 'src/other.ts', line: 2, text: 'export function load() {}' },
    { path: 'src/app.ts', line: 9, text: 'const load = () => 1' },
    { path: 'src/app.ts', line: 3, text: 'load()' }
  ])
  expect(ranked.map((candidate) => `${candidate.path}:${candidate.line}`)).toEqual(['src/app.ts:9', 'src/other.ts:2', 'lib/load.ts:1'])
})

test('findDefinitions searches the working tree with ripgrep', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kodi-definitions-'))
  try {
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules/x'), { recursive: true })
    await writeFile(join(root, 'src/parse.ts'), '// Parses.\n\nexport function parseFileUri(uri: string) {\n  return uri\n}\n')
    await writeFile(join(root, 'src/app.ts'), "import { parseFileUri } from './parse'\nexport const x = parseFileUri('a')\n")
    await writeFile(join(root, 'node_modules/x/index.ts'), 'export function parseFileUri() {}\n')
    await writeFile(join(root, 'notes.py'), 'def parseFileUri():\n    pass\n')
    const found = await findDefinitions({ root, identifier: 'parseFileUri', fromPath: 'src/app.ts', ripgrep: rgPath })
    expect(found).toEqual([{ path: 'src/parse.ts', line: 3, kind: 'function', preview: 'export function parseFileUri(uri: string) {' }])
    expect(await findDefinitions({ root, identifier: 'export', fromPath: 'src/app.ts', ripgrep: rgPath })).toEqual([])
    expect(await findDefinitions({ root, identifier: 'parseFileUri', fromPath: 'README', ripgrep: rgPath })).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
