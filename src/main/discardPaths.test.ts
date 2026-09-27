import { describe, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs/promises'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { mapWithConcurrency, runCommand } from './gitCommands.js'
import { RepositoryService } from './repository.js'

const UNTRACKED_FILES = 2_000

async function git(root: string, ...args: string[]): Promise<void> {
  await runCommand('git', ['-C', root, ...args])
}

describe('discardPaths', () => {
  it('deletes thousands of untracked files with several unlinks in flight', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-discard-many-'))
    const repository = new RepositoryService()
    const realUnlink = fs.unlink
    let inFlight = 0
    let mostInFlight = 0
    const unlink = spyOn(fs, 'unlink').mockImplementation(async (path) => {
      inFlight += 1
      mostInFlight = Math.max(mostInFlight, inFlight)
      try {
        await realUnlink(path)
      } finally {
        inFlight -= 1
      }
    })
    try {
      await git(root, '-c', 'init.defaultBranch=main', 'init', '--quiet')
      await git(root, 'config', 'user.name', 'Kodi Test')
      await git(root, 'config', 'user.email', 'test@example.invalid')
      await git(root, 'config', 'commit.gpgsign', 'false')
      await writeFile(join(root, 'kept.ts'), 'one\n', 'utf8')
      await git(root, 'add', '--all')
      await git(root, 'commit', '--quiet', '-m', 'init')
      await mkdir(join(root, 'scratch'))
      const scratch = Array.from({ length: UNTRACKED_FILES }, (_, index) => `scratch/file-${index}.txt`)
      await mapWithConcurrency(scratch, 32, (path) => writeFile(join(root, path), 'temp\n', 'utf8'))
      await repository.open(root)
      await repository.refresh()

      const snapshot = await repository.discardPaths(scratch)

      expect(unlink).toHaveBeenCalledTimes(UNTRACKED_FILES)
      expect(mostInFlight).toBeGreaterThan(1)
      expect(snapshot.statuses).toEqual([])
      expect(snapshot.paths).toEqual(['kept.ts'])
      expect(await readdir(join(root, 'scratch'))).toEqual([])
    } finally {
      unlink.mockRestore()
      repository.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
