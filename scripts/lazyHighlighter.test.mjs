import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The renderer keeps shiki's tokenizer engine — 143 KB of textmate and oniguruma
// that only the worker and an attached editor ever run — off the boot path by
// rewriting two vendored modules at build time (`kodi:lazy-highlighter-engine`
// and `kodi:lazy-theme-normalizer` in electron.vite.config.ts). Both rewrites
// are anchored on exact source text, so a dependency bump that moves the text
// fails the build with no hint about which upgrade caused it. Asserting the same
// anchors here names the cause at `bun test` time instead.
const REWRITES = [
  {
    plugin: 'kodi:lazy-highlighter-engine',
    module: 'node_modules/@pierre/diffs/dist/highlighter/shared_highlighter.js',
    // The rewrite moves this import inside the function below it, which is only
    // legal while that function is async.
    staticImport: 'import { createHighlighter, createJavaScriptRegexEngine, createOnigurumaEngine } from "shiki";',
    asyncSite: 'async function getSharedHighlighter({ themes, langs, preferredHighlighter = "shiki-js" }) {',
    engineCall: 'createHighlighter({'
  },
  {
    plugin: 'kodi:lazy-theme-normalizer',
    module: 'node_modules/@pierre/theming/dist/modules/createTheme.js',
    staticImport: 'import { normalizeTheme } from "shiki/core";',
    asyncSite: 'return async () => {',
    engineCall: 'return normalizeTheme(unwrapDefault(await loader()));'
  }
]

const configuration = readFileSync(resolve(import.meta.dir, '..', 'electron.vite.config.ts'), 'utf8')

describe.each(REWRITES)('$plugin', (rewrite) => {
  const vendored = readFileSync(resolve(import.meta.dir, '..', rewrite.module), 'utf8')

  test('rewrites a module that still imports the engine statically', () => {
    expect(vendored).toContain(rewrite.staticImport)
  })

  test('rewrites a call site that is still inside an async function', () => {
    const asyncSite = vendored.indexOf(rewrite.asyncSite)
    expect(asyncSite).toBeGreaterThan(-1)
    expect(vendored.indexOf(rewrite.engineCall)).toBeGreaterThan(asyncSite)
  })

  test('is still declared with those anchors in the renderer build', () => {
    expect(configuration).toContain(rewrite.plugin)
    expect(configuration).toContain(rewrite.staticImport)
  })
})

test('the diff worker keeps its own eager copy of the engine', () => {
  // Both plugins are renderer-only: `worker.plugins` lists the build's shiki
  // plugins explicitly, and adding these two there would put a chunk fetch in
  // front of the first tokenised line.
  const workerPlugins = configuration.slice(configuration.indexOf('worker: {'))
  expect(workerPlugins).toContain('dropShikiWasmPlugin()')
  expect(workerPlugins).not.toContain('lazyHighlighterEnginePlugin()')
  expect(workerPlugins).not.toContain('lazyThemeNormalizerPlugin()')
})
