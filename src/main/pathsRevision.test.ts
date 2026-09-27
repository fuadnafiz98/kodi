import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HeldPathCache, heldPathList, omitHeldPaths } from '../shared/heldPaths.js'
import { runCommand } from './gitCommands.js'
import { RepositoryService } from './repository.js'

async function git(root: string, ...args: string[]): Promise<void> {
  await runCommand('git', ['-C', root, ...args])
}

async function openFixture(): Promise<{ root: string; repository: RepositoryService }> {
  const root = await mkdtemp(join(tmpdir(), 'kodi-paths-revision-'))
  await git(root, '-c', 'init.defaultBranch=main', 'init', '--quiet')
  await git(root, 'config', 'user.name', 'Kodi Test')
  await git(root, 'config', 'user.email', 'test@example.invalid')
  await git(root, 'config', 'commit.gpgsign', 'false')
  await git(root, 'config', 'core.hooksPath', join(root, '.no-hooks'))
  await writeFile(join(root, 'kept.ts'), 'one\n', 'utf8')
  await git(root, 'add', '--all')
  await git(root, 'commit', '--quiet', '-m', 'init')
  const repository = new RepositoryService()
  await repository.open(root)
  return { root, repository }
}

describe('path revisions', () => {
  it('keeps the revision while the list is unchanged and moves it when a file appears', async () => {
    const { root, repository } = await openFixture()
    try {
      const opened = await repository.refresh()
      expect(opened.pathsRevision).toBeNumber()

      await writeFile(join(root, 'kept.ts'), 'two\n', 'utf8')
      const edited = await repository.refresh()
      expect(edited.paths).toBe(opened.paths)
      expect(edited.pathsRevision).toBe(opened.pathsRevision)

      const staged = await repository.stagePaths(['kept.ts'])
      expect(staged.pathsRevision).toBe(opened.pathsRevision)

      await writeFile(join(root, 'scratch.ts'), 'temp\n', 'utf8')
      const grown = await repository.refresh()
      expect(grown.paths).toContain('scratch.ts')
      expect(grown.pathsRevision).toBeGreaterThan(opened.pathsRevision!)

      const discarded = await repository.discardPaths(['scratch.ts'])
      expect(discarded.paths).not.toContain('scratch.ts')
      expect(discarded.pathsRevision).toBeGreaterThan(grown.pathsRevision!)
    } finally {
      repository.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never reuses a revision in a second session of the same root', async () => {
    const { root, repository } = await openFixture()
    const reopened = new RepositoryService()
    try {
      const first = await repository.refresh()
      await reopened.open(root)
      const second = await reopened.refresh()
      expect(second.paths).toEqual(first.paths)
      expect(second.pathsRevision).not.toBe(first.pathsRevision)
    } finally {
      repository.dispose()
      reopened.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers a repeat stage without the path list and a discard that removed a file with it', async () => {
    const { root, repository } = await openFixture()
    const preload = new HeldPathCache()
    const reply = async (mutation: Promise<Awaited<ReturnType<RepositoryService['stagePaths']>>>) => {
      const claim = preload.claim()
      const sent = omitHeldPaths(await mutation, heldPathList(claim))
      return { sentPaths: sent.paths != null, snapshot: preload.complete(sent, claim) }
    }
    try {
      await writeFile(join(root, 'kept.ts'), 'two\n', 'utf8')
      await writeFile(join(root, 'scratch.ts'), 'temp\n', 'utf8')
      await repository.refresh()

      const first = await reply(repository.stagePaths(['kept.ts']))
      expect(first.sentPaths).toBe(true)

      const repeat = await reply(repository.unstagePaths(['kept.ts']))
      expect(repeat.sentPaths).toBe(false)
      expect(repeat.snapshot.paths).toEqual(['kept.ts', 'scratch.ts'])

      const discarded = await reply(repository.discardPaths(['scratch.ts']))
      expect(discarded.sentPaths).toBe(true)
      expect(discarded.snapshot.paths).toEqual(['kept.ts'])
    } finally {
      repository.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})
