import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { detectRepositoryKind, listRootSnapshot, resolveExistingRoot, rootsMatch } from './workspaceListing.js'

describe('workspaceListing', () => {
  it('lists three levels of files and skips generated directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-listing-'))
    try {
      await mkdir(join(root, 'src', 'nested', 'too-deep'), { recursive: true })
      await mkdir(join(root, '.github', 'workflows'), { recursive: true })
      await writeFile(join(root, 'README.md'), '# hi\n', 'utf8')
      await writeFile(join(root, 'src', 'a.ts'), 'export {}\n', 'utf8')
      await writeFile(join(root, 'src', 'nested', 'b.ts'), 'export {}\n', 'utf8')
      await writeFile(join(root, 'src', 'nested', 'too-deep', 'c.ts'), 'export {}\n', 'utf8')
      await writeFile(join(root, '.github', 'workflows', 'ci.yml'), 'name: ci\n', 'utf8')
      await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
      await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}\n', 'utf8')
      await mkdir(join(root, '.venv', 'bin'), { recursive: true })
      await writeFile(join(root, '.venv', 'bin', 'python'), '#!\n', 'utf8')
      // Go repositories track `vendor/`, and the git snapshot lists it, so the
      // listing has to as well or the tree changes shape when git answers.
      await mkdir(join(root, 'vendor', 'pkg'), { recursive: true })
      await writeFile(join(root, 'vendor', 'pkg', 'lib.go'), 'package pkg\n', 'utf8')

      const snapshot = listRootSnapshot(root)
      expect(snapshot.name).toBe(basename(root))
      expect(snapshot.kind).toBe('folder')
      expect(snapshot.stage).toBe('skeleton')
      // Dot-directories that are not generated output are real project content.
      expect(new Set(snapshot.paths)).toEqual(new Set([
        'README.md',
        '.github/workflows/ci.yml',
        'src/a.ts',
        'src/nested/b.ts',
        'vendor/pkg/lib.go'
      ]))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stops at the path cap, top of the tree first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-listing-cap-'))
    try {
      await mkdir(join(root, 'deep'))
      await writeFile(join(root, 'top.txt'), 'top\n', 'utf8')
      for (let index = 0; index < 10; index += 1) {
        await writeFile(join(root, 'deep', `file-${index}.txt`), 'x\n', 'utf8')
      }

      expect(listRootSnapshot(root, 1).paths).toEqual(['top.txt'])
      expect(listRootSnapshot(root, 4).paths).toHaveLength(4)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('treats a missing folder as unusable', () => {
    expect(resolveExistingRoot('/definitely-missing-kodi-folder')).toBeNull()
    expect(rootsMatch('/a', '/b')).toBe(false)
  })

  it('upgrades a cached folder listing to git when .git is present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kodi-listing-git-'))
    try {
      await mkdir(join(root, '.git'))
      await writeFile(join(root, 'Makefile'), 'all:\n', 'utf8')
      expect(detectRepositoryKind(root)).toBe('git')
      expect(listRootSnapshot(root).kind).toBe('git')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
