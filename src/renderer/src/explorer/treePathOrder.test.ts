import { describe, expect, test } from 'bun:test'
import { prepareFileTreeInput } from '@pierre/trees'

import { compareTreePaths, firstTreePath } from './treePathOrder'

const DIRECTORIES = ['app', 'App', 'src', 'src/nested', 'src/nested/deep', 'lib', '.github', 'zz_last', 'a-b', 'a_b']
const NAMES = ['index', 'Index', 'page2', 'page10', 'page1', 'README', 'package', '01-first', '10-tenth', 'z']
const EXTENSIONS = ['.ts', '.tsx', '.md', '.json', '.css']

/** 200 paths chosen to hit every branch: case folding, digit runs, mixed depth. */
function fixturePaths(): string[] {
  const unique = new Set<string>()
  for (const directory of DIRECTORIES) {
    for (const name of NAMES) {
      for (const extension of EXTENSIONS) {
        unique.add(`${directory}/${name}${extension}`)
        unique.add(`${name}${extension}`)
      }
    }
  }
  // A stride that is coprime with the set size interleaves the depths, so the
  // input order never resembles the answer.
  const all = [...unique]
  return Array.from({ length: 200 }, (_value, index) => all[(index * 137) % all.length]!)
    .filter((path, index, list) => list.indexOf(path) === index)
}

describe('firstTreePath', () => {
  test('picks the folders-first file, not the byte-sorted path', () => {
    expect(firstTreePath([
      'apps/web/src/chat/ChatMessageItem.tsx',
      'apps/web/src/chat/PromptAttachmentControls.tsx',
      'apps/web/src/chat/attachment-preview/AttachmentPreviewChips.tsx'
    ])).toBe('apps/web/src/chat/attachment-preview/AttachmentPreviewChips.tsx')
  })

  test('returns null for an empty list and the only entry for a single path', () => {
    expect(firstTreePath([])).toBeNull()
    expect(firstTreePath(['README.md'])).toBe('README.md')
  })

  test('matches the tree widget on a 200-path fixture', () => {
    const paths = fixturePaths()
    expect(paths.length).toBe(200)
    expect(firstTreePath(paths)).toBe(prepareFileTreeInput(paths).paths[0] ?? null)
  })

  test('matches the tree widget on every rotation of the fixture', () => {
    const paths = fixturePaths()
    for (let offset = 0; offset < paths.length; offset += 17) {
      const rotated = [...paths.slice(offset), ...paths.slice(0, offset)]
      expect(firstTreePath(rotated)).toBe(prepareFileTreeInput(rotated).paths[0] ?? null)
    }
  })
})

describe('compareTreePaths', () => {
  test('sorts a fixture exactly like the tree widget', () => {
    const paths = fixturePaths()
    expect([...paths].sort(compareTreePaths)).toEqual([...prepareFileTreeInput(paths).paths])
  })

  test('orders directories before files and digits naturally', () => {
    expect(compareTreePaths('src/a.ts', 'index.ts')).toBeLessThan(0)
    expect(compareTreePaths('src/page2.tsx', 'src/page10.tsx')).toBeLessThan(0)
    expect(compareTreePaths('package.json', 'README.md')).toBeLessThan(0)
    expect(compareTreePaths('src/a.ts', 'src/a.ts')).toBe(0)
  })
})
