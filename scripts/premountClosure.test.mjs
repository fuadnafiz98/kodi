import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closureChunksInGroup,
  entryChunkFromHtml,
  measurePremountClosure,
  staticImportsOf
} from './premountClosure.mjs'

const directories = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function renderDirectory(chunks) {
  const directory = await mkdtemp(join(tmpdir(), 'kodi-premount-'))
  directories.push(directory)
  await mkdir(join(directory, 'assets'))
  await writeFile(
    join(directory, 'index.html'),
    '<!doctype html><script type="module" crossorigin src="./assets/index-aaa.js"></script>'
  )
  for (const [name, source] of Object.entries(chunks)) {
    await writeFile(join(directory, 'assets', name), source)
  }
  return directory
}

describe('entryChunkFromHtml', () => {
  test('reads the module entry out of the generated html', () => {
    expect(entryChunkFromHtml('<script type="module" crossorigin src="./assets/index-Xy1.js"></script>'))
      .toBe('index-Xy1.js')
    expect(entryChunkFromHtml('<link rel="modulepreload" href="./assets/boot-a.js">')).toBeNull()
  })
})

describe('staticImportsOf', () => {
  test('follows static edges and ignores dynamic ones', () => {
    const source = 'import"./side-effect.js";import{a}from"./a.js";const p=import("./lazy.js");export{a}from"./b.js"'
    expect(staticImportsOf(source).sort()).toEqual(['a.js', 'b.js', 'side-effect.js'])
  })

  test('does not mistake a property access for an import', () => {
    expect(staticImportsOf('x.import"./nope.js"')).toEqual([])
  })
})

describe('measurePremountClosure', () => {
  test('sums the entry, boot and viewer roots with their static closure', async () => {
    const directory = await renderDirectory({
      'index-aaa.js': 'const p=import("./boot-bbb.js")',
      'boot-bbb.js': `import{x}from"./shared-ccc.js";${'/*b*/'.repeat(10)}`,
      'shared-ccc.js': 'export const x=1',
      'WorkspaceRoot-ddd.js': 'import"./shared-ccc.js"',
      'DiffSurface-eee.js': 'export const d=1',
      'MultiFileReview-fff.js': 'export const m=1',
      // Reachable only through a dynamic import: deferred, so out of the budget.
      'GitHubMarkdownRenderer-ggg.js': 'export const g=1'
    })

    const closure = await measurePremountClosure(directory)
    const names = closure.largest.map((chunk) => chunk.name).sort()

    expect(closure.entry).toBe('index-aaa.js')
    expect(names).toEqual([
      'DiffSurface-eee.js',
      'MultiFileReview-fff.js',
      'WorkspaceRoot-ddd.js',
      'boot-bbb.js',
      'index-aaa.js',
      'shared-ccc.js'
    ])
    expect(closure.bootChunks).toEqual(['boot-bbb.js'])
    expect(closure.chunkCount).toBe(6)
    expect(closure.largest[0]?.name).toBe('boot-bbb.js')
  })

  test('measures the entry on its own, so a vendor chunk in front of boot is visible', async () => {
    const directory = await renderDirectory({
      'index-aaa.js': 'import"./vite-preload-iii.js";const p=import("./boot-bbb.js")',
      'vite-preload-iii.js': 'export const _=1',
      'boot-bbb.js': 'import"./vendor-jjj.js"',
      'vendor-jjj.js': `export const v=1;${'/*pad*/'.repeat(50)}`
    })

    const closure = await measurePremountClosure(directory)

    expect(closure.entryClosure.largest.map((chunk) => chunk.name).sort())
      .toEqual(['index-aaa.js', 'vite-preload-iii.js'])
    expect(closure.entryClosure.totalBytes).toBeLessThan(closure.totalBytes)
    expect(closure.largest.map((chunk) => chunk.name)).toContain('vendor-jjj.js')
  })

  test('counts a shared chunk once and survives a missing chunk', async () => {
    const directory = await renderDirectory({
      'index-aaa.js': 'export const i=1',
      'boot-bbb.js': 'import"./shared-ccc.js";import"./gone-hhh.js"',
      'shared-ccc.js': 'export const x=1',
      'WorkspaceRoot-ddd.js': 'import"./shared-ccc.js"'
    })

    const closure = await measurePremountClosure(directory)

    expect(closure.chunkCount).toBe(4)
    expect(closure.largest.filter((chunk) => chunk.name === 'shared-ccc.js').length).toBe(1)
  })

  test('throws when the html has no entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kodi-premount-'))
    directories.push(directory)
    await mkdir(join(directory, 'assets'))
    await writeFile(join(directory, 'index.html'), '<!doctype html>')

    expect(measurePremountClosure(directory)).rejects.toThrow('Cannot find the renderer entry chunk')
  })
})

describe('closureChunksInGroup', () => {
  test('names the pre-mount chunks of a group that stopped being lazy', async () => {
    const directory = await renderDirectory({
      'index-aaa.js': 'const p=import("./boot-bbb.js")',
      'boot-bbb.js': 'import"./vendor-shiki-Ab-Cd12.js"',
      // Hashes contain hyphens, so the group cannot be read off the last segment.
      'vendor-shiki-Ab-Cd12.js': 'export const s=1'
    })

    expect(closureChunksInGroup(await measurePremountClosure(directory), 'vendor-shiki', ['vendor-shiki-langs']))
      .toEqual(['vendor-shiki-Ab-Cd12.js'])
  })

  test('leaves a sibling group that shares the prefix out of the answer', async () => {
    const directory = await renderDirectory({
      'index-aaa.js': 'const p=import("./boot-bbb.js")',
      'boot-bbb.js': 'import"./vendor-shiki-langs-lll.js";const s=import("./vendor-shiki-kkk.js")',
      'vendor-shiki-langs-lll.js': 'export const l=1',
      'vendor-shiki-kkk.js': 'export const s=1'
    })
    const closure = await measurePremountClosure(directory)

    expect(closureChunksInGroup(closure, 'vendor-shiki', ['vendor-shiki-langs'])).toEqual([])
    expect(closureChunksInGroup(closure, 'vendor-shiki-langs')).toEqual(['vendor-shiki-langs-lll.js'])
  })
})
