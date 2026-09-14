import { afterEach, describe, expect, test } from 'bun:test'

import { loadRecentFiles, NO_RECENT_FILES, rememberRecentFile, saveRecentFiles } from './recentFiles'

afterEach(() => localStorage.clear())

describe('recentFiles', () => {
  test('keeps the newest first, deduplicated, capped at 20', () => {
    let files = NO_RECENT_FILES
    for (let index = 0; index < 25; index += 1) files = rememberRecentFile(files, `src/file-${index}.ts`)
    files = rememberRecentFile(files, 'src/file-20.ts')

    expect(files).toHaveLength(20)
    expect(files[0]).toBe('src/file-20.ts')
    expect(files.filter((path) => path === 'src/file-20.ts')).toHaveLength(1)
    expect(files).not.toContain('src/file-0.ts')
  })

  test('returns the same array when the newest file is opened again', () => {
    const files = rememberRecentFile(NO_RECENT_FILES, 'src/app.ts')

    expect(rememberRecentFile(files, 'src/app.ts')).toBe(files)
  })

  test('round-trips per root and never leaks between roots', () => {
    saveRecentFiles('/one', ['src/a.ts'])
    saveRecentFiles('/two', ['src/b.ts'])

    expect(loadRecentFiles('/one')).toEqual(['src/a.ts'])
    expect(loadRecentFiles('/two')).toEqual(['src/b.ts'])
    expect(loadRecentFiles('/three')).toBe(NO_RECENT_FILES)
  })

  test('ignores stored junk', () => {
    localStorage.setItem('kodi:recent-files:v1:/repo', '{"nope":true}')
    expect(loadRecentFiles('/repo')).toBe(NO_RECENT_FILES)

    localStorage.setItem('kodi:recent-files:v1:/repo', '[1,"src/a.ts",null]')
    expect(loadRecentFiles('/repo')).toEqual(['src/a.ts'])
  })
})
