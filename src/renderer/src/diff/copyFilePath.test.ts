import { describe, expect, test } from 'bun:test'

import { fileContentsToCopy, syncCopyFilePathLifecycle } from './copyFilePath'

describe('copy file path', () => {
  test('copies a review header path with one click and removes the listener on unmount', async () => {
    const copiedText: string[] = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { copiedText.push(text) } }
    })

    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'open' })
    const title = document.createElement('span')
    title.setAttribute('data-title', '')
    title.textContent = 'src/example.ts'
    root.append(title)

    const reports: Array<[string, boolean]> = []
    syncCopyFilePathLifecycle(host, 'mount', (path, copied) => reports.push([path, copied]))
    title.click()
    await Promise.resolve()
    await Promise.resolve()

    expect(copiedText).toEqual(['src/example.ts'])
    expect(reports).toEqual([['src/example.ts', true]])

    syncCopyFilePathLifecycle(host, 'unmount', () => undefined)
    title.click()
    await Promise.resolve()
    await Promise.resolve()
    expect(copiedText).toEqual(['src/example.ts'])
  })

  test('prefers the working file and refuses binary or oversized contents', () => {
    expect(fileContentsToCopy({
      newFile: { name: 'a.ts', contents: 'working\n', cacheKey: 'n' },
      oldFile: { name: 'a.ts', contents: 'head\n', cacheKey: 'o' },
      binary: false,
      oversized: false
    })).toBe('working\n')
    expect(fileContentsToCopy({
      newFile: null,
      oldFile: { name: 'gone.ts', contents: 'deleted\n', cacheKey: 'o' },
      binary: false,
      oversized: false
    })).toBe('deleted\n')
    expect(fileContentsToCopy({
      newFile: { name: 'a.bin', contents: '', cacheKey: 'n' },
      oldFile: null,
      binary: true,
      oversized: false
    })).toBeNull()
    expect(fileContentsToCopy({
      newFile: { name: 'a.ts', contents: 'too big', cacheKey: 'n' },
      oldFile: null,
      binary: false,
      oversized: true
    })).toBeNull()
  })
})
