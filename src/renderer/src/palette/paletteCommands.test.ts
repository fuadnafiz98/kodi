import { describe, expect, test } from 'bun:test'

import {
  groupPaletteEntries,
  nextPaletteIndex,
  paletteScore,
  rankPaletteEntries,
  type PaletteEntry
} from './paletteCommands'

function entry(id: string, title: string, subtitle = '', group: PaletteEntry['group'] = 'Commands'): PaletteEntry {
  return { id, group, title, subtitle }
}

const COMMANDS: PaletteEntry[] = [
  entry('wrap', 'Toggle word wrap', 'Wrap or scroll long code lines.'),
  entry('sidebar', 'Toggle explorer', 'Show or hide the file explorer.'),
  entry('settings', 'Open settings', 'Appearance, editor, and keybindings.'),
  entry('folder', 'Open folder', 'Search recent folders or open the macOS picker.'),
  entry('fold', 'Toggle context folding', 'Fold or expand unchanged diff regions.')
]

describe('paletteScore', () => {
  test('a prefix beats a word start beats a mid-word substring', () => {
    const prefix = paletteScore('Open settings', 'open')
    const wordStart = paletteScore('Toggle word wrap', 'word')
    const midWord = paletteScore('Toggle explorer', 'plore')
    expect(prefix).not.toBeNull()
    expect(prefix!).toBeLessThan(wordStart!)
    expect(wordStart!).toBeLessThan(midWord!)
  })

  test('falls back to a subsequence, and rejects what does not match at all', () => {
    expect(paletteScore('Toggle word wrap', 'twp')).not.toBeNull()
    expect(paletteScore('Toggle word wrap', 'zzz')).toBeNull()
  })

  test('an empty query matches everything at the same score', () => {
    expect(paletteScore('anything', '')).toBe(0)
  })
})

describe('rankPaletteEntries', () => {
  test('typing part of a label finds the command', () => {
    expect(rankPaletteEntries(COMMANDS, 'wrap')[0]?.id).toBe('wrap')
  })

  test('a title hit outranks a subtitle hit for the same word', () => {
    const ranked = rankPaletteEntries(
      [entry('doc', 'Reload window', 'Fold or expand unchanged diff regions.'), entry('fold', 'Toggle context folding', '')],
      'fold'
    )
    expect(ranked.map((result) => result.id)).toEqual(['fold', 'doc'])
  })

  test('among two title hits the earlier word start wins', () => {
    expect(rankPaletteEntries(COMMANDS, 'fold').map((result) => result.id)).toEqual(['folder', 'fold'])
  })

  test('matches only on the description still surface', () => {
    expect(rankPaletteEntries(COMMANDS, 'macos').map((result) => result.id)).toEqual(['folder'])
  })

  test('an empty query keeps the declared order', () => {
    expect(rankPaletteEntries(COMMANDS, '').map((result) => result.id))
      .toEqual(['wrap', 'sidebar', 'settings', 'folder', 'fold'])
  })

  test('honours the row limit', () => {
    expect(rankPaletteEntries(COMMANDS, '', 2)).toHaveLength(2)
  })
})

describe('groupPaletteEntries', () => {
  test('keeps run order and merges adjacent groups', () => {
    const grouped = groupPaletteEntries([
      entry('a', 'A'),
      entry('b', 'B'),
      { ...entry('c', 'C'), group: 'Files' },
      { ...entry('d', 'D'), group: 'Branches' }
    ])
    expect(grouped.map((group) => [group.group, group.entries.length]))
      .toEqual([['Commands', 2], ['Files', 1], ['Branches', 1]])
  })
})

describe('nextPaletteIndex', () => {
  test('wraps in both directions', () => {
    expect(nextPaletteIndex(0, -1, 3)).toBe(2)
    expect(nextPaletteIndex(2, 1, 3)).toBe(0)
    expect(nextPaletteIndex(0, 1, 0)).toBe(0)
  })
})
