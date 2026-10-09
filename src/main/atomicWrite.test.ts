import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { quarantineFile, writeFileAtomic, writeFileAtomicSync } from './atomicWrite.js'

// Every folder a test makes is removed after it.
const directories: string[] = []

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'kodi-atomic-'))
  directories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('writeFileAtomic', () => {
  it('leaves the file and no temp behind when the write was superseded', async () => {
    const base = await directory()
    const path = join(base, 'state.json')
    await writeFile(path, '{"generation":1}', 'utf8')
    await writeFileAtomic(path, '{"generation":2}', () => false)
    expect(await readFile(path, 'utf8')).toBe('{"generation":1}')
    expect(await readdir(base)).toEqual(['state.json'])
  })

  it('replaces the previous contents', async () => {
    const base = await directory()
    const path = join(base, 'state.json')
    await writeFile(path, '{"generation":1}', 'utf8')
    await writeFileAtomic(path, '{"generation":2}')
    expect(await readFile(path, 'utf8')).toBe('{"generation":2}')
  })

  it('leaves no temp file behind on success', async () => {
    const base = await directory()
    await writeFileAtomic(join(base, 'state.json'), '{}')
    expect((await readdir(base)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps the previous file and cleans up when the write cannot land', async () => {
    const base = await directory()
    const path = join(base, 'nested', 'state.json')
    await expect(writeFileAtomic(path, '{}')).rejects.toThrow()
    expect((await readdir(base)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('serializes an interleaved pair so the last write wins whole', async () => {
    const base = await directory()
    const path = join(base, 'state.json')
    await Promise.all([writeFileAtomic(path, 'a'.repeat(4096)), writeFileAtomic(path, 'b'.repeat(4096))])
    const contents = await readFile(path, 'utf8')
    // Whichever finished last, the file is one write's bytes and never a mix.
    expect(contents === 'a'.repeat(4096) || contents === 'b'.repeat(4096)).toBe(true)
  })
})

describe('writeFileAtomicSync', () => {
  it('replaces the previous contents', async () => {
    const base = await directory()
    const path = join(base, 'window.json')
    await writeFile(path, '{"width":100}', 'utf8')
    writeFileAtomicSync(path, '{"width":200}')
    expect(readFileSync(path, 'utf8')).toBe('{"width":200}')
  })

  it('throws and cleans up when the target directory does not exist', async () => {
    const base = await directory()
    expect(() => writeFileAtomicSync(join(base, 'nested', 'window.json'), '{}')).toThrow()
    expect((await readdir(base)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('quarantineFile', () => {
  it('moves the unparseable file aside and keeps its bytes', async () => {
    const base = await directory()
    const path = join(base, 'state.json')
    await writeFile(path, 'not json', 'utf8')
    const moved = quarantineFile(path, 1_700_000_000_000)
    expect(moved).toBe(`${path}.corrupt-1700000000000`)
    expect(readFileSync(moved!, 'utf8')).toBe('not json')
  })

  it('reports null rather than throwing when there is nothing to move', async () => {
    const base = await directory()
    expect(quarantineFile(join(base, 'missing.json'))).toBeNull()
  })
})
