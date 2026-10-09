import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { collectFolderCandidates, resolveOpenableFolder } from './folderIndex.js'

// Every folder a test makes is removed after it.
const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function makeGitRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
  await mkdir(join(path, '.git'))
}

describe('collectFolderCandidates', () => {
  test('indexes Developer children and nested git repos', async () => {
    const home = await temporaryDirectory('kodi-folders-')
    const developer = join(home, 'Developer')
    await makeGitRepo(join(developer, 'personal', 'echo'))
    await makeGitRepo(join(developer, 'vibes', 'echo'))
    await makeGitRepo(join(developer, 'vibes', 'echo-old'))
    await mkdir(join(developer, 'vibes', 'echo', 'node_modules', 'left-pad'), { recursive: true })

    const folders = await collectFolderCandidates(home)
    const displayPaths = folders.map((folder) => folder.displayPath)

    expect(displayPaths).toContain('~/Developer/personal')
    expect(displayPaths).toContain('~/Developer/personal/echo')
    expect(displayPaths).toContain('~/Developer/vibes/echo-old')
    expect(folders.some((folder) => folder.path.includes('node_modules'))).toBe(false)
  })

  test('includes previously opened folders outside the default scan roots', async () => {
    const home = await temporaryDirectory('kodi-folders-')
    const extra = join(home, 'Documents', 'notes')
    await mkdir(extra, { recursive: true })

    const folders = await collectFolderCandidates(home, [extra])
    expect(folders.map((folder) => folder.path)).toContain(await realpath(extra))
  })

  // The children of one directory are resolved in a single concurrent round.
  // A wide directory is where that either keeps every candidate or quietly
  // drops one, so it is the shape worth pinning down.
  test('indexes every child of a wide directory exactly once', async () => {
    const home = await temporaryDirectory('kodi-folders-wide-')
    const group = join(home, 'Developer', 'group')
    const names = Array.from({ length: 24 }, (_, index) => `repo-${String(index).padStart(2, '0')}`)
    await Promise.all(names.map((name) => makeGitRepo(join(group, name))))
    await mkdir(join(group, 'node_modules', 'left-pad'), { recursive: true })
    await mkdir(join(group, '.hidden'), { recursive: true })
    await writeFile(join(group, 'notes.txt'), 'hi')

    const folders = await collectFolderCandidates(home)
    const displayPaths = folders.map((folder) => folder.displayPath)

    expect(displayPaths).toContain('~/Developer/group')
    for (const name of names) expect(displayPaths).toContain(`~/Developer/group/${name}`)
    expect(new Set(displayPaths).size).toBe(displayPaths.length)
    expect(displayPaths).toEqual(displayPaths.toSorted((left, right) => left.localeCompare(right)))
    expect(displayPaths.some((path) => path.includes('node_modules'))).toBe(false)
    expect(displayPaths.some((path) => path.includes('.hidden'))).toBe(false)
    expect(displayPaths.some((path) => path.includes('notes.txt'))).toBe(false)
  })

  test('resolves remembered roots and default scan roots in the same round', async () => {
    const home = await temporaryDirectory('kodi-folders-extra-')
    const echo = join(home, 'Developer', 'echo')
    await makeGitRepo(echo)
    const notes = join(home, 'Documents', 'notes')
    await mkdir(notes, { recursive: true })
    const file = join(home, 'Documents', 'todo.txt')
    await writeFile(file, 'hi')

    const folders = await collectFolderCandidates(home, [notes, join(home, 'Documents', 'gone'), file])
    const paths = folders.map((folder) => folder.path)

    expect(paths).toContain(await realpath(notes))
    expect(paths).toContain(await realpath(echo))
    expect(paths.some((path) => path.endsWith('todo.txt'))).toBe(false)
    expect(paths.some((path) => path.endsWith('gone'))).toBe(false)
  })
})

describe('resolveOpenableFolder', () => {
  test('accepts a folder under a default scan root', async () => {
    const home = await temporaryDirectory('kodi-open-')
    const folder = join(home, 'Developer', 'echo')
    await mkdir(folder, { recursive: true })

    expect(await resolveOpenableFolder(folder, { home, approvedRoots: [] })).toBe(await realpath(folder))
  })

  test('rejects an unapproved folder that is not under a scan root', async () => {
    const home = await temporaryDirectory('kodi-open-')
    const folder = join(home, 'Downloads', 'echo')
    await mkdir(folder, { recursive: true })

    await expect(resolveOpenableFolder(folder, { home, approvedRoots: [] }))
      .rejects.toThrow('Use Existing')
  })

  test('accepts an approved folder outside home', async () => {
    const home = await temporaryDirectory('kodi-home-')
    const approved = await temporaryDirectory('kodi-approved-')

    expect(await resolveOpenableFolder(approved, { home, approvedRoots: [approved] })).toBe(await realpath(approved))
  })

  test('rejects the home directory itself and unapproved outside paths', async () => {
    const home = await temporaryDirectory('kodi-home-')
    const outside = await temporaryDirectory('kodi-outside-')
    const file = join(home, 'readme.txt')
    await writeFile(file, 'hi')

    await expect(resolveOpenableFolder(home, { home, approvedRoots: [] }))
      .rejects.toThrow('project folder')
    await expect(resolveOpenableFolder(outside, { home, approvedRoots: [] }))
      .rejects.toThrow('Use Existing')
    await expect(resolveOpenableFolder(file, { home, approvedRoots: [] }))
      .rejects.toThrow('not a file')
    await expect(resolveOpenableFolder('relative/path', { home, approvedRoots: [] }))
      .rejects.toThrow('absolute')
  })
})
